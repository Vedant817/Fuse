import type pg from 'pg';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import type {
  BreakerStore,
  DiagnosisJobStore,
  PreflightStore,
} from '@fuse/breaker-store';
import { buildApp, rateLimitKey } from './app.js';
import type { ControlPlaneConfig } from './config.js';

const operationalMetricMocks = vi.hoisted(() => ({
  detectorRequests: vi.fn(),
  detectorLatency: vi.fn(),
  webhookRequests: vi.fn(),
  webhookLatency: vi.fn(),
}));

vi.mock('@fuse/otel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fuse/otel')>()),
  getDetectorObservationRequestCounter: () => ({
    add: operationalMetricMocks.detectorRequests,
  }),
  getDetectorObservationLatencyHistogram: () => ({
    record: operationalMetricMocks.detectorLatency,
  }),
  getWebhookRequestCounter: () => ({ add: operationalMetricMocks.webhookRequests }),
  getWebhookLatencyHistogram: () => ({ record: operationalMetricMocks.webhookLatency }),
}));

const VALID_TOKEN = 'a'.repeat(32);
const AGENT_TOKEN = 'b'.repeat(32);
const EXPORTER_TOKEN = 'd'.repeat(32);
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
  exporterEvidenceTokens: [
    {
      tenant: 't1',
      environment: 'production',
      agentId: 'agent-1',
      token: EXPORTER_TOKEN,
    },
  ],
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

function fakeRateLimitRedis(commandError?: Error): Redis {
  const redis = {
    status: 'ready',
    defineCommand(name: string) {
      Object.assign(redis, {
        [name]: (...args: unknown[]) => {
          const callback = args.at(-1) as (
            error: Error | null,
            result?: [number, number],
          ) => void;
          callback(commandError ?? null, commandError ? undefined : [1, 60_000]);
        },
      });
    },
    ping: vi.fn().mockResolvedValue('PONG'),
  };
  return redis as unknown as Redis;
}

