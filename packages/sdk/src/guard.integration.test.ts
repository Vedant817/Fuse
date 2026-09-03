import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@fuse/control-plane';
import { BreakerStore, PreflightStore, runMigrations } from '@fuse/breaker-store';
import type { Scope } from '@fuse/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FuseGuard } from './guard.js';
import { BreakerTrippedError } from './errors.js';
import { callFakeProvider, startFakeProvider, type FakeProvider } from './testing.js';

const API_TOKEN = 'sdk-integration-test-token-0123456789';
const EXPORTER_TOKEN = 'sdk-exporter-test-token-0123456789';
const POLICY_VERSION = 'demo-hardcoded-threshold-v1';
const execFileAsync = promisify(execFile);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setContainerPaused(containerId: string, paused: boolean): Promise<void> {
  await execFileAsync('docker', [paused ? 'pause' : 'unpause', containerId]);
}

/**
 * This is the load-bearing proof for Fuse's central product claim: once a
 * trip is committed, the middleware prevents the next model-provider
 * request from being dispatched. Every request in this file goes over a
 * real HTTP connection (control plane on a real listening port, fake
 * provider on a real listening port) — nothing here is an in-process
 * function-call count standing in for network behavior.
 */
describe('FuseGuard end-to-end: dispatch-counter proof against a real HTTP control plane', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let controlPlane: FastifyInstance;
  let controlPlaneUrl: string;
  let fakeProvider: FakeProvider;
  const registeredScopes: Scope[] = [];
  // node-postgres emits 'error' on idle clients whose backend the server
  // terminates; without a listener that is an uncaught exception. Record
  // mid-test errors so the suite still fails loudly, but stop recording at
  // teardown where container SIGTERM (57P01) after pool.end() is benign.
  let tearingDownPool = false;
  const poolErrors: unknown[] = [];

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
    pool.on('error', (err) => {
      if (!tearingDownPool) poolErrors.push(err);
    });
    await runMigrations(pool);
    const store = new BreakerStore(pool);
    for (let index = 0; index < 20; index++) {
      const scope: Scope = {
        tenant: 't1',
        environment: 'test',
        agentId: `agent-registered-${index}-${randomUUID().slice(0, 8)}`,
      };
      await store.registerScope({
        scope,
        policyVersion: POLICY_VERSION,
        actor: { type: 'system', id: 'test:setup' },
        reason: 'integration test registration',
        correlationId: `setup-${index}`,
      });
      registeredScopes.push(scope);
    }
    const preflightStore = new PreflightStore(pool);
    controlPlane = await buildApp({
      store,
      preflightStore,
      pool,
      config: {
        port: 0,
        host: '127.0.0.1',
        logLevel: 'silent',
        deploymentEnvironment: 'test',
        databaseUrl: pgContainer.getConnectionUri(),
        storeOutageMode: 'fail-closed',
        apiTokens: [API_TOKEN],
        agentApiTokens: [],
        exporterEvidenceTokens: [EXPORTER_TOKEN],
        webhookTokens: [],
        webhookDefaultPolicyVersion: 'signoz-webhook-v1',
        webhookDefaultCooldownSeconds: 300,
        webhookMaxAlertAgeMs: 600_000,
        webhookMaxClockSkewAheadMs: 60_000,
        dbPoolMax: 10,
        dbPoolIdleTimeoutMs: 30_000,
        dbPoolConnectionTimeoutMs: 2_000,
        dbStatementTimeoutMs: 5_000,
        maxRegisteredScopesPerTenant: 10_000,
        rateLimitMax: 120,
        rateLimitWindowMs: 60_000,
        preflightWindowMs: 5 * 60_000,
        preflightBlindCoverageThreshold: 0.5,
        preflightBlindOrphanRateThreshold: 0.5,
        preflightBlindTokenMissingRateThreshold: 0.3,
        preflightHeartbeatGraceMs: 2 * 60_000,
        preflightMaxEvidenceStalenessMs: 5 * 60_000,
        preflightMinRecoveryDwellMs: 60_000,
      },
    });
    await controlPlane.listen({ port: 0, host: '127.0.0.1' });
    const address = controlPlane.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('control plane failed to bind');
    controlPlaneUrl = `http://127.0.0.1:${address.port}`;

    fakeProvider = await startFakeProvider();
  }, 120_000);

  afterAll(async () => {
    tearingDownPool = true;
    await controlPlane.close();
    await pool.end();
    await pgContainer.stop();
    await fakeProvider.close();
    expect(poolErrors).toEqual([]);
  });

  function scopeFor(name: string): Scope {
    const scope = registeredScopes.pop();
    if (!scope) throw new Error(`registered scope pool exhausted at ${name}`);
    return scope;
  }

  function guardFor(scope: Scope): FuseGuard {
    return new FuseGuard({
      scope,
      controlPlaneUrl,
      apiToken: API_TOKEN,
      exporterEvidenceToken: EXPORTER_TOKEN,
      timeoutMs: 2000,
    });
  }

  async function tripViaHardcodedThreshold(
    scope: Scope,
    cooldownSeconds = 60,
  ): Promise<number> {
    const res = await fetch(`${controlPlaneUrl}/v1/breaker/trip`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        scope,
        reason: 'demo hardcoded threshold: call count exceeded 3 in 10s window',
        policyVersion: POLICY_VERSION,
        cooldownSeconds,
        actor: { type: 'system', id: 'system:demo-hardcoded-threshold' },
        correlationId: `trip-${randomUUID()}`,
        idempotencyKey: `idem-${randomUUID()}`,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { record: { state: string; epoch: number } };
    expect(body.record.state).toBe('tripped');
    return body.record.epoch;
  }

  it('while armed, guarded calls reach the real provider endpoint', async () => {
    const scope = scopeFor('armed-path');
    const guard = guardFor(scope);
    const before = fakeProvider.requestCount();

    for (let i = 0; i < 3; i++) {
      const result = await guard.guard(() => callFakeProvider(fakeProvider.url));
      expect(result).toMatchObject({ ok: true });
    }

    expect(fakeProvider.requestCount() - before).toBe(3);
  });

  it('retains firing evidence across a real Postgres outage, recovery barrier, and committed trip', async () => {
    const scope = scopeFor('detector-postgres-outage-recovery');
    const guard = new FuseGuard({
      scope,
      controlPlaneUrl,
      apiToken: API_TOKEN,
      timeoutMs: 2_000,
      stepObservationTimeoutMs: 500,
    });
    const before = fakeProvider.requestCount();

    const paidResult = await guard.guard(() => callFakeProvider(fakeProvider.url));
    expect(paidResult).toMatchObject({ ok: true });
    expect(fakeProvider.requestCount() - before).toBe(1);

    let paused = false;
    try {
      await setContainerPaused(pgContainer.getId(), true);
      paused = true;
      await expect(
        guard.recordStepObservation({
          executionId: 'postgres-outage-execution',
          timestampMs: Date.now(),
          canonicalShape: 'context-at-ceiling-after-paid-call',
          inputTokens: 100_000,
          outputTokens: 1,
          pricingStatus: 'available',
          estimatedCostUsd: 0.0001,
        }),
      ).resolves.toBeUndefined();

      await expect(
        guard.guard(
          () => callFakeProvider(fakeProvider.url),
          'denied-during-postgres-outage',
        ),
      ).rejects.toMatchObject({ code: 'detector_reporting_unavailable' });
      expect(fakeProvider.requestCount() - before).toBe(1);

      await setContainerPaused(pgContainer.getId(), false);
      paused = false;
      await expect
        .poll(async () => (await fetch(`${controlPlaneUrl}/readyz`)).status, {
          timeout: 10_000,
          interval: 100,
        })
        .toBe(200);

      await expect(
        guard.guard(() => callFakeProvider(fakeProvider.url), 'recovery-barrier'),
      ).rejects.toMatchObject({
        code: 'detector_reporting_unavailable',
        reason: expect.stringContaining('reporting recovered'),
      });
    } finally {
      if (paused) await setContainerPaused(pgContainer.getId(), false);
    }

    const committed = await pool.query<{
      state: string;
      actor_id: string;
      detector: string;
      detector_version: string;
      score: number;
      threshold: number;
    }>(
      `SELECT b.state, a.actor_id, j.detector, j.detector_version,
              j.score, j.threshold
         FROM breaker_state b
         JOIN breaker_audit_log a
           ON a.tenant=b.tenant AND a.environment=b.environment
          AND a.agent_id=b.agent_id AND a.to_state='tripped' AND NOT a.noop
         JOIN diagnosis_jobs j ON j.audit_event_id=a.id
        WHERE b.tenant=$1 AND b.environment=$2 AND b.agent_id=$3`,
      [scope.tenant, scope.environment, scope.agentId],
    );
    expect(committed.rows).toEqual([
      expect.objectContaining({
        state: 'tripped',
        actor_id: 'system:detector:context-bloat',
        detector: 'context-bloat',
        detector_version: 'context-bloat-v1',
        score: 100_000,
        threshold: 100_000,
      }),
    ]);
    await expect(
      guard.guard(() => callFakeProvider(fakeProvider.url), 'denied-after-recovery'),
    ).rejects.toMatchObject({ code: 'breaker_denied', state: 'tripped' });
    expect(fakeProvider.requestCount() - before).toBe(1);
  }, 30_000);

  it('a real detector observation commits a trip before the next provider call', async () => {
    const scope = scopeFor('detector-trip-next-call-zero');
    const guard = guardFor(scope);
    const before = fakeProvider.requestCount();

    await guard.guard(() => callFakeProvider(fakeProvider.url));
    expect(fakeProvider.requestCount() - before).toBe(1);

    // Exactly the documented context-bloat ceiling fires (>= 100,000).
    // recordStepObservation awaits the control-plane evaluation and the
    // atomic breaker trip before returning to the sequential agent.
    await guard.recordStepObservation({
      executionId: 'context-execution',
      timestampMs: Date.now(),
      canonicalShape: 'context-at-ceiling',
      inputTokens: 100_000,
      outputTokens: 1,
      pricingStatus: 'available',
      estimatedCostUsd: 0.0001,
    });

    const status = await fetch(
      `${controlPlaneUrl}/v1/breaker/status?tenant=${scope.tenant}&environment=${scope.environment}&agentId=${scope.agentId}`,
      { headers: { authorization: `Bearer ${API_TOKEN}` } },
    );
    expect(status.status).toBe(200);
    const trippedRecord = (
      (await status.json()) as { record: { state: string; epoch: number } }
    ).record;
    expect(trippedRecord.state).toBe('tripped');

    await expect(guard.guard(() => callFakeProvider(fakeProvider.url))).rejects.toThrow(
      BreakerTrippedError,
    );
    expect(fakeProvider.requestCount() - before).toBe(1);

    const resumeRes = await fetch(`${controlPlaneUrl}/v1/breaker/resume`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        scope,
        reason: 'operator cleared the detector incident',
        actor: { type: 'manual', id: 'user:oncall' },
        correlationId: `resume-${randomUUID()}`,
        idempotencyKey: `idem-${randomUUID()}`,
        expectedEpoch: trippedRecord.epoch,
      }),
    });
    expect(resumeRes.status).toBe(200);

    // The pre-trip absolute-ceiling observation must not survive resume.
    // A fresh low-token observation stays armed instead of immediately
    // re-tripping on the stale 100k-token history.
    await guard.recordStepObservation({
      executionId: 'context-execution',
      timestampMs: Date.now(),
      canonicalShape: 'fresh-after-resume',
      inputTokens: 100,
      outputTokens: 1,
      pricingStatus: 'available',
      estimatedCostUsd: 0.0001,
    });
    const afterResumeStatus = await fetch(
      `${controlPlaneUrl}/v1/breaker/status?tenant=${scope.tenant}&environment=${scope.environment}&agentId=${scope.agentId}`,
      { headers: { authorization: `Bearer ${API_TOKEN}` } },
    );
    expect(
      ((await afterResumeStatus.json()) as { record: { state: string } }).record.state,
    ).toBe('armed');
    await expect(
      guard.guard(() => callFakeProvider(fakeProvider.url)),
    ).resolves.toMatchObject({ ok: true });
    expect(fakeProvider.requestCount() - before).toBe(2);
    guard.stopStepObservationReporting();
  });

  it('after a committed trip, zero provider requests occur — sequential calls', async () => {
    const scope = scopeFor('trip-then-zero');
    const guard = guardFor(scope);

    // Establish a baseline successful call so we know the wiring works.
    await guard.guard(() => callFakeProvider(fakeProvider.url));
    const beforeTrip = fakeProvider.requestCount();

    await tripViaHardcodedThreshold(scope);

    const attempts = 10;
    let deniedCount = 0;
    for (let i = 0; i < attempts; i++) {
      try {
        await guard.guard(() => callFakeProvider(fakeProvider.url));
      } catch (err) {
        if (err instanceof BreakerTrippedError) deniedCount += 1;
        else throw err;
      }
    }

    expect(deniedCount).toBe(attempts);
    expect(fakeProvider.requestCount()).toBe(beforeTrip); // exactly zero new requests
  });

  it('after a committed trip, zero provider requests occur — concurrent calls racing the trip', async () => {
    const scope = scopeFor('trip-then-zero-concurrent');
    const guard = guardFor(scope);
    await guard.guard(() => callFakeProvider(fakeProvider.url));

    await tripViaHardcodedThreshold(scope);
    const afterTripCount = fakeProvider.requestCount();

    // Fire many concurrent guarded calls *after* the trip has already been
    // confirmed committed (the HTTP response above returned). None of these
    // may reach the provider, however tightly they race each other.
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () =>
        guard.guard(() => callFakeProvider(fakeProvider.url)),
      ),
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(
      results.every(
        (r) =>
          r.status === 'rejected' && (r.reason as Error) instanceof BreakerTrippedError,
      ),
    ).toBe(true);
    expect(fakeProvider.requestCount()).toBe(afterTripCount); // still zero new requests
  });

  it('permit-to-dispatch race allows only calls whose real permit completed before the trip commit', async () => {
    const scope = scopeFor('permit-commit-dispatch-race');
    const preCommitPermitGate = deferred();
    const postCommitPermitGate = deferred();
    const providerGate = deferred();
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith('/v1/permit')) {
        const body = JSON.parse(String(init?.body)) as { correlationId: string };
        if (body.correlationId.startsWith('permit-before-commit-')) {
          await preCommitPermitGate.promise;
        } else if (body.correlationId.startsWith('permit-after-commit-')) {
          await postCommitPermitGate.promise;
        }
      }
      return fetch(input, init);
    }) as typeof fetch;
    const guard = new FuseGuard({
      scope,
      controlPlaneUrl,
      apiToken: API_TOKEN,
      timeoutMs: 5_000,
      fetchImpl,
    });
    const before = fakeProvider.requestCount();
    const providerCallbacks: string[] = [];
    const dispatch = (label: string) => async () => {
      providerCallbacks.push(label);
      await providerGate.promise;
      return callFakeProvider(fakeProvider.url, { label });
    };

    const beforeCommitCalls = Array.from({ length: 3 }, (_, index) =>
      guard.guard(dispatch(`before-${index}`), `permit-before-commit-${index}`),
    );
    const afterCommitCalls = Array.from({ length: 5 }, (_, index) =>
      guard.guard(dispatch(`after-${index}`), `permit-after-commit-${index}`),
    );

    preCommitPermitGate.resolve();
    await expect
      .poll(() => providerCallbacks.length, { timeout: 5_000, interval: 10 })
      .toBe(3);
    expect([...providerCallbacks].sort()).toEqual(['before-0', 'before-1', 'before-2']);
    expect(fakeProvider.requestCount()).toBe(before);

    await tripViaHardcodedThreshold(scope);
    postCommitPermitGate.resolve();
    const denied = await Promise.allSettled(afterCommitCalls);
    expect(
      denied.every(
        (result) =>
          result.status === 'rejected' && result.reason instanceof BreakerTrippedError,
      ),
    ).toBe(true);
    expect([...providerCallbacks].sort()).toEqual(['before-0', 'before-1', 'before-2']);

    // These three requests cross the real provider's network boundary only
    // after the commit, but only because their permits completed beforehand.
    providerGate.resolve();
    await expect(Promise.all(beforeCommitCalls)).resolves.toHaveLength(3);
    expect(fakeProvider.requestCount() - before).toBe(3);

    await expect(
      guard.guard(dispatch('strictly-after-commit'), 'permit-strictly-after-commit'),
    ).rejects.toThrow(BreakerTrippedError);
    expect([...providerCallbacks].sort()).toEqual(['before-0', 'before-1', 'before-2']);
    expect(fakeProvider.requestCount() - before).toBe(3);
  }, 30_000);

  it('a manual resume restores provider access', async () => {
    const scope = scopeFor('resume-restores');
    const guard = guardFor(scope);
    const tripEpoch = await tripViaHardcodedThreshold(scope);
    await expect(guard.guard(() => callFakeProvider(fakeProvider.url))).rejects.toThrow(
      BreakerTrippedError,
    );

    const resumeRes = await fetch(`${controlPlaneUrl}/v1/breaker/resume`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        scope,
        reason: 'operator verified fix, resuming',
        actor: { type: 'manual', id: 'user:oncall' },
        correlationId: `resume-${randomUUID()}`,
        idempotencyKey: `idem-${randomUUID()}`,
        expectedEpoch: tripEpoch,
      }),
    });
    expect(resumeRes.status).toBe(200);

    const result = await guard.guard(() => callFakeProvider(fakeProvider.url));
    expect(result).toMatchObject({ ok: true });
  });

  it('a matching real-export callback makes this scope protected via the real Preflight API', async () => {
    const scope = scopeFor('preflight-live-wiring');
    const guard = guardFor(scope);

    const statusBefore = await fetch(
      `${controlPlaneUrl}/v1/preflight/status?tenant=${scope.tenant}&environment=${scope.environment}&agentId=${scope.agentId}`,
      { headers: { authorization: `Bearer ${API_TOKEN}` } },
    );
    expect(statusBefore.status).toBe(404); // never reported yet

    const observedAtMs = Date.now();
    await guard.recordTraceExportResult({
      scope,
      exporterDelivery: {
        status: 'success',
        observedAtMs,
        sourceInstanceId: 'integration-process-1',
        sequence: 1,
      },
      spans: [
        {
          timestampMs: observedAtMs,
          hasRequestModel: true,
          hasInputTokens: true,
          hasOutputTokens: true,
          hasScopedIdentity: true,
          hasValidTimestamps: true,
          isRootSpan: true,
          hasParent: false,
        },
      ],
    });

    const statusAfter = await fetch(
      `${controlPlaneUrl}/v1/preflight/status?tenant=${scope.tenant}&environment=${scope.environment}&agentId=${scope.agentId}`,
      { headers: { authorization: `Bearer ${API_TOKEN}` } },
    );
    expect(statusAfter.status).toBe(200);
    const body = (await statusAfter.json()) as { result: { state: string } };
    expect(body.result).toMatchObject({ state: 'protected', reasonCode: 'healthy' });
    guard.stopPreflightReporting();
  });
});
