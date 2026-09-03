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
const EXPORTER_TOKEN = 'exporter-'.padEnd(32, '0');
const EXACT_EXPORTER_TOKEN = 'exact-exporter-'.padEnd(32, '0');
const WEBHOOK_TOKEN = 'webhook-'.padEnd(32, '0');
const EXACT_EXPORTER_SCOPE = {
  tenant: 't1',
  environment: 'test',
  agentId: 'exact-exporter-agent',
};

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
  exporterEvidenceTokens: [
    EXPORTER_TOKEN,
    { ...EXACT_EXPORTER_SCOPE, token: EXACT_EXPORTER_TOKEN },
  ],
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

function delivered(observedAtMs: number, sequence = 1) {
  return {
    status: 'success' as const,
    observedAtMs,
    sourceInstanceId: 'control-plane-test-process',
    sequence,
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
  const registeredScopes: Array<{
    tenant: string;
    environment: string;
    agentId: string;
  }> = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool);
    const store = new BreakerStore(pool);
    await store.registerScope({
      scope: EXACT_EXPORTER_SCOPE,
      policyVersion: 'test-v1',
      actor: { type: 'system', id: 'test:setup' },
      reason: 'exact exporter integration scope',
      correlationId: 'setup-exact-exporter',
    });
    for (let index = 0; index < 30; index++) {
      const registeredScope = {
        tenant: 't1',
        environment: 'test',
        agentId: `agent-registered-${index}-${randomUUID().slice(0, 8)}`,
      };
      await store.registerScope({
        scope: registeredScope,
        policyVersion: 'test-v1',
        actor: { type: 'system', id: 'test:setup' },
        reason: 'integration test registration',
        correlationId: `setup-${index}`,
      });
      registeredScopes.push(registeredScope);
    }
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
    const registeredScope = registeredScopes.pop();
    if (!registeredScope) throw new Error('registered test scope pool exhausted');
    return registeredScope;
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
    const s = {
      tenant: 't1',
      environment: 'test',
      agentId: `agent-unregistered-${randomUUID().slice(0, 8)}`,
    };
    const res = await app.inject({
      method: 'GET',
      url: `/v1/preflight/status?tenant=${s.tenant}&environment=${s.environment}&agentId=${s.agentId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('unknown_scope');
  });

  it('an ordinary agent token cannot forge exporter success', async () => {
    const s = scope();
    const now = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: {
        scope: s,
        spans: [healthySpan(now)],
        exporterDelivery: delivered(now),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');

    const status = await app.inject({
      method: 'GET',
      url: `/v1/preflight/status?tenant=${s.tenant}&environment=${s.environment}&agentId=${s.agentId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(status.statusCode).toBe(404);
  });

  it('an exact-scope exporter credential establishes protected for its own scope', async () => {
    const now = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/preflight/exporter-evidence',
      headers: { authorization: `Bearer ${EXACT_EXPORTER_TOKEN}` },
      payload: {
        scope: EXACT_EXPORTER_SCOPE,
        spans: [healthySpan(now)],
        exporterDelivery: delivered(now),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.state).toBe('protected');
  });

  it('denies an exact exporter credential for a different scope', async () => {
    const wrongScope = scope();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/preflight/exporter-evidence',
      headers: { authorization: `Bearer ${EXACT_EXPORTER_TOKEN}` },
      payload: {
        scope: wrongScope,
        spans: [healthySpan(Date.now())],
        exporterDelivery: delivered(Date.now()),
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('unauthorized');
  });

  it('an operator token can read a status the agent reported', async () => {
    const s = scope();
    const now = Date.now();
    await app.inject({
      method: 'POST',
      url: '/v1/preflight/exporter-evidence',
      headers: { authorization: `Bearer ${EXPORTER_TOKEN}` },
      payload: {
        scope: s,
        spans: [healthySpan(now)],
        exporterDelivery: delivered(now),
      },
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
      url: '/v1/preflight/exporter-evidence',
      headers: { authorization: `Bearer ${EXPORTER_TOKEN}` },
      payload: { scope: s, spans: brokenSpans, exporterDelivery: delivered(now) },
    });
    expect(res.json().result.state).toBe('blind');
  });

  it('rejects a malformed report with 400 invalid_request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/preflight/exporter-evidence',
      headers: { authorization: `Bearer ${EXPORTER_TOKEN}` },
      payload: { scope: scope(), spans: [{ notAValidSpan: true }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('persists hysteresis across separate HTTP report calls (recovery does not commit instantly)', async () => {
    const s = scope();
    const t0 = Date.now() - 10_000;
    const brokenSpans = Array.from({ length: 6 }, (_, i) => ({
      ...healthySpan(t0 - (6 - i) * 1000),
      hasInputTokens: false,
      hasOutputTokens: false,
    }));
    const first = await app.inject({
      method: 'POST',
      url: '/v1/preflight/exporter-evidence',
      headers: { authorization: `Bearer ${EXPORTER_TOKEN}` },
      payload: { scope: s, spans: brokenSpans, exporterDelivery: delivered(t0) },
    });
    expect(first.json().result.state).toBe('blind');

    const recoveryEvidenceAt = Date.now();
    const second = await app.inject({
      method: 'POST',
      url: '/v1/preflight/exporter-evidence',
      headers: { authorization: `Bearer ${EXPORTER_TOKEN}` },
      payload: {
        scope: s,
        spans: [healthySpan(recoveryEvidenceAt)],
        exporterDelivery: delivered(recoveryEvidenceAt, 2),
      },
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
      payload: {
        scope: s,
        spans: [healthySpan(Date.now())],
        exporterDelivery: delivered(Date.now()),
      },
    });
    expect(report.statusCode).toBe(403);
    expect(report.json().error).toBe('unauthorized');
  });

  it('keeps an exporter credential out of permit and operator routes', async () => {
    const permit = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      headers: { authorization: `Bearer ${EXACT_EXPORTER_TOKEN}` },
      payload: {
        scope: EXACT_EXPORTER_SCOPE,
        correlationId: 'exporter-role-escape-permit',
      },
    });
    expect(permit.statusCode).toBe(403);
    expect(permit.json().error).toBe('unauthorized');

    const operatorStatus = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=${EXACT_EXPORTER_SCOPE.tenant}&environment=${EXACT_EXPORTER_SCOPE.environment}&agentId=${EXACT_EXPORTER_SCOPE.agentId}`,
      headers: { authorization: `Bearer ${EXACT_EXPORTER_TOKEN}` },
    });
    expect(operatorStatus.statusCode).toBe(403);
    expect(operatorStatus.json().error).toBe('unauthorized');
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

  it('an explicit operator `disabled: false` re-enables monitoring without fabricating exporter evidence', async () => {
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
      payload: {
        scope: s,
        spans: [healthySpan(Date.now())],
        disabled: false,
      },
    });
    expect(reenable.json().result.state).not.toBe('disabled');
    expect(reenable.json().result.state).not.toBe('protected');
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
      url: '/v1/preflight/exporter-evidence',
      headers: { authorization: `Bearer ${EXPORTER_TOKEN}` },
      payload: {
        scope: defaultScope,
        spans: [healthySpan(staleSpanTimestamp)],
        exporterDelivery: delivered(Date.now()),
      },
    });
    expect(defaultRes.json().result.state).toBe('blind');
    expect(defaultRes.json().result.reasonCode).toBe('stale-evidence');

    const widenedScope = scope();
    const widenedRes = await appWidenedStaleness.inject({
      method: 'POST',
      url: '/v1/preflight/exporter-evidence',
      headers: { authorization: `Bearer ${EXPORTER_TOKEN}` },
      payload: {
        scope: widenedScope,
        spans: [healthySpan(staleSpanTimestamp)],
        exporterDelivery: delivered(Date.now()),
      },
    });
    expect(widenedRes.json().result.state).toBe('protected');
  });

  it('does not report protected when local callbacks ran but OTLP was never confirmed or failed', async () => {
    const neverConfirmedScope = scope();
    const now = Date.now();
    const neverConfirmed = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { scope: neverConfirmedScope, spans: [healthySpan(now)] },
    });
    expect(neverConfirmed.json().result.state).toBe('degraded');
    expect(neverConfirmed.json().result.reasonCode).toBe('exporter-delivery-unconfirmed');

    const failedScope = scope();
    const failed = await app.inject({
      method: 'POST',
      url: '/v1/preflight/exporter-evidence',
      headers: { authorization: `Bearer ${EXPORTER_TOKEN}` },
      payload: {
        scope: failedScope,
        spans: [healthySpan(now)],
        exporterDelivery: {
          status: 'failure',
          observedAtMs: now,
          sourceInstanceId: 'control-plane-test-process',
          sequence: 1,
        },
      },
    });
    expect(failed.json().result.state).toBe('blind');
    expect(failed.json().result.reasonCode).toBe('exporter-delivery-failed');
  });

  it('uses database receipt time instead of reporter wall-clock skew for liveness', async () => {
    const s = scope();
    const spanAt = Date.now();
    const exporterAt = spanAt - 6 * 60_000;
    const initiallyProtected = await appWidenedStaleness.inject({
      method: 'POST',
      url: '/v1/preflight/exporter-evidence',
      headers: { authorization: `Bearer ${EXPORTER_TOKEN}` },
      payload: {
        scope: s,
        spans: [healthySpan(spanAt)],
        exporterDelivery: delivered(exporterAt),
      },
    });
    expect(initiallyProtected.json().result.state).toBe('protected');

    const status = await appWidenedStaleness.inject({
      method: 'GET',
      url: `/v1/preflight/status?tenant=${s.tenant}&environment=${s.environment}&agentId=${s.agentId}`,
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(status.json().result.state).toBe('protected');
  });
});
