import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  GenericContainer,
  getContainerRuntimeClient,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BreakerStore, PreflightStore } from '@fuse/breaker-store';
import {
  buildApp,
  closeRateLimitRedis,
  connectRateLimitRedis,
  createRateLimitRedis,
} from './app.js';
import type { ControlPlaneConfig } from './config.js';
import { REQUIRED_MIGRATION_MANIFEST, REQUIRED_SCHEMA } from './routes/health.js';

const REDIS_IMAGE = 'redis:7.4.2-alpine';
const RAW_TOKEN = 'a'.repeat(32);
const EXPORTER_TOKEN = 'exporter-rate-limit-token-0000001';
const EXPORTER_SCOPE = { tenant: 't1', environment: 'test', agentId: 'agent-1' };
const fakePool = {
  query: vi.fn(async (query: string) => {
    if (query.includes('information_schema.columns')) {
      return {
        rows: Object.entries(REQUIRED_SCHEMA).flatMap(([table_name, columns]) =>
          columns.map((column_name) => ({ table_name, column_name })),
        ),
      };
    }
    return { rows: REQUIRED_MIGRATION_MANIFEST };
  }),
} as unknown as pg.Pool;
const fakeStore = {
  permit: vi.fn(async (_scope, correlationId: string) => ({
    allowed: true,
    state: 'armed',
    reason: 'breaker armed',
    epoch: 0,
    degraded: false,
    correlationId,
  })),
} as unknown as BreakerStore;
const fakePreflightStore = {} as PreflightStore;

const BASE_CONFIG: ControlPlaneConfig = {
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
  rateLimitMax: 2,
  rateLimitWindowMs: 60_000,
  storeOutageMode: 'fail-closed',
  apiTokens: ['a'.repeat(32)],
  agentApiTokens: [],
  exporterEvidenceTokens: [{ ...EXPORTER_SCOPE, token: EXPORTER_TOKEN }],
  webhookTokens: [],
  webhookDefaultPolicyVersion: 'test-v1',
  webhookDefaultCooldownSeconds: 300,
  webhookMaxAlertAgeMs: 600_000,
  webhookMaxClockSkewAheadMs: 60_000,
  preflightWindowMs: 300_000,
  preflightBlindCoverageThreshold: 0.5,
  preflightBlindOrphanRateThreshold: 0.5,
  preflightBlindTokenMissingRateThreshold: 0.3,
  preflightHeartbeatGraceMs: 120_000,
  preflightMaxEvidenceStalenessMs: 300_000,
  preflightMinRecoveryDwellMs: 60_000,
};

function redisUrl(container: StartedTestContainer): string {
  return `redis://${container.getHost()}:${container.getMappedPort(6379)}/0`;
}

async function startRedis(): Promise<StartedTestContainer> {
  return new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
}

