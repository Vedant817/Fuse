import { randomUUID } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BreakerStore,
  PreflightStore,
  StoreUnavailableError,
  runMigrations,
} from '@fuse/breaker-store';
import { buildApp } from './app.js';
import type { ControlPlaneConfig } from './config.js';
import { DetectorPolicyResolver } from './policy-loader.js';

const OPERATOR_TOKEN = 'operator-'.padEnd(32, '0');
const AGENT_TOKEN = 'agent-'.padEnd(32, '0');
const WEBHOOK_TOKEN = 'webhook-'.padEnd(32, '0');

const CONFIG: ControlPlaneConfig = {
  port: 0,
  host: '127.0.0.1',
  logLevel: 'silent',
  deploymentEnvironment: 'test',
  databaseUrl: '',
  dbPoolMax: 10,
  dbPoolIdleTimeoutMs: 30_000,
  dbPoolConnectionTimeoutMs: 2_000,
  dbStatementTimeoutMs: 5_000,
  maxRegisteredScopesPerTenant: 10_000,
  rateLimitMax: 120,
  rateLimitWindowMs: 60_000,
  storeOutageMode: 'fail-closed',
  apiTokens: [OPERATOR_TOKEN],
  agentApiTokens: [AGENT_TOKEN],
  exporterEvidenceTokens: [],
  webhookTokens: [WEBHOOK_TOKEN],
  webhookDefaultPolicyVersion: 'signoz-webhook-v1',
  webhookDefaultCooldownSeconds: 300,
  webhookMaxAlertAgeMs: 600_000,
  webhookMaxClockSkewAheadMs: 60_000,
  preflightWindowMs: 5 * 60_000,
  preflightBlindCoverageThreshold: 0.5,
  preflightBlindOrphanRateThreshold: 0.5,
  preflightBlindTokenMissingRateThreshold: 0.3,
  preflightHeartbeatGraceMs: 2 * 60_000,
  preflightMaxEvidenceStalenessMs: 5 * 60_000,
  preflightMinRecoveryDwellMs: 60_000,
};

class FailableDirectTripStore extends BreakerStore {
  failNextDetectorTrip = false;
  private nextRecordReadGate:
    { observed: () => void; released: Promise<void> } | undefined;

  pauseNextRecordRead(): { observed: Promise<void>; release: () => void } {
    let markObserved!: () => void;
    let release!: () => void;
    const observed = new Promise<void>((resolve) => {
      markObserved = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextRecordReadGate = { observed: markObserved, released };
    return { observed, release };
  }

  override async getRecord(...args: Parameters<BreakerStore['getRecord']>) {
    const record = await super.getRecord(...args);
    const gate = this.nextRecordReadGate;
    if (gate) {
      this.nextRecordReadGate = undefined;
      gate.observed();
      await gate.released;
    }
    return record;
  }

  override trip(...args: Parameters<BreakerStore['trip']>) {
    if (this.failNextDetectorTrip && args[0].actor.id.startsWith('system:detector:')) {
      this.failNextDetectorTrip = false;
      return Promise.reject(new StoreUnavailableError('injected direct-trip outage'));
    }
    return super.trip(...args);
  }
}

describe('SigNoz alert webhook (real Postgres + control plane)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let replicaPool: pg.Pool;
  let app: FastifyInstance;
  let replica: FastifyInstance;
  let store: FailableDirectTripStore;
  const registeredAgentIds: string[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    replicaPool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool);
    store = new FailableDirectTripStore(pool);
    for (let index = 0; index < 50; index++) {
      const agentId = `agent-registered-${index}-${randomUUID().slice(0, 8)}`;
      await store.registerScope({
        scope: { tenant: 't1', environment: 'test', agentId },
        policyVersion: 'test-v1',
        actor: { type: 'system', id: 'test:setup' },
        reason: 'integration test registration',
        correlationId: `setup-${index}`,
      });
      registeredAgentIds.push(agentId);
    }
    const preflightStore = new PreflightStore(pool);
    const detectorPolicyResolver = new DetectorPolicyResolver([
      {
        policyVersion: 'effective-scope-policy-v7',
        scope: { tenant: '*', environment: '*', agentId: '*' },
        cooldownSeconds: 47,
        storeOutageMode: 'fail-closed',
        controlPlaneOutageMode: 'fail-closed',
        detectors: {},
        notificationRoutes: ['slack'],
      },
    ]);
    app = await buildApp({
      store,
      preflightStore,
      pool,
      config: CONFIG,
      detectorPolicyResolver,
    });
    replica = await buildApp({
      store: new BreakerStore(replicaPool),
      preflightStore: new PreflightStore(replicaPool),
      pool: replicaPool,
      config: CONFIG,
      detectorPolicyResolver,
    });
    await app.ready();
    await replica.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await replica.close();
    await pool.end();
    await replicaPool.end();
    await container.stop();
  });

