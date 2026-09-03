import { randomUUID } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Scope } from '@fuse/contracts';
import { DiagnosisJobStore } from './diagnosis-job-store.js';
import { getMigrationManifest, runMigrations } from './migrate.js';
import { BreakerStore } from './store.js';

describe('DiagnosisJobStore (Postgres integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let breakerStore: BreakerStore;
  let jobs: DiagnosisJobStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool);
    breakerStore = new BreakerStore(pool);
    jobs = new DiagnosisJobStore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM diagnosis_job_replay_audit');
    await pool.query('DELETE FROM diagnosis_jobs');
  });

  async function createJob(
    name: string,
    notifySlack = true,
    tenant = 'diagnosis-test',
  ): Promise<{ auditEventId: string; scope: Scope }> {
    const scope = {
      tenant,
      environment: 'integration',
      agentId: `${name}-${randomUUID().slice(0, 8)}`,
    };
    await breakerStore.registerScope({
      scope,
      policyVersion: 'diagnosis-policy-v1',
      actor: { type: 'manual', id: 'test:setup' },
      reason: 'diagnosis integration setup',
      correlationId: `register-${scope.agentId}`,
    });
    const result = await breakerStore.trip(
      {
        scope,
        reason: 'structural loop detector fired',
        policyVersion: 'diagnosis-policy-v1',
        cooldownSeconds: 60,
        actor: { type: 'system', id: 'system:detector:loop-signature' },
        correlationId: `incident-${scope.agentId}`,
        idempotencyKey: `incident-${scope.agentId}`,
      },
      {
        detector: 'loop-signature',
        startsAt: '2026-08-24T10:00:00.000Z',
        notifySlack,
      },
    );
    if (result.kind !== 'applied') throw new Error('trip unexpectedly rejected');
    return { auditEventId: result.auditEvent.id, scope };
  }

  it('requires the complete diagnosis and replay schema migration ledger at startup', async () => {
    await expect(jobs.assertReady()).resolves.toBeUndefined();
    await pool.query(`DELETE FROM schema_migrations WHERE id='0005_diagnosis_jobs.sql'`);
    try {
      await expect(jobs.assertReady()).rejects.toThrow(/0005_diagnosis_jobs/);
    } finally {
      const checksum = getMigrationManifest().find(
        ({ id }) => id === '0005_diagnosis_jobs.sql',
      )!.checksum;
      await pool.query(
        `INSERT INTO schema_migrations (id, checksum)
         VALUES ('0005_diagnosis_jobs.sql', $1)`,
        [checksum],
      );
    }
  });

  it('atomically creates exactly one job for the real trip audit and none for duplicate/no-op audits', async () => {
    const scope = {
      tenant: 'diagnosis-test',
      environment: 'integration',
      agentId: `duplicate-${randomUUID().slice(0, 8)}`,
    };
    await breakerStore.registerScope({
      scope,
      policyVersion: 'v1',
      actor: { type: 'manual', id: 'test:setup' },
      reason: 'setup',
      correlationId: 'register-duplicate',
    });
    const request = {
      scope,
      reason: 'loop',
      policyVersion: 'v1',
      cooldownSeconds: 60,
      actor: { type: 'system' as const, id: 'system:detector:loop-signature' },
      correlationId: `incident-${randomUUID()}`,
      idempotencyKey: `incident-${randomUUID()}`,
    };
    const spec = {
      detector: 'loop-signature',
      startsAt: '2026-08-24T10:00:00.000Z',
      notifySlack: true,
      measurement: {
        detectorVersion: 'loop-signature-v1',
        score: 7,
        threshold: 4,
        windowEnd: '2026-08-24T10:01:00.000Z',
      },
    };
    const first = await breakerStore.trip(request, spec);
    const replay = await breakerStore.trip(request, spec);
    const noop = await breakerStore.trip(
      {
        ...request,
        correlationId: `noop-${randomUUID()}`,
        idempotencyKey: `noop-${randomUUID()}`,
      },
      spec,
    );
    if (
      first.kind !== 'applied' ||
      replay.kind !== 'applied' ||
      noop.kind !== 'applied'
    ) {
      throw new Error('trip unexpectedly rejected');
    }
    expect(replay.replayed).toBe(true);
    expect(noop.noop).toBe(true);

    const persisted = await pool.query<{ jobs: string; audits: string }>(
      `SELECT
         (SELECT count(*)::text FROM diagnosis_jobs j
           JOIN breaker_audit_log a ON a.id=j.audit_event_id
          WHERE a.tenant=$1 AND a.environment=$2 AND a.agent_id=$3) AS jobs,
         (SELECT count(*)::text FROM breaker_audit_log
          WHERE tenant=$1 AND environment=$2 AND agent_id=$3) AS audits`,
      [scope.tenant, scope.environment, scope.agentId],
    );
    expect(persisted.rows[0]).toEqual({ jobs: '1', audits: '2' });
    const job = await jobs.get(first.auditEvent.id);
    expect(job).toMatchObject({
      auditEventId: first.auditEvent.id,
      scope,
      detector: 'loop-signature',
      measurement: spec.measurement,
      reason: 'loop',
      tripEpoch: 1,
      notifySlack: true,
      status: 'pending',
      attempts: 0,
    });
  });

  it('creates a non-Slack structural job for an operational trip without detector metadata', async () => {
    const scope = {
      tenant: 'diagnosis-test',
      environment: 'integration',
      agentId: `manual-${randomUUID().slice(0, 8)}`,
    };
    await breakerStore.registerScope({
      scope,
      policyVersion: 'v1',
      actor: { type: 'manual', id: 'test:setup' },
      reason: 'setup',
      correlationId: 'register-manual',
    });
    const trip = await breakerStore.trip({
      scope,
      reason: 'operator containment',
      policyVersion: 'v1',
      cooldownSeconds: 0,
      actor: { type: 'manual', id: 'operator:alice' },
      correlationId: `manual-${randomUUID()}`,
      idempotencyKey: `manual-${randomUUID()}`,
    });
    if (trip.kind !== 'applied') throw new Error('trip unexpectedly rejected');
    expect(await jobs.get(trip.auditEvent.id)).toMatchObject({
      detector: 'unknown',
      notifySlack: false,
    });
  });

  it('rejects invalid job metadata before the breaker can commit', async () => {
    const scope = {
      tenant: 'diagnosis-test',
      environment: 'integration',
      agentId: `atomic-failure-${randomUUID().slice(0, 8)}`,
    };
    await breakerStore.registerScope({
      scope,
      policyVersion: 'v1',
      actor: { type: 'manual', id: 'test:setup' },
      reason: 'setup',
      correlationId: 'register-atomic-failure',
    });
    await expect(
      breakerStore.trip(
        {
          scope,
          reason: 'loop',
          policyVersion: 'v1',
          cooldownSeconds: 60,
          actor: { type: 'system', id: 'system:detector:loop-signature' },
          correlationId: 'invalid-job',
          idempotencyKey: 'invalid-job',
        },
        { detector: 'loop-signature', startsAt: 'not-a-date', notifySlack: true },
      ),
    ).rejects.toThrow(/startsAt/);
    expect((await breakerStore.getRecord(scope))?.state).toBe('armed');
  });

  it('lets two replicas claim disjoint jobs with bounded batches', async () => {
    const created = await Promise.all(
      Array.from({ length: 6 }, (_, index) => createJob(`replica-${index}`)),
    );
    const [first, second] = await Promise.all([
      jobs.claim('worker-a', 3, 10_000, 5),
      jobs.claim('worker-b', 3, 10_000, 5),
    ]);
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    const claimedIds = new Set([...first, ...second].map((job) => job.auditEventId));
    expect(claimedIds).toEqual(new Set(created.map((job) => job.auditEventId)));
  });

  it('recovers an abandoned lease after restart and rejects the stale owner completion', async () => {
    const created = await createJob('restart');
    const first = await jobs.claim('crashed-worker', 1, 25, 3);
    expect(first[0]?.auditEventId).toBe(created.auditEventId);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(jobs.complete(created.auditEventId, 'crashed-worker')).resolves.toBe(
      false,
    );

    const restartedPool = new pg.Pool({ connectionString: container.getConnectionUri() });
    try {
      const restartedStore = new DiagnosisJobStore(restartedPool);
      const reclaimed = await restartedStore.claim('replacement-worker', 1, 10_000, 3);
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]).toMatchObject({
        auditEventId: created.auditEventId,
        leasedBy: 'replacement-worker',
        attempts: 2,
      });
      await expect(jobs.complete(created.auditEventId, 'crashed-worker')).resolves.toBe(
        false,
      );
      await expect(
        restartedStore.complete(created.auditEventId, 'replacement-worker'),
      ).resolves.toBe(true);
    } finally {
      await restartedPool.end();
    }
  });

  it('renews only a live owned lease and prevents a second worker from reclaiming it', async () => {
    const created = await createJob('renewed-lease');
    await jobs.claim('active-worker', 1, 80, 3);
    await new Promise((resolve) => setTimeout(resolve, 45));
    await expect(
      jobs.renewLease(created.auditEventId, 'active-worker', 100),
    ).resolves.toBe(true);
    await expect(
      jobs.renewLease(created.auditEventId, 'different-worker', 100),
    ).resolves.toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 55));

    await expect(jobs.claim('second-worker', 1, 100, 3)).resolves.toEqual([]);
    await expect(jobs.complete(created.auditEventId, 'active-worker')).resolves.toBe(
      true,
    );
    await expect(
      jobs.renewLease(created.auditEventId, 'active-worker', 100),
    ).resolves.toBe(false);
  });

  it('retries with delayed availability and dead-letters at the bounded attempt limit', async () => {
    const created = await createJob('dead-letter');
    const first = await jobs.claim('retry-worker', 1, 10_000, 2);
    expect(first[0]?.attempts).toBe(1);
    await expect(
      jobs.fail(created.auditEventId, 'retry-worker', 'Slack unavailable', 25, 2),
    ).resolves.toBe('retry');
    expect(await jobs.claim('retry-worker', 1, 10_000, 2)).toEqual([]);
    let second: Awaited<ReturnType<DiagnosisJobStore['claim']>> = [];
    await expect
      .poll(
        async () => {
          second = await jobs.claim('retry-worker', 1, 10_000, 2);
          return second.length;
        },
        { timeout: 2_000, interval: 5 },
      )
      .toBe(1);
    expect(second[0]?.attempts).toBe(2);
    await expect(
      jobs.fail(created.auditEventId, 'retry-worker', 'x'.repeat(2_000), 0, 2),
    ).resolves.toBe('dead-letter');
    expect(await jobs.get(created.auditEventId)).toMatchObject({
      status: 'dead-letter',
      attempts: 2,
      lastError: 'x'.repeat(1_000),
    });
    const permit = await breakerStore.permit(
      created.scope,
      'enforcement-remains-independent',
    );
    expect(permit).toMatchObject({ allowed: false, state: 'tripped' });
  });

  it('lists tenant-isolated filtered jobs with stable bounded cursor pagination', async () => {
    const own = await Promise.all(
      Array.from({ length: 5 }, (_, index) => createJob(`page-${index}`)),
    );
    await createJob('other-tenant', true, 'different-tenant');
    const claimed = await jobs.claim('pagination-worker', 1, 10_000, 3);
    expect(claimed).toHaveLength(1);

    const first = await jobs.list({ tenant: 'diagnosis-test', limit: 2 });
    const second = await jobs.list({
      tenant: 'diagnosis-test',
      limit: 2,
      cursor: first.nextCursor!,
    });
    const third = await jobs.list({
      tenant: 'diagnosis-test',
      limit: 2,
      cursor: second.nextCursor!,
    });
    const ids = [...first.jobs, ...second.jobs, ...third.jobs].map(
      ({ auditEventId }) => auditEventId,
    );
    expect(new Set(ids)).toEqual(new Set(own.map(({ auditEventId }) => auditEventId)));
    expect(ids).toHaveLength(5);
    expect(third.nextCursor).toBeNull();

    const running = await jobs.list({
      tenant: 'diagnosis-test',
      status: 'running',
      environment: 'integration',
      agentId: claimed[0]!.scope.agentId,
      limit: 100,
    });
    expect(running.jobs).toHaveLength(1);
    expect(running.jobs[0]?.status).toBe('running');
    await expect(jobs.list({ tenant: 'diagnosis-test', limit: 101 })).rejects.toThrow(
      /limit/,
    );
  });

  it('reports queue counts without tenant or job dimensions', async () => {
    const pending = await createJob('count-pending');
    const running = await createJob('count-running');
    const dead = await createJob('count-dead');
    await jobs.claim('count-worker', 2, 10_000, 1);
    // Identify claimed rows rather than depending on UUID ordering.
    const claimedRows = await Promise.all(
      [pending, running, dead].map(({ auditEventId }) => jobs.get(auditEventId)),
    );
    const claimed = claimedRows.filter((job) => job?.status === 'running');
    expect(claimed).toHaveLength(2);
    await jobs.fail(claimed[0]!.auditEventId, 'count-worker', 'failed', 0, 1);
    expect(await jobs.countQueue()).toEqual({
      pending: 1,
      running: 1,
      'dead-letter': 1,
    });
  });

  it('replays a dead-letter exactly once with immutable operator attribution', async () => {
    const created = await createJob('replay');
    await jobs.claim('replay-worker', 1, 10_000, 1);
    await jobs.fail(created.auditEventId, 'replay-worker', 'permanent failure', 0, 1);
    const request = {
      auditEventId: created.auditEventId,
      scope: created.scope,
      actor: { type: 'manual' as const, id: 'operator:alice' },
      reason: 'Slack channel configuration repaired',
      idempotencyKey: `replay-${randomUUID()}`,
    };

    const first = await jobs.replay(request);
    expect(first).toMatchObject({
      kind: 'requeued',
      job: { status: 'pending', attempts: 0, lastError: null },
    });
    if (first.kind !== 'requeued') throw new Error('replay unexpectedly rejected');
    const originalReplayJob = first.job;

    const claimed = await jobs.claim('post-replay-worker', 1, 10_000, 3);
    expect(claimed[0]).toMatchObject({ status: 'running', attempts: 1 });
    const duplicateWhileRunning = await jobs.replay(request);
    expect(duplicateWhileRunning).toEqual({
      kind: 'replayed',
      job: originalReplayJob,
    });
    await jobs.complete(created.auditEventId, 'post-replay-worker');
    const duplicateAfterSuccess = await jobs.replay(request);
    expect(duplicateAfterSuccess).toEqual({
      kind: 'replayed',
      job: originalReplayJob,
    });
    await expect(
      jobs.replay({ ...request, idempotencyKey: `new-${randomUUID()}` }),
    ).resolves.toEqual({ kind: 'not-dead-letter' });
    await expect(
      jobs.replay({ ...request, reason: 'different request' }),
    ).resolves.toEqual({ kind: 'idempotency-conflict' });

    const audit = await pool.query<{
      actor_id: string;
      reason: string;
      rows: string;
    }>(
      `SELECT min(actor_id) AS actor_id, min(reason) AS reason, count(*)::text AS rows
         FROM diagnosis_job_replay_audit WHERE audit_event_id=$1`,
      [created.auditEventId],
    );
    expect(audit.rows[0]).toEqual({
      actor_id: 'operator:alice',
      reason: 'Slack channel configuration repaired',
      rows: '1',
    });
  });

  it('does not replay succeeded, pending, running, or cross-tenant jobs', async () => {
    const pending = await createJob('replay-pending');
    const requestFor = (created: { auditEventId: string; scope: Scope }) => ({
      auditEventId: created.auditEventId,
      scope: created.scope,
      actor: { type: 'manual' as const, id: 'operator:test' },
      reason: 'retry requested',
      idempotencyKey: `replay-${randomUUID()}`,
    });
    await expect(jobs.replay(requestFor(pending))).resolves.toEqual({
      kind: 'not-dead-letter',
    });

    await jobs.claim('live-worker', 1, 10_000, 3);
    await expect(jobs.replay(requestFor(pending))).resolves.toEqual({
      kind: 'not-dead-letter',
    });
    await jobs.complete(pending.auditEventId, 'live-worker');
    await expect(jobs.replay(requestFor(pending))).resolves.toEqual({
      kind: 'not-dead-letter',
    });
    await expect(
      jobs.replay({
        ...requestFor(pending),
        scope: { ...pending.scope, tenant: 'different-tenant' },
      }),
    ).resolves.toEqual({ kind: 'not-found' });
  });
});
