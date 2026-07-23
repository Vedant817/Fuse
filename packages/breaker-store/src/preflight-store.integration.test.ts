import { randomUUID } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFLIGHT_CONFIG,
  buildHealthyFixture,
  buildMissingFieldsFixture,
} from '@fuse/preflight';
import type { Scope } from '@fuse/contracts';
import { UnknownScopeError } from './errors.js';
import { runMigrations } from './migrate.js';
import { PreflightStore } from './preflight-store.js';
import { BreakerStore } from './store.js';

function scopeFor(name: string): Scope {
  return {
    tenant: 't1',
    environment: 'test',
    agentId: `agent-${name}-${randomUUID().slice(0, 8)}`,
  };
}

describe('PreflightStore (Postgres integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let store: PreflightStore;
  let breakerStore: BreakerStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool);
    store = new PreflightStore(pool);
    breakerStore = new BreakerStore(pool);
  }, 120_000);

  async function register(scope: Scope): Promise<Scope> {
    await breakerStore.registerScope({
      scope,
      policyVersion: 'test-policy-v1',
      actor: { type: 'manual', id: 'operator:test' },
      reason: 'Preflight integration test registration',
      correlationId: `register-${scope.agentId}`,
    });
    return scope;
  }

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('getResult returns null for a scope that has never been evaluated', async () => {
    const result = await store.getResult(scopeFor('never-evaluated'));
    expect(result).toBeNull();
  });

  it('persists a protected evaluation and returns it via getResult', async () => {
    const scope = await register(scopeFor('healthy'));
    const now = Date.now();
    const result = await store.evaluate({
      scope,
      spans: buildHealthyFixture(now),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(result.state).toBe('protected');

    const fetched = await store.getResult(scope);
    expect(fetched?.state).toBe('protected');
    expect(fetched?.lastGoodAt).toBe(result.lastGoodAt);
  });

  it('persists hysteresis state across separate evaluate() calls (recovery does not commit early)', async () => {
    const scope = await register(scopeFor('hysteresis'));
    const t0 = Date.now();

    const broken = await store.evaluate({
      scope,
      spans: buildMissingFieldsFixture(t0),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(broken.state).toBe('blind');

    // A second, separate evaluate() call shortly after: the store must
    // load the *previous* row back out to correctly hold the recovery
    // dwell — this is the whole point of persisting it rather than
    // re-evaluating statelessly each time.
    const soon = await store.evaluate({
      scope,
      spans: buildHealthyFixture(t0 + 5_000),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(soon.state).toBe('blind'); // still held
    expect(soon.reasonCode).toBe('recovering');
    expect(soon.pendingRecoveryState).toBe('protected');

    const fetched = await store.getResult(scope);
    expect(fetched?.state).toBe('blind');
    expect(fetched?.pendingRecoveryState).toBe('protected');
  });

  it('an operator-disabled evaluation is persisted and read back correctly', async () => {
    const scope = await register(scopeFor('disabled'));
    const result = await store.evaluate({
      scope,
      spans: buildHealthyFixture(Date.now()),
      config: DEFAULT_PREFLIGHT_CONFIG,
      disabled: true,
      disabledReason: 'planned maintenance',
    });
    expect(result.state).toBe('disabled');
    expect(result.reason).toBe('planned maintenance');

    const fetched = await store.getResult(scope);
    expect(fetched?.state).toBe('disabled');
  });

  it('a disabled scope stays disabled across an ordinary telemetry report that omits `disabled` entirely', async () => {
    // Regression: real agents (packages/sdk/src/preflight-reporter.ts)
    // never send `disabled` on routine reports. Before this fix, that
    // omission was treated as "evaluate normally," silently un-disabling
    // any scope an operator had just disabled.
    const scope = await register(scopeFor('disabled-stays-sticky'));
    const disabled = await store.evaluate({
      scope,
      spans: [],
      config: DEFAULT_PREFLIGHT_CONFIG,
      disabled: true,
      disabledReason: 'planned maintenance window',
    });
    expect(disabled.state).toBe('disabled');

    const routineReport = await store.evaluate({
      scope,
      spans: buildHealthyFixture(Date.now()),
      config: DEFAULT_PREFLIGHT_CONFIG,
      // no `disabled` field at all — an ordinary agent report
    });
    expect(routineReport.state).toBe('disabled');
    expect(routineReport.reason).toBe('planned maintenance window');

    const fetched = await store.getResult(scope);
    expect(fetched?.state).toBe('disabled');
  });

  it('an explicit `disabled: false` re-enables a previously-disabled scope', async () => {
    const scope = await register(scopeFor('disabled-explicit-reenable'));
    await store.evaluate({
      scope,
      spans: [],
      config: DEFAULT_PREFLIGHT_CONFIG,
      disabled: true,
      disabledReason: 'maintenance',
    });

    const reenabled = await store.evaluate({
      scope,
      spans: buildHealthyFixture(Date.now()),
      config: DEFAULT_PREFLIGHT_CONFIG,
      disabled: false,
    });
    expect(reenabled.state).toBe('protected');
  });

  it('rejects an unregistered report without creating Preflight state', async () => {
    const scope = scopeFor('unknown');
    await expect(
      store.evaluate({
        scope,
        spans: buildHealthyFixture(Date.now()),
        config: DEFAULT_PREFLIGHT_CONFIG,
      }),
    ).rejects.toThrow(UnknownScopeError);

    const persisted = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM preflight_state
        WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
      [scope.tenant, scope.environment, scope.agentId],
    );
    expect(persisted.rows[0]?.count).toBe('0');
  });
});
