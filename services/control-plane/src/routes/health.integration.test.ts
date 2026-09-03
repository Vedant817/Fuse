import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { runMigrations } from '@fuse/breaker-store';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerHealthRoutes } from './health.js';
import { REQUIRED_MIGRATIONS, REQUIRED_MIGRATION_MANIFEST } from './health.js';

describe('schema readiness (Postgres integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let app: FastifyInstance;
  // node-postgres emits 'error' on idle clients whose backend the server
  // terminates; without a listener that is an uncaught exception. Record
  // mid-test errors so the suite still fails loudly, but stop recording at
  // teardown where container SIGTERM (57P01) after pool.end() is benign.
  let tearingDownPool = false;
  const poolErrors: unknown[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', (err) => {
      if (!tearingDownPool) poolErrors.push(err);
    });
    await runMigrations(pool);
    app = Fastify({ logger: false });
    registerHealthRoutes(app, pool);
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    tearingDownPool = true;
    await app.close();
    await pool.end();
    await container.stop();
    expect(poolErrors).toEqual([]);
  });

  it('is ready after every required migration has completed', async () => {
    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  it('becomes unready when the migration ledger is stale despite connectivity', async () => {
    const latestMigration = REQUIRED_MIGRATIONS.at(-1)!;
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [latestMigration]);
    try {
      const response = await app.inject({ method: 'GET', url: '/readyz' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: 'not-ready',
        reason: 'schema_not_ready',
      });
    } finally {
      const checksum = REQUIRED_MIGRATION_MANIFEST.find(
        ({ id }) => id === latestMigration,
      )!.checksum;
      await pool.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [
        latestMigration,
        checksum,
      ]);
    }
  });

  it('becomes unready when an applied migration checksum differs from the build', async () => {
    const migration = REQUIRED_MIGRATIONS[0]!;
    const expectedChecksum = REQUIRED_MIGRATION_MANIFEST[0]!.checksum;
    await pool.query('UPDATE schema_migrations SET checksum=$2 WHERE id=$1', [
      migration,
      '0'.repeat(64),
    ]);
    try {
      const response = await app.inject({ method: 'GET', url: '/readyz' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: 'not-ready',
        reason: 'schema_not_ready',
      });
    } finally {
      await pool.query('UPDATE schema_migrations SET checksum=$2 WHERE id=$1', [
        migration,
        expectedChecksum,
      ]);
    }
  });
});
