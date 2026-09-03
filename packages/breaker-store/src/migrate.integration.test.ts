import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getMigrationManifest, runMigrations } from './migrate.js';

describe('migration integrity (Postgres integration)', () => {
  let container: StartedPostgreSqlContainer;
  const pools: pg.Pool[] = [];
  const directories: string[] = [];
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
  }, 120_000);

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    tearingDownPool = true;
    await container.stop();
    expect(poolErrors).toEqual([]);
  });

  async function isolatedPool(): Promise<pg.Pool> {
    const schema = `migration_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: container.getConnectionUri() });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    const pool = new pg.Pool({
      connectionString: container.getConnectionUri(),
      options: `-c search_path=${schema}`,
    });
    pool.on('error', (err) => {
      if (!tearingDownPool) poolErrors.push(err);
    });
    pools.push(pool);
    return pool;
  }

  function migrationDirectory(sql: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'fuse-migrations-'));
    directories.push(directory);
    writeFileSync(join(directory, '0001_probe.sql'), sql);
    return directory;
  }

  it('backfills a null legacy checksum once and makes future nulls impossible', async () => {
    const pool = await isolatedPool();
    const sql = 'CREATE TABLE migration_probe (id integer PRIMARY KEY);';
    const directory = migrationDirectory(sql);
    await pool.query(sql);
    await pool.query(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query("INSERT INTO schema_migrations (id) VALUES ('0001_probe.sql')");

    await expect(runMigrations(pool, directory)).resolves.toEqual([]);

    const ledger = await pool.query<{ id: string; checksum: string }>(
      'SELECT id, checksum FROM schema_migrations',
    );
    expect(ledger.rows).toEqual([getMigrationManifest(directory)[0]]);
    await expect(
      pool.query("INSERT INTO schema_migrations (id) VALUES ('legacy-null.sql')"),
    ).rejects.toMatchObject({ code: '23502' });
  });

  it('fails closed before executing when an applied migration file is altered', async () => {
    const pool = await isolatedPool();
    const directory = migrationDirectory(
      'CREATE TABLE migration_probe (id integer PRIMARY KEY);',
    );
    await runMigrations(pool, directory);
    writeFileSync(
      join(directory, '0001_probe.sql'),
      'CREATE TABLE migration_probe (id integer PRIMARY KEY, altered boolean);',
    );

    await expect(runMigrations(pool, directory)).rejects.toThrow(
      'checksum mismatch for 0001_probe.sql',
    );
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='migration_probe'
        ORDER BY ordinal_position`,
    );
    expect(columns.rows.map(({ column_name }) => column_name)).toEqual(['id']);
  });

  it('serializes concurrent runners and records one checksummed application', async () => {
    const pool = await isolatedPool();
    const directory = migrationDirectory(`
      SELECT pg_sleep(0.1);
      CREATE TABLE migration_probe (id integer PRIMARY KEY);
    `);

    const outcomes = await Promise.all([
      runMigrations(pool, directory),
      runMigrations(pool, directory),
    ]);

    expect(outcomes).toContainEqual(['0001_probe.sql']);
    expect(outcomes).toContainEqual([]);
    const ledger = await pool.query<{ id: string; checksum: string }>(
      'SELECT id, checksum FROM schema_migrations',
    );
    expect(ledger.rows).toEqual([getMigrationManifest(directory)[0]]);
  });
});