describe('buildApp: secure defaults (task.md §9.1)', () => {
  it('rejects a wildcard agent credential in a production config even when buildApp is called directly', async () => {
    await expect(
      buildApp({
        store: fakeStore,
        preflightStore: fakePreflightStore,
        pool: fakePool,
        config: {
          ...CONFIG,
          deploymentEnvironment: 'production',
          detectorPolicyFile: '/etc/fuse/policies/production.json',
          agentApiTokens: [
            {
              tenant: '*',
              environment: '*',
              agentId: '*',
              token: AGENT_TOKEN,
            },
          ],
        },
      }),
    ).rejects.toThrow(
      /production agent credentials must bind tenant, environment, and agentId/,
    );
  });

  it('rejects production construction without a shared Redis client', async () => {
    await expect(
      buildApp({
        store: fakeStore,
        preflightStore: fakePreflightStore,
        pool: fakePool,
        config: {
          ...CONFIG,
          deploymentEnvironment: 'production',
          detectorPolicyFile: '/etc/fuse/policies/production.json',
          rateLimitRedisUrl: 'redis://redis.internal:6379',
        },
      }),
    ).rejects.toThrow(/connected shared rate-limit Redis client is required/);
  });

  it('hashes bearer credentials into stable bounded keys and uses IP without a token', () => {
    const credential = 'Bearer raw-secret-that-must-never-be-stored';
    const credentialHash = createHash('sha256').update(credential).digest('base64url');
    const known = new Set([credentialHash]);
    const first = rateLimitKey(
      {
        ip: '127.0.0.1',
        url: '/v1/permit',
        headers: { authorization: credential },
      },
      known,
    );
    const second = rateLimitKey(
      {
        ip: '10.0.0.9',
        url: '/v1/permit',
        headers: { authorization: credential },
      },
      known,
    );
    expect(first).toBe(second);
    expect(first).toMatch(/^auth:[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain('raw-secret');
    expect(
      rateLimitKey(
        {
          ip: '127.0.0.1',
          url: '/v1/permit',
          headers: { authorization: 'Bearer attacker-chosen-value' },
        },
        known,
      ),
    ).toBe('ip:127.0.0.1');
    expect(rateLimitKey({ ip: '127.0.0.1', url: '/v1/permit', headers: {} })).toBe(
      'ip:127.0.0.1',
    );
    expect(
      rateLimitKey({
        ip: '127.0.0.1',
        url: '/healthz',
        headers: { authorization: credential },
      }),
    ).toBe('ip:127.0.0.1');
  });

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

  it('maps only a rate-limit store hook failure to stable 503 store_unavailable', async () => {
    const app = await buildApp({
      store: fakeStore,
      preflightStore: fakePreflightStore,
      pool: fakePool,
      config: CONFIG,
      rateLimitRedis: fakeRateLimitRedis(new Error('injected Redis command failure')),
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        'x-correlation-id': 'rate-limit-store-unit-correlation',
      },
      payload: {},
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: 'store_unavailable',
      message: 'rate limit store is unavailable; request denied',
      correlationId: 'rate-limit-store-unit-correlation',
    });
    await app.close();
  });

  it('does not misclassify a route exception as a rate-limit store outage', async () => {
    const app = await buildApp({
      store: fakeStore,
      preflightStore: fakePreflightStore,
      pool: fakePool,
      config: CONFIG,
      rateLimitRedis: fakeRateLimitRedis(),
    });
    app.get('/test-route-error', async () => {
      throw new Error('injected route failure');
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test-route-error',
      headers: { 'x-correlation-id': 'route-error-unit-correlation' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: 'internal_error',
      message: 'internal error',
      correlationId: 'route-error-unit-correlation',
    });
    await app.close();
  });

  it('records bounded detector and webhook outcomes even when auth rejects before the route', async () => {
    operationalMetricMocks.detectorRequests.mockReset();
    operationalMetricMocks.detectorLatency.mockReset();
    operationalMetricMocks.webhookRequests.mockReset();
    operationalMetricMocks.webhookLatency.mockReset();
    const app = await buildApp({
      store: fakeStore,
      preflightStore: fakePreflightStore,
      pool: fakePool,
      config: CONFIG,
    });
    await app.ready();

    const detector = await app.inject({
      method: 'POST',
      url: '/v1/detectors/observe',
      payload: {},
    });
    const webhook = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      payload: {},
    });

    expect(detector.statusCode).toBe(401);
    expect(webhook.statusCode).toBe(401);
    const attributes = {
      'fuse.slo.version': 'v1-provisional',
      'fuse.outcome': 'auth_failure',
    };
    expect(operationalMetricMocks.detectorRequests).toHaveBeenCalledWith(1, attributes);
    expect(operationalMetricMocks.detectorLatency).toHaveBeenCalledWith(
      expect.any(Number),
      attributes,
    );
    expect(operationalMetricMocks.webhookRequests).toHaveBeenCalledWith(1, attributes);
    expect(operationalMetricMocks.webhookLatency).toHaveBeenCalledWith(
      expect.any(Number),
      attributes,
    );
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

  it('registers diagnosis operations deny-by-default, operator-only, and tenant-bound', async () => {
    const tenantOperator = { tenant: 'tenant-a', token: 'c'.repeat(32) };
    const list = vi.fn().mockResolvedValue({ jobs: [], nextCursor: null });
    const replay = vi.fn();
    const app = await buildApp({
      store: fakeStore,
      preflightStore: fakePreflightStore,
      diagnosisJobStore: { list, replay } as unknown as DiagnosisJobStore,
      pool: fakePool,
      config: {
        ...CONFIG,
        apiTokens: [tenantOperator],
        agentApiTokens: [AGENT_TOKEN],
      },
    });
    await app.ready();

    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/v1/diagnosis/jobs?tenant=tenant-a',
    });
    const agent = await app.inject({
      method: 'GET',
      url: '/v1/diagnosis/jobs?tenant=tenant-a',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
    });
    const crossTenant = await app.inject({
      method: 'GET',
      url: '/v1/diagnosis/jobs?tenant=tenant-b',
      headers: { authorization: `Bearer ${tenantOperator.token}` },
    });
    const ownTenant = await app.inject({
      method: 'GET',
      url: '/v1/diagnosis/jobs?tenant=tenant-a',
      headers: { authorization: `Bearer ${tenantOperator.token}` },
    });
    const crossTenantReplay = await app.inject({
      method: 'POST',
      url: '/v1/diagnosis/jobs/00000000-0000-4000-8000-000000000001/replay',
      headers: { authorization: `Bearer ${tenantOperator.token}` },
      payload: {
        scope: { tenant: 'tenant-b', environment: 'prod', agentId: 'agent-1' },
        actor: { type: 'manual', id: 'operator:alice' },
        reason: 'must not cross tenants',
        idempotencyKey: 'cross-tenant-replay',
      },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(agent.statusCode).toBe(403);
    expect(crossTenant.statusCode).toBe(403);
    expect(crossTenantReplay.statusCode).toBe(403);
    expect(ownTenant.statusCode).toBe(200);
    expect(list).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith({ tenant: 'tenant-a', limit: 50 });
    expect(replay).not.toHaveBeenCalled();
    await app.close();
  });
});