describe('distributed production rate limiting (real Redis)', () => {
  const containers: StartedTestContainer[] = [];
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.allSettled(apps.splice(0).map((app) => app.close()));
    await Promise.allSettled(containers.splice(0).map((container) => container.stop()));
  });

  it('shares a hashed bearer-key counter across two app instances and keys health by IP', async () => {
    const container = await startRedis();
    containers.push(container);
    const config = { ...BASE_CONFIG, rateLimitRedisUrl: redisUrl(container) };
    const firstRedis = createRateLimitRedis(config)!;
    const secondRedis = createRateLimitRedis(config)!;
    firstRedis.on('error', () => undefined);
    secondRedis.on('error', () => undefined);
    await Promise.all([
      connectRateLimitRedis(firstRedis),
      connectRateLimitRedis(secondRedis),
    ]);
    await firstRedis.flushdb();

    const firstApp = await buildApp({
      store: fakeStore,
      preflightStore: fakePreflightStore,
      pool: fakePool,
      config,
      rateLimitRedis: firstRedis,
    });
    const secondApp = await buildApp({
      store: fakeStore,
      preflightStore: fakePreflightStore,
      pool: fakePool,
      config,
      rateLimitRedis: secondRedis,
    });
    apps.push(firstApp, secondApp);
    await Promise.all([firstApp.ready(), secondApp.ready()]);

    const request = (app: FastifyInstance) =>
      app.inject({
        method: 'POST',
        url: '/v1/permit',
        headers: { authorization: `Bearer ${RAW_TOKEN}` },
        payload: {},
      });
    expect((await request(firstApp)).statusCode).toBe(400);
    expect((await request(secondApp)).statusCode).toBe(400);
    const limited = await request(firstApp);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      error: 'rate_limited',
      message: 'rate limit exceeded',
    });

    const bearerKeys = await firstRedis.keys('*');
    expect(bearerKeys).toHaveLength(1);
    expect(bearerKeys[0]).toMatch(/:auth:[A-Za-z0-9_-]{43}$/);
    expect(bearerKeys[0]).not.toContain(RAW_TOKEN);

    await firstRedis.flushdb();
    const health = await secondApp.inject({
      method: 'GET',
      url: '/healthz',
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
    });
    expect(health.statusCode).toBe(200);
    const healthKeys = await firstRedis.keys('*');
    expect(healthKeys).toHaveLength(0);

    const exporterRequest = (app: FastifyInstance) =>
      app.inject({
        method: 'POST',
        url: '/v1/preflight/exporter-evidence',
        headers: { authorization: `Bearer ${EXPORTER_TOKEN}` },
        payload: { scope: EXPORTER_SCOPE, spans: [] },
      });
    expect((await exporterRequest(firstApp)).statusCode).toBe(400);
    expect((await exporterRequest(secondApp)).statusCode).toBe(400);
    expect((await exporterRequest(firstApp)).statusCode).toBe(429);
    const exporterKeys = await firstRedis.keys('*');
    expect(exporterKeys).toHaveLength(1);
    expect(exporterKeys[0]).not.toContain(EXPORTER_TOKEN);

    await Promise.all([
      closeRateLimitRedis(firstRedis),
      closeRateLimitRedis(secondRedis),
    ]);
  }, 120_000);

  it('keeps liveness up, fails guarded calls closed, and recovers in the same process', async () => {
    const container = await startRedis();
    containers.push(container);
    const config = {
      ...BASE_CONFIG,
      rateLimitMax: 120,
      rateLimitRedisUrl: redisUrl(container),
    };
    const runtimeRedis = createRateLimitRedis(config)!;
    runtimeRedis.on('error', () => undefined);
    await connectRateLimitRedis(runtimeRedis);
    const app = await buildApp({
      store: fakeStore,
      preflightStore: fakePreflightStore,
      pool: fakePool,
      config,
      rateLimitRedis: runtimeRedis,
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('missing test address');
    const sdkModulePath = '../../../packages/sdk/src/index.js';
    const { FuseGuard } = (await import(sdkModulePath)) as {
      FuseGuard: new (options: {
        scope: { tenant: string; environment: string; agentId: string };
        controlPlaneUrl: string;
        apiToken: string;
        timeoutMs: number;
        outageMode: 'fail-closed';
        reportPreflightTelemetry: false;
        reportStepObservations: false;
      }) => {
        guard<T>(dispatch: () => Promise<T>, correlationId: string): Promise<T>;
      };
    };
    const guard = new FuseGuard({
      scope: { tenant: 'test', environment: 'test', agentId: 'redis-recovery' },
      controlPlaneUrl: `http://127.0.0.1:${address.port}`,
      apiToken: RAW_TOKEN,
      timeoutMs: 3_000,
      outageMode: 'fail-closed',
      reportPreflightTelemetry: false,
      reportStepObservations: false,
    });
    const provider = vi.fn(async () => 'provider-response');
    await expect(guard.guard(provider, 'before-outage')).resolves.toBe(
      'provider-response',
    );
    provider.mockClear();

    const runtime = await getContainerRuntimeClient();
    const redisContainer = runtime.container.getById(container.getId());
    await redisContainer.pause();

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({
      status: 'not-ready',
      reason: 'rate_limit_store_unavailable',
      dependency: 'redis',
    });
    const outageCorrelationId = 'redis-rate-limit-outage-permit';
    const permitDuringOutage = await fetch(`http://127.0.0.1:${address.port}/v1/permit`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${RAW_TOKEN}`,
        'content-type': 'application/json',
        'x-correlation-id': outageCorrelationId,
      },
      body: JSON.stringify({
        scope: { tenant: 'test', environment: 'test', agentId: 'redis-recovery' },
        correlationId: outageCorrelationId,
      }),
    });
    expect(permitDuringOutage.status).toBe(503);
    await expect(permitDuringOutage.json()).resolves.toEqual({
      error: 'store_unavailable',
      message: 'rate limit store is unavailable; request denied',
      correlationId: outageCorrelationId,
    });
    await expect(guard.guard(provider, 'during-outage')).rejects.toMatchObject({
      name: 'BreakerTrippedError',
    });
    expect(provider).not.toHaveBeenCalled();

    const startupRedis = createRateLimitRedis(config)!;
    startupRedis.on('error', () => undefined);
    const startedAt = Date.now();
    await expect(connectRateLimitRedis(startupRedis)).rejects.toThrow(
      /shared rate-limit Redis is unavailable; startup refused/,
    );
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    await closeRateLimitRedis(startupRedis);

    await redisContainer.unpause();
    await expect
      .poll(
        async () => (await app.inject({ method: 'GET', url: '/readyz' })).statusCode,
        { timeout: 10_000, interval: 100 },
      )
      .toBe(200);
    await expect(guard.guard(provider, 'after-recovery')).resolves.toBe(
      'provider-response',
    );
    expect(provider).toHaveBeenCalledOnce();

    await closeRateLimitRedis(runtimeRedis);
  }, 120_000);
});
