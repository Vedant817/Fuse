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

function healthySpan(timestampMs: number) {
  return {
    timestampMs,
    hasRequestModel: true,
    hasInputTokens: true,
    hasOutputTokens: true,
    hasScopedIdentity: true,
    hasValidTimestamps: true,
    isRootSpan: false,
    hasParent: true,
  };
}

describe('Preflight API (real Postgres + control plane)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let app: FastifyInstance;
  // Same store/pool, but built with a widened preflightMaxEvidenceStalenessMs
  // — proves the configured Preflight thresholds are actually wired into the
  // live HTTP route, not just parsed correctly in config.ts isolation.
  let appWidenedStaleness: FastifyInstance;

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
    appWidenedStaleness = await buildApp({
      store,
      preflightStore,
      pool,
      config: { ...CONFIG, preflightMaxEvidenceStalenessMs: 20 * 60_000 },
    });
    await appWidenedStaleness.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await appWidenedStaleness.close();
    await pool.end();
    await container.stop();
  });

  function scope() {
    return {
      tenant: 't1',
      environment: 'test',
      agentId: `agent-${randomUUID().slice(0, 8)}`,
    };
  }

  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      payload: { scope: scope(), spans: [] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 unknown_scope for status on a scope never reported', async () => {
    const s = scope();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/preflight/status?tenant=${s.tenant}&environment=${s.environment}&agentId=${s.agentId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('unknown_scope');
  });

  it('an agent token can report its own telemetry health', async () => {
    const s = scope();
    const now = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { scope: s, spans: [healthySpan(now)] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.state).toBe('protected');
  });

  it('an operator token can read a status the agent reported', async () => {
    const s = scope();
    const now = Date.now();
    await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { scope: s, spans: [healthySpan(now)] },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/preflight/status?tenant=${s.tenant}&environment=${s.environment}&agentId=${s.agentId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.state).toBe('protected');
  });

  it('reports blind when reported spans are missing token counts', async () => {
    const s = scope();
    const now = Date.now();
    const brokenSpans = Array.from({ length: 6 }, (_, i) => ({
      ...healthySpan(now - (6 - i) * 1000),
      hasInputTokens: false,
      hasOutputTokens: false,
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { scope: s, spans: brokenSpans },
    });
    expect(res.json().result.state).toBe('blind');
  });

  it('rejects a malformed report with 400 invalid_request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { scope: scope(), spans: [{ notAValidSpan: true }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('persists hysteresis across separate HTTP report calls (recovery does not commit instantly)', async () => {
    const s = scope();
    const t0 = Date.now();
    const brokenSpans = Array.from({ length: 6 }, (_, i) => ({
      ...healthySpan(t0 - (6 - i) * 1000),
      hasInputTokens: false,
      hasOutputTokens: false,
    }));
    const first = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { scope: s, spans: brokenSpans },
    });
    expect(first.json().result.state).toBe('blind');

    const second = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { scope: s, spans: [healthySpan(t0 + 5_000)] },
    });
    expect(second.json().result.state).toBe('blind'); // held, recovering
    expect(second.json().result.reasonCode).toBe('recovering');
  });

  it('an operator can mark a scope disabled via the report endpoint', async () => {
    const s = scope();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: { scope: s, spans: [], disabled: true, disabledReason: 'maintenance' },
    });
    expect(res.json().result.state).toBe('disabled');
  });

  it('rejects an agent token attempting to set or clear the operator-only disabled state', async () => {
    const setScope = scope();
    const setDisabled = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: {
        scope: setScope,
        spans: [],
        disabled: true,
        disabledReason: 'agent must not suppress its own monitoring',
      },
    });
    expect(setDisabled.statusCode).toBe(403);
    expect(setDisabled.json().error).toBe('unauthorized');

    const clearDisabled = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { scope: setScope, spans: [healthySpan(Date.now())], disabled: false },
    });
    expect(clearDisabled.statusCode).toBe(403);
    expect(clearDisabled.json().error).toBe('unauthorized');

    const status = await app.inject({
      method: 'GET',
      url: `/v1/preflight/status?tenant=${setScope.tenant}&environment=${setScope.environment}&agentId=${setScope.agentId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(status.statusCode).toBe(404);
  });

  it('keeps a webhook-only token confined to the webhook route', async () => {
    const s = scope();
    const permit = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: { scope: s, correlationId: 'webhook-role-escape-permit' },
    });
    expect(permit.statusCode).toBe(403);
    expect(permit.json().error).toBe('unauthorized');

    const report = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      payload: { scope: s, spans: [healthySpan(Date.now())] },
    });
    expect(report.statusCode).toBe(403);
    expect(report.json().error).toBe('unauthorized');
  });

  it('a disabled scope stays disabled when an agent reports ordinary telemetry that omits `disabled` entirely', async () => {
    // Regression: the real FuseGuard/PreflightReporter path
    // (packages/sdk/src/preflight-reporter.ts) never sends `disabled` on
    // its routine reports. This is exactly that real request shape —
    // POST with `scope`/`spans` only, no `disabled` key at all — and it
    // must not silently re-enable a scope an operator just disabled.
    const s = scope();
    await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: { scope: s, spans: [], disabled: true, disabledReason: 'maintenance' },
    });

    const routineAgentReport = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { scope: s, spans: [healthySpan(Date.now())] },
    });
    expect(routineAgentReport.json().result.state).toBe('disabled');
    expect(routineAgentReport.json().result.reason).toBe('maintenance');

    const statusRes = await app.inject({
      method: 'GET',
      url: `/v1/preflight/status?tenant=${s.tenant}&environment=${s.environment}&agentId=${s.agentId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(statusRes.json().result.state).toBe('disabled');
  });

  it('an explicit `disabled: false` re-enables a previously-disabled scope', async () => {
    const s = scope();
    await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: { scope: s, spans: [], disabled: true, disabledReason: 'maintenance' },
    });

    const reenable = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: { scope: s, spans: [healthySpan(Date.now())], disabled: false },
    });
    expect(reenable.json().result.state).toBe('protected');
  });

  it('a configured, non-default preflightMaxEvidenceStalenessMs changes evaluator behavior end-to-end through the real HTTP route', async () => {
    // 6 minutes old: stale under the 5-minute DEFAULT_PREFLIGHT_CONFIG
    // window, but current under a 20-minute operator-configured override —
    // this is the exact scenario the fix targets (a low-traffic/bursty
    // agent that would otherwise always read `blind` under a fixed window).
    const staleSpanTimestamp = Date.now() - 6 * 60_000;

    const defaultScope = scope();
    const defaultRes = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { scope: defaultScope, spans: [healthySpan(staleSpanTimestamp)] },
    });
    expect(defaultRes.json().result.state).toBe('blind');
    expect(defaultRes.json().result.reasonCode).toBe('stale-evidence');

    const widenedScope = scope();
    const widenedRes = await appWidenedStaleness.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { scope: widenedScope, spans: [healthySpan(staleSpanTimestamp)] },
    });
    expect(widenedRes.json().result.state).toBe('protected');
  });
});
