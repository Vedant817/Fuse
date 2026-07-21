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

const CONFIG: ControlPlaneConfig = {
  port: 0,
  host: '127.0.0.1',
  logLevel: 'silent',
  deploymentEnvironment: 'test',
  databaseUrl: '',
  storeOutageMode: 'fail-closed',
  apiTokens: [OPERATOR_TOKEN],
  agentApiTokens: [AGENT_TOKEN],
  webhookTokens: [],
  webhookDefaultPolicyVersion: 'signoz-webhook-v1',
  webhookDefaultCooldownSeconds: 300,
  webhookMaxAlertAgeMs: 600_000,
  webhookMaxClockSkewAheadMs: 60_000,
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
});
