import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { BreakerStore, PreflightStore } from '@fuse/breaker-store';
import { buildApp } from './app.js';
import type { ControlPlaneConfig } from './config.js';

const VALID_TOKEN = 'a'.repeat(32);
const AGENT_TOKEN = 'b'.repeat(32);
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
  apiTokens: [VALID_TOKEN],
  agentApiTokens: [],
  webhookTokens: [],
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

const fakePool = {} as unknown as pg.Pool;
const fakeStore = {} as unknown as BreakerStore;
const fakePreflightStore = {} as unknown as PreflightStore;

describe('buildApp: secure defaults (task.md §9.1)', () => {
  it('sets baseline security headers (@fastify/helmet) on every response', async () => {
    const app = await buildApp({
      store: fakeStore,
      preflightStore: fakePreflightStore,
      pool: fakePool,
      config: CONFIG,
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-dns-prefetch-control']).toBe('off');
    await app.close();
  });

  it('sets no CORS headers — a cross-origin preflight gets no Access-Control-Allow-Origin', async () => {
    const app = await buildApp({
      store: fakeStore,
      preflightStore: fakePreflightStore,
      pool: fakePool,
      config: CONFIG,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://evil.example' },
    });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('never echoes the Authorization header value in an error response body', async () => {
    const app = await buildApp({
      store: fakeStore,
      preflightStore: fakePreflightStore,
      pool: fakePool,
      config: CONFIG,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      headers: { authorization: 'Bearer totally-wrong-token-value-0123456789' },
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('totally-wrong-token-value');
    await app.close();
  });

  it('keeps effective policy inspection operator-only', async () => {
    const app = await buildApp({
      store: fakeStore,
      preflightStore: fakePreflightStore,
      pool: fakePool,
      config: { ...CONFIG, agentApiTokens: [AGENT_TOKEN] },
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/policies/effective?tenant=t1&environment=prod&agentId=a1',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('unauthorized');
    await app.close();
  });
});