  function firingAlert(
    overrides: Record<string, unknown> = {},
    alertOverrides: Record<string, unknown> = {},
  ) {
    return {
      status: 'firing',
      alerts: [
        {
          status: 'firing',
          labels: {
            fuse_tenant: 't1',
            fuse_environment: 'test',
            fuse_agent_id:
              registeredAgentIds.pop() ??
              (() => {
                throw new Error('registered webhook scope pool exhausted');
              })(),
            fuse_detector: 'loop-signature',
            fuse_source_epoch: '0',
          },
          annotations: { summary: 'loop detected' },
          startsAt: new Date().toISOString(),
          fingerprint: randomUUID(),
          ...alertOverrides,
        },
      ],
      ...overrides,
    };
  }

  function registeredAgentId(): string {
    const agentId = registeredAgentIds.pop();
    if (!agentId) throw new Error('registered webhook scope pool exhausted');
    return agentId;
  }

  async function durableEvidence(agentId: string) {
    const { rows } = await pool.query<{
      transitions: string;
      diagnosis_jobs: string;
    }>(
      `SELECT
         count(DISTINCT a.id) FILTER (
           WHERE a.from_state='armed' AND a.to_state='tripped' AND NOT a.noop
         )::text AS transitions,
         count(DISTINCT j.audit_event_id)::text AS diagnosis_jobs
       FROM breaker_audit_log a
       LEFT JOIN diagnosis_jobs j ON j.audit_event_id=a.id
       WHERE a.tenant='t1' AND a.environment='test' AND a.agent_id=$1`,
      [agentId],
    );
    return {
      transitions: Number(rows[0]!.transitions),
      diagnosisJobs: Number(rows[0]!.diagnosis_jobs),
    };
  }

