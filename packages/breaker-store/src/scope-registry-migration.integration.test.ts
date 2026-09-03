import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const migrationSql = (name: string): string =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

describe('0003_scope_registry migration', () => {
  let container: StartedPostgreSqlContainer;
  let adminPool: pg.Pool;
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
    adminPool = new pg.Pool({ connectionString: container.getConnectionUri() });
    adminPool.on('error', (err) => {
      if (!tearingDownPool) poolErrors.push(err);
    });
  }, 120_000);

  afterAll(async () => {
    tearingDownPool = true;
    await adminPool.end();
    await container.stop();
    expect(poolErrors).toEqual([]);
  });

  it('backfills breaker and Preflight-only legacy scopes before validating foreign keys', async () => {
    const schema = `migration_${randomUUID().replaceAll('-', '')}`;
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const legacyPool = new pg.Pool({
      connectionString: container.getConnectionUri(),
      options: `-c search_path=${schema}`,
    });

    try {
      await legacyPool.query(migrationSql('0001_init.sql'));
      await legacyPool.query(migrationSql('0002_preflight.sql'));
      await legacyPool.query(`
        CREATE TABLE schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await legacyPool.query(
        `INSERT INTO schema_migrations (id) VALUES ('0001_init.sql'), ('0002_preflight.sql')`,
      );
      await legacyPool.query(
        `INSERT INTO breaker_state
           (tenant, environment, agent_id, state, epoch, reason, policy_version,
            cooldown_until, updated_at, updated_by_type, updated_by_id)
         VALUES
           ('legacy', 'prod', 'breaker-agent', 'armed', 0, 'existing',
            'legacy-v1', NULL, now(), 'manual', 'operator:legacy')`,
      );
      await legacyPool.query(
        `INSERT INTO preflight_state
           (tenant, environment, agent_id, state, reason_code, reason,
            evaluated_at, last_good_at, required_field_coverage_percent,
            orphan_rate_percent, freshness_ms, pending_recovery_state, pending_since)
         VALUES
           ('legacy', 'prod', 'preflight-only-agent', 'protected', 'healthy',
            'healthy telemetry', now(), now(), 100, 0, 0, NULL, NULL)`,
      );

      const concurrentRuns = await Promise.all([
        runMigrations(legacyPool),
        runMigrations(legacyPool),
      ]);
      expect(concurrentRuns).toContainEqual([
        '0003_scope_registry.sql',
        '0004_preflight_evidence_order.sql',
        '0005_diagnosis_jobs.sql',
        '0006_preflight_exporter_order.sql',
        '0007_diagnosis_job_replays.sql',
        '0008_preflight_source_evidence.sql',
      ]);
      expect(concurrentRuns).toContainEqual([]);

      const scopes = await legacyPool.query<{
        agent_id: string;
        policy_version: string;
      }>(
        `SELECT agent_id, policy_version
           FROM registered_scopes
          ORDER BY agent_id`,
      );
      expect(scopes.rows).toEqual([
        { agent_id: 'breaker-agent', policy_version: 'legacy-v1' },
        { agent_id: 'preflight-only-agent', policy_version: 'unversioned' },
      ]);

      const breakers = await legacyPool.query<{ agent_id: string; state: string }>(
        `SELECT agent_id, state FROM breaker_state ORDER BY agent_id`,
      );
      expect(breakers.rows).toEqual([
        { agent_id: 'breaker-agent', state: 'armed' },
        { agent_id: 'preflight-only-agent', state: 'armed' },
      ]);

      await expect(
        legacyPool.query(
          `INSERT INTO preflight_state
             (tenant, environment, agent_id, state, reason_code, reason,
              evaluated_at, required_field_coverage_percent, orphan_rate_percent)
           VALUES ('legacy', 'prod', 'not-registered', 'blind', 'no-signal',
                   'no signal', now(), 0, 0)`,
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await legacyPool.end();
      await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  });
});
