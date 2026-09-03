import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import {
  PreflightStore,
  preflightActiveSourceTtlMs,
  preflightSourceRetentionMs,
} from './preflight-store.js';
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

  function delivered(
    observedAtMs: number,
    sequence = 1,
    sourceInstanceId = 'store-test-process',
  ) {
    return { status: 'success' as const, observedAtMs, sourceInstanceId, sequence };
  }

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('getResult returns null for a scope that has never been evaluated', async () => {
    const result = await store.getResult(scopeFor('never-evaluated'));
    expect(result).toBeNull();
  });

  it('safely backfills ordering metadata without trusting historical negative freshness', async () => {
    const schema = `preflight_migration_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE SCHEMA ${schema}`);
    const legacyPool = new pg.Pool({
      connectionString: container.getConnectionUri(),
      options: `-c search_path=${schema}`,
    });
    const evaluatedAt = '2026-07-21T00:00:00.000Z';
    try {
      await legacyPool.query(
        readFileSync(
          new URL('../migrations/0002_preflight.sql', import.meta.url),
          'utf8',
        ),
      );
      await legacyPool.query(
        `INSERT INTO preflight_state
           (tenant, environment, agent_id, state, reason_code, reason, evaluated_at,
            required_field_coverage_percent, orphan_rate_percent, freshness_ms)
         VALUES
           ('legacy', 'prod', 'normal', 'protected', 'healthy', 'healthy', $1, 100, 0, 500),
           ('legacy', 'prod', 'future', 'protected', 'healthy', 'historically future', $1, 100, 0, -500)`,
        [evaluatedAt],
      );
      await legacyPool.query(
        readFileSync(
          new URL('../migrations/0004_preflight_evidence_order.sql', import.meta.url),
          'utf8',
        ),
      );
      await legacyPool.query(
        readFileSync(
          new URL('../migrations/0006_preflight_exporter_order.sql', import.meta.url),
          'utf8',
        ),
      );

      const rows = await legacyPool.query<{
        agent_id: string;
        evidence_watermark_ms: string | null;
        evidence_version: string;
        exporter_source_instance_id: string | null;
      }>(
        `SELECT agent_id, evidence_watermark_ms, evidence_version,
                exporter_source_instance_id
           FROM preflight_state ORDER BY agent_id`,
      );
      expect(rows.rows).toEqual([
        {
          agent_id: 'future',
          evidence_watermark_ms: null,
          evidence_version: '1',
          exporter_source_instance_id: null,
        },
        {
          agent_id: 'normal',
          evidence_watermark_ms: String(Date.parse(evaluatedAt) - 500),
          evidence_version: '1',
          exporter_source_instance_id: null,
        },
      ]);
    } finally {
      await legacyPool.end();
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  });

  it('persists a protected evaluation and returns it via getResult', async () => {
    const scope = await register(scopeFor('healthy'));
    const now = Date.now();
    const result = await store.evaluate({
      scope,
      spans: buildHealthyFixture(now),
      exporterDelivery: delivered(now),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(result.state).toBe('protected');

    const fetched = await store.getResult(scope);
    expect(fetched?.state).toBe('protected');
    expect(fetched?.lastGoodAt).toBe(result.lastGoodAt);
  });

  it('does not let future span timestamps claim health', async () => {
    const scope = await register(scopeFor('future-evidence'));
    const result = await store.evaluate({
      scope,
      spans: buildHealthyFixture(Date.now() + 60_000),
      heartbeat: { lastSeenAtMs: Date.now() + 60_000 },
      exporterDelivery: delivered(Date.now() + 60_000),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(result.state).toBe('blind');
    expect(result.reasonCode).toBe('no-signal');
    expect(result.freshnessMs).toBeNull();

    const persisted = await pool.query<{
      evidence_watermark_ms: string | null;
      evidence_version: string;
    }>(
      `SELECT evidence_watermark_ms, evidence_version FROM preflight_state
        WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
      [scope.tenant, scope.environment, scope.agentId],
    );
    expect(persisted.rows[0]).toEqual({
      evidence_watermark_ms: expect.any(String),
      evidence_version: '1',
    });
  });

  it('atomically replays a delayed older report instead of overwriting newer state', async () => {
    const scope = await register(scopeFor('out-of-order'));
    const newerEvidenceAt = Date.now() - 1_000;
    const newer = await store.evaluate({
      scope,
      spans: buildMissingFieldsFixture(newerEvidenceAt),
      exporterDelivery: delivered(newerEvidenceAt, 2),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(newer.state).toBe('blind');

    const delayedOlder = await store.evaluate({
      scope,
      spans: buildHealthyFixture(newerEvidenceAt - 60_000),
      exporterDelivery: delivered(newerEvidenceAt - 60_000, 1),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(delayedOlder).toEqual(newer);

    const persisted = await pool.query<{
      state: string;
      evidence_watermark_ms: string | null;
      evidence_version: string;
    }>(
      `SELECT state, evidence_watermark_ms, evidence_version FROM preflight_state
        WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
      [scope.tenant, scope.environment, scope.agentId],
    );
    expect(persisted.rows[0]).toEqual({
      state: 'blind',
      evidence_watermark_ms: String(newerEvidenceAt),
      evidence_version: '1',
    });
  });

  it('does not let an unconfirmed local no-signal report replace accepted exporter evidence', async () => {
    const scope = await register(scopeFor('unwatermarked-degradation'));
    const evidenceAt = Date.now() - 1_000;
    const healthy = await store.evaluate({
      scope,
      spans: buildHealthyFixture(evidenceAt),
      exporterDelivery: delivered(evidenceAt),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(healthy.state).toBe('protected');

    const noSignal = await store.evaluate({
      scope,
      spans: [],
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(noSignal).toEqual(healthy);

    const persisted = await pool.query<{
      evidence_watermark_ms: string | null;
      evidence_version: string;
    }>(
      `SELECT evidence_watermark_ms, evidence_version FROM preflight_state
        WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
      [scope.tenant, scope.environment, scope.agentId],
    );
    expect(persisted.rows[0]).toEqual({
      evidence_watermark_ms: String(evidenceAt),
      evidence_version: '1',
    });
  });

  it('persists hysteresis state across separate evaluate() calls (recovery does not commit early)', async () => {
    const scope = await register(scopeFor('hysteresis'));
    let nowMs = Date.now();
    const t0 = nowMs;
    const hysteresisStore = new PreflightStore(pool, () => new Date(nowMs));

    const broken = await hysteresisStore.evaluate({
      scope,
      spans: buildMissingFieldsFixture(t0),
      exporterDelivery: delivered(t0),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(broken.state).toBe('blind');

    // A second, separate evaluate() call shortly after: the store must
    // load the *previous* row back out to correctly hold the recovery
    // dwell — this is the whole point of persisting it rather than
    // re-evaluating statelessly each time.
    nowMs = t0 + 5_000;
    const soon = await hysteresisStore.evaluate({
      scope,
      spans: buildHealthyFixture(t0 + 5_000),
      exporterDelivery: delivered(t0 + 5_000, 2),
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
      exporterDelivery: delivered(Date.now(), 2),
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
      exporterDelivery: delivered(Date.now()),
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
      exporterDelivery: delivered(Date.now()),
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
        exporterDelivery: delivered(Date.now()),
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

  it('deduplicates an open self-alert and emits one recovery after dwell', async () => {
    const scope = await register(scopeFor('self-alert-transition'));
    let nowMs = Date.now();
    const transitionStore = new PreflightStore(pool, () => new Date(nowMs));

    const opened = await transitionStore.evaluateWithTransition({
      scope,
      spans: buildHealthyFixture(nowMs),
      exporterDelivery: {
        status: 'failure',
        observedAtMs: nowMs,
        sourceInstanceId: 'alert-process',
        sequence: 1,
      },
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(opened.selfAlertTransition?.kind).toBe('opened');

    nowMs += 1_000;
    const duplicate = await transitionStore.evaluateWithTransition({
      scope,
      spans: buildHealthyFixture(nowMs),
      exporterDelivery: {
        status: 'failure',
        observedAtMs: nowMs,
        sourceInstanceId: 'alert-process',
        sequence: 2,
      },
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(duplicate.selfAlertTransition).toBeNull();

    nowMs += 1_000;
    const recovering = await transitionStore.evaluateWithTransition({
      scope,
      spans: buildHealthyFixture(nowMs),
      exporterDelivery: delivered(nowMs, 3, 'alert-process'),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(recovering.result.reasonCode).toBe('recovering');
    expect(recovering.selfAlertTransition).toBeNull();

    nowMs += DEFAULT_PREFLIGHT_CONFIG.minRecoveryDwellMs + 1;
    const recovered = await transitionStore.evaluateWithTransition({
      scope,
      spans: buildHealthyFixture(nowMs),
      exporterDelivery: delivered(nowMs, 4, 'alert-process'),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(recovered.result.state).toBe('protected');
    expect(recovered.selfAlertTransition?.kind).toBe('recovered');
  });

  it('orders restart evidence deterministically and keeps failure on equal timestamps', async () => {
    const scope = await register(scopeFor('restart-order'));
    const now = Date.now() - 1_000;
    const first = await store.evaluate({
      scope,
      spans: buildHealthyFixture(now),
      exporterDelivery: delivered(now, 99, 'old-process'),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(first.state).toBe('protected');

    const restartedFailure = await store.evaluate({
      scope,
      spans: buildHealthyFixture(now + 1),
      exporterDelivery: {
        status: 'failure',
        observedAtMs: now + 1,
        sourceInstanceId: 'new-process',
        sequence: 1,
      },
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(restartedFailure.reasonCode).toBe('exporter-delivery-failed');

    const delayedOldProcess = await store.evaluate({
      scope,
      spans: buildHealthyFixture(now),
      exporterDelivery: delivered(now, 100, 'old-process'),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(delayedOldProcess.state).toBe(restartedFailure.state);
    expect(delayedOldProcess.reasonCode).toBe(restartedFailure.reasonCode);

    const equalTimeSuccess = await store.evaluate({
      scope,
      spans: buildHealthyFixture(now + 1),
      exporterDelivery: delivered(now + 1, 1, 'third-process'),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(equalTimeSuccess.state).toBe(restartedFailure.state);
    expect(equalTimeSuccess.reasonCode).toBe(restartedFailure.reasonCode);
  });

  it('revalidates only persisted evidence and cannot overwrite a racing newer failure', async () => {
    const scope = await register(scopeFor('revalidate-race'));
    let nowMs = Date.now() - 1_000;
    const raceStore = new PreflightStore(pool, () => new Date(nowMs));
    await raceStore.evaluate({
      scope,
      spans: buildHealthyFixture(nowMs),
      exporterDelivery: delivered(nowMs, 1, 'race-process'),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });

    nowMs += 1;
    await Promise.all([
      raceStore.evaluate({
        scope,
        spans: [],
        revalidate: true,
        config: DEFAULT_PREFLIGHT_CONFIG,
      }),
      raceStore.evaluate({
        scope,
        spans: buildHealthyFixture(nowMs),
        exporterDelivery: {
          status: 'failure',
          observedAtMs: nowMs,
          sourceInstanceId: 'race-process',
          sequence: 2,
        },
        config: DEFAULT_PREFLIGHT_CONFIG,
      }),
    ]);

    const final = await raceStore.getResult(scope);
    expect(final?.state).toBe('blind');
    expect(final?.reasonCode).toBe('exporter-delivery-failed');
    const persisted = await pool.query<{
      exporter_source_instance_id: string;
      exporter_sequence: string;
      exporter_status: string;
    }>(
      `SELECT exporter_source_instance_id, exporter_sequence, exporter_status
         FROM preflight_state
        WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
      [scope.tenant, scope.environment, scope.agentId],
    );
    expect(persisted.rows[0]).toEqual({
      exporter_source_instance_id: 'race-process',
      exporter_sequence: '2',
      exporter_status: 'failure',
    });

    nowMs += DEFAULT_PREFLIGHT_CONFIG.maxEvidenceStalenessMs + 1;
    const attemptedHeartbeatBypass = await raceStore.evaluate({
      scope,
      spans: [],
      heartbeat: { lastSeenAtMs: nowMs },
      revalidate: true,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(attemptedHeartbeatBypass.reasonCode).toBe('exporter-delivery-failed');
  });

  it('revalidation makes the exact persisted success stale without caller replay', async () => {
    const scope = await register(scopeFor('revalidate-stale'));
    let nowMs = Date.now();
    const revalidationStore = new PreflightStore(pool, () => new Date(nowMs));
    const protectedResult = await revalidationStore.evaluate({
      scope,
      spans: buildHealthyFixture(nowMs),
      exporterDelivery: delivered(nowMs, 1, 'stale-process'),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(protectedResult.state).toBe('protected');

    nowMs += DEFAULT_PREFLIGHT_CONFIG.maxEvidenceStalenessMs + 1;
    const stale = await revalidationStore.evaluate({
      scope,
      spans: [],
      revalidate: true,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(stale.state).toBe('blind');
    expect(stale.reasonCode).toBe('stale-evidence');
  });

  it('autonomous bounded sweep revokes protected after reporter death', async () => {
    const scope = await register(scopeFor('reporter-death'));
    const databaseNow = await pool.query<{ now_ms: string }>(
      'SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint::text AS now_ms',
    );
    const nowMs = Number(databaseNow.rows[0]!.now_ms);
    const config = {
      ...DEFAULT_PREFLIGHT_CONFIG,
      maxEvidenceStalenessMs: 100,
    };
    const protectedResult = await store.evaluate({
      scope,
      spans: buildHealthyFixture(nowMs).map((span) => ({ ...span, timestampMs: nowMs })),
      exporterDelivery: delivered(nowMs, 1, 'dead-process'),
      config,
    });
    expect(protectedResult.state).toBe('protected');

    await new Promise((resolve) => setTimeout(resolve, 150));
    const swept = await store.sweepStale(config, 1_000);
    const outcome = swept.find(
      (candidate) => candidate.result.scope.agentId === scope.agentId,
    );
    expect(outcome?.result.state).toBe('blind');
    expect(outcome?.selfAlertTransition?.kind).toBe('opened');
    expect((await store.getResult(scope))?.state).toBe('blind');
  });

  it('aggregates active sources conservatively so a healthy peer cannot mask failure', async () => {
    const scope = await register(scopeFor('two-sources'));
    let nowMs = Date.now();
    const aggregateStore = new PreflightStore(pool, () => new Date(nowMs));
    await aggregateStore.evaluate({
      scope,
      spans: buildHealthyFixture(nowMs),
      exporterDelivery: delivered(nowMs, 1, 'healthy-process'),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    nowMs += 1;
    const failedPeer = await aggregateStore.evaluateWithTransition({
      scope,
      spans: buildHealthyFixture(nowMs),
      exporterDelivery: {
        status: 'failure',
        observedAtMs: nowMs,
        sourceInstanceId: 'failing-process',
        sequence: 1,
      },
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(failedPeer.result.reasonCode).toBe('exporter-delivery-failed');
    expect(failedPeer.selfAlertTransition?.kind).toBe('opened');

    nowMs += 1;
    const healthyAgain = await aggregateStore.evaluateWithTransition({
      scope,
      spans: buildHealthyFixture(nowMs),
      exporterDelivery: delivered(nowMs, 2, 'healthy-process'),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(healthyAgain.result.state).toBe('blind');
    expect(healthyAgain.result.reasonCode).toBe('exporter-delivery-failed');
    expect(healthyAgain.selfAlertTransition).toBeNull();

    nowMs += 1;
    const recovering = await aggregateStore.evaluateWithTransition({
      scope,
      spans: buildHealthyFixture(nowMs),
      exporterDelivery: delivered(nowMs, 2, 'failing-process'),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(recovering.result.reasonCode).toBe('recovering');
    expect(recovering.selfAlertTransition).toBeNull();

    nowMs += DEFAULT_PREFLIGHT_CONFIG.minRecoveryDwellMs + 1;
    const recovered = await aggregateStore.evaluateWithTransition({
      scope,
      spans: buildHealthyFixture(nowMs),
      exporterDelivery: delivered(nowMs, 3, 'failing-process'),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(recovered.result.state).toBe('protected');
    expect(recovered.selfAlertTransition?.kind).toBe('recovered');

    const sources = await pool.query<{ source_instance_id: string }>(
      `SELECT source_instance_id FROM preflight_source_evidence
        WHERE tenant=$1 AND environment=$2 AND agent_id=$3
        ORDER BY source_instance_id`,
      [scope.tenant, scope.environment, scope.agentId],
    );
    expect(sources.rows.map((row) => row.source_instance_id)).toEqual([
      'failing-process',
      'healthy-process',
    ]);
  });

  it('never uses cross-source wall clocks to supersede a failing peer', async () => {
    const scope = await register(scopeFor('cross-source-clock-skew'));
    let nowMs = Date.now();
    const aggregateStore = new PreflightStore(pool, () => new Date(nowMs));
    await aggregateStore.evaluate({
      scope,
      spans: buildHealthyFixture(nowMs),
      exporterDelivery: {
        status: 'failure',
        observedAtMs: 1,
        sourceInstanceId: 'slow-clock',
        sequence: 1,
      },
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    nowMs += 1;
    const futureClockPeer = await aggregateStore.evaluate({
      scope,
      spans: buildHealthyFixture(nowMs),
      exporterDelivery: delivered(nowMs + 24 * 60 * 60_000, 1, 'future-clock'),
      config: DEFAULT_PREFLIGHT_CONFIG,
    });

    expect(futureClockPeer.state).toBe('blind');
    expect(futureClockPeer.reasonCode).toBe('exporter-delivery-failed');
  });

  it('caps replica-safe source cleanup and retains active and safety-window evidence', async () => {
    const scope = await register(scopeFor('source-retention'));
    const now = Date.now();
    const sourceIds = [
      'active-source',
      'inactive-within-retention',
      'expired-restart-1',
      'expired-restart-2',
      'expired-restart-3',
      'expired-restart-4',
      'expired-restart-5',
    ];
    for (const [index, sourceInstanceId] of sourceIds.entries()) {
      await store.evaluate({
        scope,
        spans: buildHealthyFixture(now),
        exporterDelivery: delivered(now, index + 1, sourceInstanceId),
        config: DEFAULT_PREFLIGHT_CONFIG,
      });
    }

    const activeTtlMs = preflightActiveSourceTtlMs(DEFAULT_PREFLIGHT_CONFIG);
    const retentionMs = preflightSourceRetentionMs(DEFAULT_PREFLIGHT_CONFIG);
    expect(retentionMs).toBeGreaterThan(activeTtlMs);
    await pool.query(
      `UPDATE preflight_source_evidence
          SET received_at = clock_timestamp()
                            - ($4::double precision * interval '1 millisecond')
        WHERE tenant=$1 AND environment=$2 AND agent_id=$3
          AND source_instance_id='inactive-within-retention'`,
      [scope.tenant, scope.environment, scope.agentId, activeTtlMs + 1],
    );
    await pool.query(
      `UPDATE preflight_source_evidence
          SET received_at = clock_timestamp()
                            - ($4::double precision * interval '1 millisecond')
        WHERE tenant=$1 AND environment=$2 AND agent_id=$3
          AND source_instance_id LIKE 'expired-restart-%'`,
      [scope.tenant, scope.environment, scope.agentId, retentionMs + 1_000],
    );

    const replicaPool = new pg.Pool({ connectionString: container.getConnectionUri() });
    const replicaStore = new PreflightStore(replicaPool);
    try {
      const deletedByReplicas = await Promise.all([
        store.deleteInactiveSourceEvidence(DEFAULT_PREFLIGHT_CONFIG, 2),
        replicaStore.deleteInactiveSourceEvidence(DEFAULT_PREFLIGHT_CONFIG, 2),
      ]);
      expect(deletedByReplicas).toEqual([2, 2]);

      const afterOnePassEach = await pool.query<{ source_instance_id: string }>(
        `SELECT source_instance_id FROM preflight_source_evidence
          WHERE tenant=$1 AND environment=$2 AND agent_id=$3
          ORDER BY source_instance_id`,
        [scope.tenant, scope.environment, scope.agentId],
      );
      expect(afterOnePassEach.rows).toHaveLength(3);
      expect(
        afterOnePassEach.rows.map(({ source_instance_id }) => source_instance_id),
      ).toEqual(expect.arrayContaining(['active-source', 'inactive-within-retention']));

      await store.sweepStale(DEFAULT_PREFLIGHT_CONFIG, 2);
      const retained = await pool.query<{ source_instance_id: string }>(
        `SELECT source_instance_id FROM preflight_source_evidence
          WHERE tenant=$1 AND environment=$2 AND agent_id=$3
          ORDER BY source_instance_id`,
        [scope.tenant, scope.environment, scope.agentId],
      );
      expect(retained.rows.map(({ source_instance_id }) => source_instance_id)).toEqual([
        'active-source',
        'inactive-within-retention',
      ]);
    } finally {
      await replicaPool.end();
    }
  });
});