  it('an agent token gets 403 on the webhook route (not a silent pass)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: firingAlert(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('unauthorized');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      payload: firingAlert(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('an epoch-bound alert trips as fallback while state remains at its source epoch', async () => {
    const payload = firingAlert();
    const agentId = (payload.alerts[0]!.labels as Record<string, string>)[
      'fuse_agent_id'
    ]!;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ outcome: 'tripped' });

    expect(
      await store.getRecord({ tenant: 't1', environment: 'test', agentId }),
    ).toMatchObject({ state: 'tripped', epoch: 1 });

    const statusRes = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=t1&environment=test&agentId=${agentId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    const record = statusRes.json().record as {
      policyVersion: string;
      updatedAt: string;
      cooldownUntil: string;
    };
    expect(record.policyVersion).toBe('effective-scope-policy-v7');
    expect(Date.parse(record.cooldownUntil) - Date.parse(record.updatedAt)).toBe(47_000);
  });

  it('falls back to the epoch-bound alert when the direct commit fails and epoch stays unchanged', async () => {
    const agentId = registeredAgentId();
    const scope = { tenant: 't1', environment: 'test', agentId };
    const now = Date.now();
    const steps = Array.from({ length: 8 }, (_, index) => ({
      executionId: 'direct-failure-execution',
      timestampMs: now - (8 - index) * 100,
      canonicalShape: index % 2 === 0 ? 'analyzer:unchanged' : 'verifier:needs-revision',
      inputTokens: 100,
      outputTokens: 20,
      pricingStatus: 'available',
      estimatedCostUsd: 0.001,
    }));

    store.failNextDetectorTrip = true;
    const direct = await app.inject({
      method: 'POST',
      url: '/v1/detectors/observe',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { scope, steps },
    });
    expect(direct.statusCode).toBe(503);

    const unchanged = await store.getRecord(scope);
    expect(unchanged).toMatchObject({ state: 'armed', epoch: 0 });

    const fallback = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: firingAlert(
        {},
        {
          labels: {
            fuse_tenant: 't1',
            fuse_environment: 'test',
            fuse_agent_id: agentId,
            fuse_detector: 'loop-signature',
            fuse_source_epoch: '0',
          },
        },
      ),
    });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.json().results[0].outcome).toBe('tripped');
    expect(await store.getRecord(scope)).toMatchObject({ state: 'tripped', epoch: 1 });
  });

  it('does not let a delayed source-epoch alert undo a later authorized resume, but a new epoch trips', async () => {
    const agentId = registeredAgentId();
    const scope = { tenant: 't1', environment: 'test', agentId };
    const oldAlertStartsAt = new Date(Date.now() - 1_000).toISOString();
    const now = Date.now();
    const steps = Array.from({ length: 8 }, (_, index) => ({
      executionId: 'resume-epoch-execution',
      timestampMs: now - (8 - index) * 100,
      canonicalShape: index % 2 === 0 ? 'analyzer:unchanged' : 'verifier:needs-revision',
      inputTokens: 100,
      outputTokens: 20,
      pricingStatus: 'available',
      estimatedCostUsd: 0.001,
    }));

    const direct = await app.inject({
      method: 'POST',
      url: '/v1/detectors/observe',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { scope, steps },
    });
    expect(direct.statusCode).toBe(200);
    expect(direct.json().enforcement).toContainEqual({
      detector: 'loop-signature',
      outcome: 'tripped',
    });

    const trippedStatus = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=t1&environment=test&agentId=${agentId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    const trippedEpoch = trippedStatus.json().record.epoch as number;
    expect(trippedStatus.json().record.updatedBy.id).toBe(
      'system:detector:loop-signature',
    );

    const resume = await app.inject({
      method: 'POST',
      url: '/v1/breaker/resume',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: {
        scope,
        reason: 'authorized recovery after direct enforcement',
        actor: { type: 'manual', id: 'operator:test' },
        expectedEpoch: trippedEpoch,
        correlationId: `resume-${randomUUID()}`,
        idempotencyKey: `resume-${randomUUID()}`,
      },
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().record.state).toBe('armed');
    const resumedRecord = resume.json().record as { epoch: number; updatedAt: string };
    expect(resumedRecord.epoch).toBe(trippedEpoch + 1);

    const oldAlert = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: firingAlert(
        {},
        {
          labels: {
            fuse_tenant: 't1',
            fuse_environment: 'test',
            fuse_agent_id: agentId,
            fuse_detector: 'loop-signature',
            fuse_source_epoch: '0',
          },
          startsAt: oldAlertStartsAt,
        },
      ),
    });
    expect(oldAlert.statusCode).toBe(200);
    expect(oldAlert.json().results[0].outcome).toBe('stale-epoch');

    const stillArmed = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=t1&environment=test&agentId=${agentId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(stillArmed.json().record).toMatchObject({
      state: 'armed',
      epoch: resumedRecord.epoch,
    });

    const newAlertStartsAt = new Date(
      Math.max(Date.now(), Date.parse(resumedRecord.updatedAt) + 1),
    ).toISOString();
    const newAlert = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: firingAlert(
        {},
        {
          labels: {
            fuse_tenant: 't1',
            fuse_environment: 'test',
            fuse_agent_id: agentId,
            fuse_detector: 'loop-signature',
            fuse_source_epoch: String(resumedRecord.epoch),
          },
          startsAt: newAlertStartsAt,
        },
      ),
    });
    expect(newAlert.statusCode).toBe(200);
    expect(newAlert.json().results[0].outcome).toBe('tripped');

    const finallyTripped = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=t1&environment=test&agentId=${agentId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(finallyTripped.json().record).toMatchObject({
      state: 'tripped',
      epoch: resumedRecord.epoch + 1,
      updatedBy: { id: 'system:signoz-webhook:loop-signature' },
    });
  });

  it('an operator token (superset) can also call the webhook route', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: firingAlert(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a malformed payload with 400 invalid_request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: { status: 'firing', alerts: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('an alert whose labels do not resolve to a known scope is reported unknown-scope, not a crash', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: {
        status: 'firing',
        alerts: [
          {
            status: 'firing',
            labels: { alertname: 'SomeUnrelatedAlert' },
            annotations: {},
            startsAt: new Date().toISOString(),
            fingerprint: randomUUID(),
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ outcome: 'unknown-scope' });
  });

  it('a resolved alert never auto-resumes — observed only, no state change', async () => {
    const agentId = registeredAgentId();
    const fingerprint = randomUUID();
    const startsAt = new Date().toISOString();

    // First: firing, trips the breaker.
    await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: {
        status: 'firing',
        alerts: [
          {
            status: 'firing',
            labels: {
              fuse_tenant: 't1',
              fuse_environment: 'test',
              fuse_agent_id: agentId,
              fuse_source_epoch: '0',
            },
            annotations: {},
            startsAt,
            fingerprint,
          },
        ],
      },
    });

    // Then: the same alert resolves.
    const resolvedRes = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: {
        status: 'resolved',
        alerts: [
          {
            status: 'resolved',
            labels: {
              fuse_tenant: 't1',
              fuse_environment: 'test',
              fuse_agent_id: agentId,
            },
            annotations: {},
            startsAt,
            endsAt: new Date().toISOString(),
            fingerprint,
          },
        ],
      },
    });
    expect(resolvedRes.statusCode).toBe(200);
    expect(resolvedRes.json().results[0]).toMatchObject({ outcome: 'resolved-observed' });

    // The breaker must still be tripped — resolution alone never resumes it.
    const statusRes = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=t1&environment=test&agentId=${agentId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(statusRes.json().record.state).toBe('tripped');
  });

  it('duplicate delivery of the same alert (same fingerprint+startsAt) is idempotent — no double transition', async () => {
    const agentId = registeredAgentId();
    const payload = {
      status: 'firing',
      alerts: [
        {
          status: 'firing',
          labels: {
            fuse_tenant: 't1',
            fuse_environment: 'test',
            fuse_agent_id: agentId,
            fuse_source_epoch: '0',
          },
          annotations: {},
          startsAt: new Date().toISOString(),
          fingerprint: randomUUID(),
        },
      ],
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload,
    });
    // Idempotency replay returns the *original* outcome verbatim — both
    // deliveries report "tripped" (the first delivery's real outcome),
    // not a fresh re-evaluation of current state. The load-bearing
    // assertion is that only one real transition ever happened (epoch),
    // which distinguishes this from silently double-tripping.
    expect(first.json().results[0]).toMatchObject({ outcome: 'tripped' });
    expect(second.json().results).toEqual(first.json().results);

    const statusRes = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=t1&environment=test&agentId=${agentId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(statusRes.json().record.epoch).toBe(1); // exactly one real transition
  });

  it('concurrent identical delivery to two replicas commits one transition and one diagnosis job', async () => {
    const agentId = registeredAgentId();
    const payload = firingAlert(
      {},
      {
        labels: {
          fuse_tenant: 't1',
          fuse_environment: 'test',
          fuse_agent_id: agentId,
          fuse_detector: 'loop-signature',
          fuse_source_epoch: '0',
        },
      },
    );
    const request = (target: FastifyInstance) =>
      target.inject({
        method: 'POST',
        url: '/v1/webhooks/signoz',
        headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
        payload,
      });

    const [left, right] = await Promise.all([request(app), request(replica)]);
    expect(left.statusCode).toBe(200);
    expect(right.statusCode).toBe(200);
    expect(right.json().results).toEqual(left.json().results);
    expect(left.json().results[0]).toMatchObject({ outcome: 'tripped' });
    expect(await durableEvidence(agentId)).toEqual({
      transitions: 1,
      diagnosisJobs: 1,
    });

    const replay = await request(replica);
    expect(replay.json().results).toEqual(left.json().results);
    expect(await durableEvidence(agentId)).toEqual({
      transitions: 1,
      diagnosisJobs: 1,
    });
  });

  it('direct observation and SigNoz fallback racing from the same epoch commit one incident', async () => {
    const agentId = registeredAgentId();
    const scope = { tenant: 't1', environment: 'test', agentId };
    const now = Date.now();
    const steps = Array.from({ length: 8 }, (_, index) => ({
      executionId: 'race-execution',
      timestampMs: now - (8 - index) * 100,
      canonicalShape: index % 2 === 0 ? 'analyzer:unchanged' : 'verifier:needs-revision',
      inputTokens: 100,
      outputTokens: 20,
      pricingStatus: 'available',
      estimatedCostUsd: 0.001,
    }));
    const payload = firingAlert(
      {},
      {
        labels: {
          fuse_tenant: 't1',
          fuse_environment: 'test',
          fuse_agent_id: agentId,
          fuse_detector: 'loop-signature',
          fuse_source_epoch: '0',
        },
      },
    );

    const baselineGate = store.pauseNextRecordRead();
    const directPromise = app.inject({
      method: 'POST',
      url: '/v1/detectors/observe',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { scope, steps },
    });
    await baselineGate.observed;
    const fallbackPromise = replica.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload,
    });
    baselineGate.release();

    const [direct, fallback] = await Promise.all([directPromise, fallbackPromise]);
    expect([200, 409]).toContain(direct.statusCode);
    expect(fallback.statusCode).toBe(200);
    const fallbackOutcome = fallback.json().results[0].outcome as string;
    expect(['tripped', 'stale-epoch']).toContain(fallbackOutcome);
    expect(
      direct.statusCode === 200
        ? direct
            .json()
            .enforcement.some(
              (entry: { detector: string; outcome: string }) =>
                entry.detector === 'loop-signature' && entry.outcome === 'tripped',
            )
        : fallbackOutcome === 'tripped',
    ).toBe(true);
    expect(await store.getRecord(scope)).toMatchObject({ state: 'tripped', epoch: 1 });
    expect(await durableEvidence(agentId)).toEqual({
      transitions: 1,
      diagnosisJobs: 1,
    });

    const fallbackReplay = await replica.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload,
    });
    expect(fallbackReplay.json().results).toEqual(fallback.json().results);
    expect(await durableEvidence(agentId)).toEqual({
      transitions: 1,
      diagnosisJobs: 1,
    });
  });

  it('a delayed old epoch after resume and retrip leaves the later episode intact', async () => {
    const agentId = registeredAgentId();
    const scope = { tenant: 't1', environment: 'test', agentId };
    const firstPayload = firingAlert(
      {},
      {
        labels: {
          fuse_tenant: 't1',
          fuse_environment: 'test',
          fuse_agent_id: agentId,
          fuse_detector: 'loop-signature',
          fuse_source_epoch: '0',
        },
      },
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/webhooks/signoz',
          headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
          payload: firstPayload,
        })
      ).json().results[0].outcome,
    ).toBe('tripped');

    const resume = await store.resume({
      scope,
      reason: 'operator fixed the first episode',
      actor: { type: 'manual', id: 'operator:test' },
      expectedEpoch: 1,
      correlationId: `resume-${randomUUID()}`,
      idempotencyKey: `resume-${randomUUID()}`,
    });
    expect(resume).toMatchObject({ kind: 'applied', noop: false });

    const laterPayload = firingAlert(
      {},
      {
        labels: {
          fuse_tenant: 't1',
          fuse_environment: 'test',
          fuse_agent_id: agentId,
          fuse_detector: 'context-bloat',
          fuse_source_epoch: '2',
        },
      },
    );
    const later = await replica.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: laterPayload,
    });
    expect(later.json().results[0].outcome).toBe('tripped');
    const beforeOldDelivery = await durableEvidence(agentId);
    expect(beforeOldDelivery).toEqual({ transitions: 2, diagnosisJobs: 2 });

    const delayedOldPayload = firingAlert(
      {},
      {
        labels: {
          fuse_tenant: 't1',
          fuse_environment: 'test',
          fuse_agent_id: agentId,
          fuse_detector: 'loop-signature',
          fuse_source_epoch: '0',
        },
        startsAt: firstPayload.alerts[0]!.startsAt,
      },
    );
    const delayed = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: delayedOldPayload,
    });
    expect(delayed.json().results[0].outcome).toBe('stale-epoch');
    const replay = await replica.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: delayedOldPayload,
    });
    expect(replay.json().results).toEqual(delayed.json().results);
    expect(await store.getRecord(scope)).toMatchObject({
      state: 'tripped',
      epoch: 3,
      updatedBy: { id: 'system:signoz-webhook:context-bloat' },
    });
    expect(await durableEvidence(agentId)).toEqual(beforeOldDelivery);
  });

  it('processes a grouped delivery (multiple alerts, mixed firing/resolved) independently', async () => {
    const agentA = registeredAgentId();
    const agentB = registeredAgentId();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: {
        status: 'firing',
        alerts: [
          {
            status: 'firing',
            labels: {
              fuse_tenant: 't1',
              fuse_environment: 'test',
              fuse_agent_id: agentA,
              fuse_source_epoch: '0',
            },
            annotations: {},
            startsAt: new Date().toISOString(),
            fingerprint: randomUUID(),
          },
          {
            status: 'firing',
            labels: {
              fuse_tenant: 't1',
              fuse_environment: 'test',
              fuse_agent_id: agentB,
              fuse_source_epoch: '0',
            },
            annotations: {},
            startsAt: new Date().toISOString(),
            fingerprint: randomUUID(),
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const results = res.json().results as Array<{ outcome: string }>;
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.outcome === 'tripped')).toBe(true);
  });

  it('rejects an alert whose startsAt is older than the configured max age — outcome stale-alert, no trip', async () => {
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    const staleStartsAt = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago, config allows 10
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: firingAlert(
        {},
        {
          labels: {
            fuse_tenant: 't1',
            fuse_environment: 'test',
            fuse_agent_id: agentId,
            fuse_source_epoch: '0',
          },
          startsAt: staleStartsAt,
        },
      ),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].outcome).toBe('stale-alert');

    const statusRes = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=t1&environment=test&agentId=${agentId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(statusRes.statusCode).toBe(404); // unknown_scope — never actually tripped
  });

  it('rejects an alert whose startsAt claims to be further in the future than the clock-skew tolerance', async () => {
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    const futureStartsAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min ahead, config allows 1
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: firingAlert(
        {},
        {
          labels: {
            fuse_tenant: 't1',
            fuse_environment: 'test',
            fuse_agent_id: agentId,
            fuse_source_epoch: '0',
          },
          startsAt: futureStartsAt,
        },
      ),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].outcome).toBe('stale-alert');
  });

  it('rejects an alert with an unparseable startsAt (fail closed, not "assume fresh")', async () => {
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: firingAlert(
        {},
        {
          labels: {
            fuse_tenant: 't1',
            fuse_environment: 'test',
            fuse_agent_id: agentId,
            fuse_source_epoch: '0',
          },
          startsAt: 'not-a-real-timestamp',
        },
      ),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].outcome).toBe('stale-alert');
  });

  it('a distinct alert bound to an already-consumed epoch reports stale-epoch', async () => {
    const agentId = registeredAgentId();
    const labels = {
      fuse_tenant: 't1',
      fuse_environment: 'test',
      fuse_agent_id: agentId,
      fuse_source_epoch: '0',
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: firingAlert({}, { labels, startsAt: new Date().toISOString() }),
    });
    expect(first.json().results[0]).toMatchObject({ outcome: 'tripped' });

    // A second, distinct alert (different fingerprint/startsAt — not a
    // replay) for the same already-tripped scope.
    const second = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: firingAlert({}, { labels, startsAt: new Date().toISOString() }),
    });
    expect(second.json().results[0]).toMatchObject({ outcome: 'stale-epoch' });

    const statusRes = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=t1&environment=test&agentId=${agentId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(statusRes.json().record.state).toBe('tripped');
  });

  it('a disabled scope reports breaker-disabled on a fresh alert, not already-tripped, and stays disabled', async () => {
    const agentId = registeredAgentId();
    const scope = { tenant: 't1', environment: 'test', agentId };

    const disableRes = await app.inject({
      method: 'POST',
      url: '/v1/breaker/disable',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: {
        scope,
        reason: 'operator maintenance window',
        actor: { type: 'manual', id: 'operator:test' },
        correlationId: `disable-${randomUUID()}`,
        idempotencyKey: `disable-${randomUUID()}`,
        expectedEpoch: 0,
      },
    });
    expect(disableRes.json().record.state).toBe('disabled');
    const disabledEpoch = disableRes.json().record.epoch as number;

    const webhookRes = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: firingAlert(
        {},
        {
          labels: {
            fuse_tenant: 't1',
            fuse_environment: 'test',
            fuse_agent_id: agentId,
            fuse_source_epoch: String(disabledEpoch),
          },
          startsAt: new Date().toISOString(),
        },
      ),
    });
    expect(webhookRes.statusCode).toBe(200);
    expect(webhookRes.json().results[0]).toMatchObject({ outcome: 'breaker-disabled' });

    const statusRes = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=t1&environment=test&agentId=${agentId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(statusRes.json().record.state).toBe('disabled'); // never mutated by the webhook
  });

  it('accepts an alert comfortably within the freshness window', async () => {
    const agentId = registeredAgentId();
    const freshStartsAt = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: firingAlert(
        {},
        {
          labels: {
            fuse_tenant: 't1',
            fuse_environment: 'test',
            fuse_agent_id: agentId,
            fuse_source_epoch: '0',
          },
          startsAt: freshStartsAt,
        },
      ),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].outcome).toBe('tripped');
  });
});
