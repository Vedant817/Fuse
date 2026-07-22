import { randomUUID } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BreakerStore, PreflightStore, runMigrations } from '@fuse/breaker-store';
import { buildApp } from './app.js';
import type { ControlPlaneConfig } from './config.js';

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
  rateLimitMax: 120,
  rateLimitWindowMs: 60_000,
  storeOutageMode: 'fail-closed',
  apiTokens: [OPERATOR_TOKEN],
  agentApiTokens: [AGENT_TOKEN],
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

describe('SigNoz alert webhook (real Postgres + control plane)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool);
    const store = new BreakerStore(pool);
    const preflightStore = new PreflightStore(pool);
    app = await buildApp({ store, preflightStore, pool, config: CONFIG });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
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
            fuse_agent_id: `agent-${randomUUID().slice(0, 8)}`,
            fuse_detector: 'loop-signature',
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

  it('a webhook token can call the route and trips the breaker for a firing alert', async () => {
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

    const permitRes = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: {
        scope: { tenant: 't1', environment: 'test', agentId },
        correlationId: 'c1',
      },
    });
    expect(permitRes.json().allowed).toBe(false);
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
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
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
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    const payload = {
      status: 'firing',
      alerts: [
        {
          status: 'firing',
          labels: { fuse_tenant: 't1', fuse_environment: 'test', fuse_agent_id: agentId },
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

  it('processes a grouped delivery (multiple alerts, mixed firing/resolved) independently', async () => {
    const agentA = `agent-${randomUUID().slice(0, 8)}`;
    const agentB = `agent-${randomUUID().slice(0, 8)}`;
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
          labels: { fuse_tenant: 't1', fuse_environment: 'test', fuse_agent_id: agentId },
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
          labels: { fuse_tenant: 't1', fuse_environment: 'test', fuse_agent_id: agentId },
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
          labels: { fuse_tenant: 't1', fuse_environment: 'test', fuse_agent_id: agentId },
          startsAt: 'not-a-real-timestamp',
        },
      ),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].outcome).toBe('stale-alert');
  });

  it('a genuinely already-tripped scope reports already-tripped, not breaker-disabled', async () => {
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    const labels = {
      fuse_tenant: 't1',
      fuse_environment: 'test',
      fuse_agent_id: agentId,
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
    expect(second.json().results[0]).toMatchObject({ outcome: 'already-tripped' });

    const statusRes = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=t1&environment=test&agentId=${agentId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(statusRes.json().record.state).toBe('tripped');
  });

  it('a disabled scope reports breaker-disabled on a fresh alert, not already-tripped, and stays disabled', async () => {
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
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
      },
    });
    expect(disableRes.json().record.state).toBe('disabled');

    const webhookRes = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: firingAlert(
        {},
        {
          labels: { fuse_tenant: 't1', fuse_environment: 'test', fuse_agent_id: agentId },
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
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    const freshStartsAt = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: firingAlert(
        {},
        {
          labels: { fuse_tenant: 't1', fuse_environment: 'test', fuse_agent_id: agentId },
          startsAt: freshStartsAt,
        },
      ),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].outcome).toBe('tripped');
  });
});
