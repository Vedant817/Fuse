import Fastify from 'fastify';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  REQUIRED_MIGRATIONS,
  REQUIRED_MIGRATION_MANIFEST,
  REQUIRED_SCHEMA,
  SchemaNotReadyError,
  assertRateLimitRedisReady,
  assertSchemaReady,
  registerHealthRoutes,
} from './health.js';

const redisMetricMocks = vi.hoisted(() => ({ gauge: vi.fn(), checks: vi.fn() }));

vi.mock('@fuse/otel', () => ({
  FUSE_OPERATIONAL_SLO_VERSION: 'v1-provisional',
  getRedisReadinessGauge: () => ({ record: redisMetricMocks.gauge }),
  getRedisReadinessCheckCounter: () => ({ add: redisMetricMocks.checks }),
}));

function completeColumns(): { table_name: string; column_name: string }[] {
  return Object.entries(REQUIRED_SCHEMA).flatMap(([table_name, columns]) =>
    columns.map((column_name) => ({ table_name, column_name })),
  );
}

function poolWithResults(
  columns = completeColumns(),
  migrations: readonly string[] = REQUIRED_MIGRATIONS,
  checksumOverrides: ReadonlyMap<string, string> = new Map(),
): pg.Pool {
  const checksums = new Map(
    REQUIRED_MIGRATION_MANIFEST.map(({ id, checksum }) => [id, checksum]),
  );
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: columns })
      .mockResolvedValueOnce({
        rows: migrations.map((id) => ({
          id,
          checksum: checksumOverrides.get(id) ?? checksums.get(id),
        })),
      }),
  } as unknown as pg.Pool;
}

describe('schema readiness', () => {
  it('accepts the complete current schema and migration ledger', async () => {
    await expect(assertSchemaReady(poolWithResults())).resolves.toBeUndefined();
  });

  it('rejects a database missing a required schema column', async () => {
    const columns = completeColumns().filter(
      ({ table_name, column_name }) =>
        !(table_name === 'preflight_state' && column_name === 'evidence_version'),
    );

    await expect(assertSchemaReady(poolWithResults(columns))).rejects.toEqual(
      expect.objectContaining<Partial<SchemaNotReadyError>>({
        name: 'SchemaNotReadyError',
        missing: ['preflight_state.evidence_version'],
      }),
    );
  });

  it('rejects a stale migration ledger even when expected columns exist', async () => {
    const staleMigrations = REQUIRED_MIGRATIONS.slice(0, -1);

    await expect(
      assertSchemaReady(poolWithResults(completeColumns(), staleMigrations)),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SchemaNotReadyError>>({
        name: 'SchemaNotReadyError',
        missing: [`migration:${REQUIRED_MIGRATIONS.at(-1)!}`],
      }),
    );
  });

  it('rejects a migration checksum mismatch even when IDs and columns match', async () => {
    const altered = REQUIRED_MIGRATIONS[0]!;

    await expect(
      assertSchemaReady(
        poolWithResults(
          completeColumns(),
          REQUIRED_MIGRATIONS,
          new Map([[altered, '0'.repeat(64)]]),
        ),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SchemaNotReadyError>>({
        name: 'SchemaNotReadyError',
        missing: [`migration-checksum:${altered}`],
      }),
    );
  });
});

describe('health routes', () => {
  it('reports stale schema separately from an unavailable store', async () => {
    const app = Fastify({ logger: false });
    registerHealthRoutes(
      app,
      poolWithResults(completeColumns(), REQUIRED_MIGRATIONS.slice(0, -1)),
    );

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not-ready', reason: 'schema_not_ready' });
    await app.close();
  });

  it('reports an unavailable store without failing liveness', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as pg.Pool;
    const app = Fastify({ logger: false });
    registerHealthRoutes(app, pool);

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    const ready = await app.inject({ method: 'GET', url: '/readyz' });

    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'not-ready', reason: 'store_unavailable' });
    await app.close();
  });

  it('bounds the Redis readiness PING and keeps liveness independent', async () => {
    const pool = poolWithResults();
    const redis = {
      ping: vi.fn(() => new Promise<string>(() => undefined)),
    };
    const app = Fastify({ logger: false });
    registerHealthRoutes(app, pool, redis);

    const startedAt = Date.now();
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    const health = await app.inject({ method: 'GET', url: '/healthz' });

    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({
      status: 'not-ready',
      reason: 'rate_limit_store_unavailable',
      dependency: 'redis',
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(health.statusCode).toBe(200);
    expect(redisMetricMocks.gauge).toHaveBeenCalledWith(0, {
      'fuse.slo.version': 'v1-provisional',
    });
    expect(redisMetricMocks.checks).toHaveBeenCalledWith(1, {
      'fuse.slo.version': 'v1-provisional',
      'fuse.outcome': 'failure',
    });
    await app.close();
  });
});

describe('Redis readiness', () => {
  it('accepts PONG and rejects a bounded timeout', async () => {
    await expect(
      assertRateLimitRedisReady({ ping: vi.fn().mockResolvedValue('PONG') }, 10),
    ).resolves.toBeUndefined();
    await expect(
      assertRateLimitRedisReady(
        { ping: vi.fn(() => new Promise<string>(() => undefined)) },
        10,
      ),
    ).rejects.toThrow(/PING timed out/);
  });
});
