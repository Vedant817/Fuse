import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Actor, Scope } from '@fuse/contracts';
import { withStoreErrors } from './pool.js';

export type DiagnosisJobStatus = 'pending' | 'running' | 'succeeded' | 'dead-letter';

/** Metadata supplied at trip time and persisted atomically with the audit.
 * It deliberately excludes prompts, tool payloads, credentials, and free-form
 * detector evidence. */
export interface DiagnosisJobSpec {
  detector: string;
  startsAt: string;
  notifySlack: boolean;
  measurement?: DiagnosisJobMeasurement;
}

export interface DiagnosisJobMeasurement {
  detectorVersion: string;
  score: number;
  threshold: number;
  windowEnd: string;
}

export interface DiagnosisJob {
  auditEventId: string;
  scope: Scope;
  detector: string;
  measurement: DiagnosisJobMeasurement | null;
  reason: string;
  correlationId: string;
  startsAt: string;
  tripEpoch: number;
  notifySlack: boolean;
  status: DiagnosisJobStatus;
  attempts: number;
  availableAt: string;
  leasedBy: string | null;
  leasedUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface DiagnosisJobListFilters {
  tenant: string;
  environment?: string;
  agentId?: string;
  status?: DiagnosisJobStatus;
  limit: number;
  cursor?: DiagnosisJobCursor;
}

export interface DiagnosisJobCursor {
  createdAt: string;
  auditEventId: string;
}

export interface DiagnosisJobPage {
  jobs: DiagnosisJob[];
  nextCursor: DiagnosisJobCursor | null;
}

export interface DiagnosisJobReplayRequest {
  auditEventId: string;
  scope: Scope;
  actor: Actor;
  reason: string;
  idempotencyKey: string;
}

export type DiagnosisJobReplayResult =
  | { kind: 'requeued' | 'replayed'; job: DiagnosisJob }
  | { kind: 'not-found' }
  | { kind: 'not-dead-letter' }
  | { kind: 'idempotency-conflict' };

export type DiagnosisQueueCounts = Record<
  Extract<DiagnosisJobStatus, 'pending' | 'running' | 'dead-letter'>,
  number
>;

interface DiagnosisJobRow {
  audit_event_id: string;
  tenant: string;
  environment: string;
  agent_id: string;
  detector: string;
  detector_version: string | null;
  score: number | null;
  threshold: number | null;
  reason: string;
  correlation_id: string;
  starts_at: Date;
  window_end: Date | null;
  epoch_after: string;
  notify_slack: boolean;
  status: DiagnosisJobStatus;
  attempts: number;
  available_at: Date;
  leased_by: string | null;
  leased_until: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

const JOB_SELECT = `
  SELECT j.*, a.tenant, a.environment, a.agent_id, a.reason,
         a.correlation_id, a.epoch_after
    FROM diagnosis_jobs j
    JOIN breaker_audit_log a ON a.id = j.audit_event_id`;

const REQUIRED_JOB_COLUMNS = [
  'audit_event_id',
  'detector',
  'detector_version',
  'score',
  'threshold',
  'starts_at',
  'window_end',
  'notify_slack',
  'status',
  'attempts',
  'available_at',
  'leased_by',
  'leased_until',
  'last_error',
  'created_at',
  'updated_at',
  'completed_at',
] as const;
const REQUIRED_REPLAY_AUDIT_COLUMNS = [
  'id',
  'audit_event_id',
  'tenant',
  'environment',
  'agent_id',
  'actor_type',
  'actor_id',
  'reason',
  'idempotency_key',
  'request_hash',
  'created_at',
] as const;

const JOB_STATUSES = new Set<DiagnosisJobStatus>([
  'pending',
  'running',
  'succeeded',
  'dead-letter',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function rowToJob(row: DiagnosisJobRow): DiagnosisJob {
  return {
    auditEventId: row.audit_event_id,
    scope: {
      tenant: row.tenant,
      environment: row.environment,
      agentId: row.agent_id,
    },
    detector: row.detector,
    measurement:
      row.detector_version !== null &&
      row.score !== null &&
      row.threshold !== null &&
      row.window_end !== null
        ? {
            detectorVersion: row.detector_version,
            score: row.score,
            threshold: row.threshold,
            windowEnd: row.window_end.toISOString(),
          }
        : null,
    reason: row.reason,
    correlationId: row.correlation_id,
    startsAt: row.starts_at.toISOString(),
    tripEpoch: Number(row.epoch_after),
    notifySlack: row.notify_slack,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at.toISOString(),
    leasedBy: row.leased_by,
    leasedUntil: row.leased_until?.toISOString() ?? null,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

function rowToReplaySnapshot(row: DiagnosisJobRow, replayedAt: Date): DiagnosisJob {
  return {
    ...rowToJob(row),
    status: 'pending',
    attempts: 0,
    availableAt: replayedAt.toISOString(),
    leasedBy: null,
    leasedUntil: null,
    lastError: null,
    updatedAt: replayedAt.toISOString(),
    completedAt: null,
  };
}

function assertPositiveInteger(value: number, name: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  }
}

function assertBoundedString(value: string, name: string, maximum: number): void {
  if (value.length < 1 || value.length > maximum) {
    throw new RangeError(`${name} must contain between 1 and ${maximum} characters`);
  }
}

function replayRequestHash(request: DiagnosisJobReplayRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        auditEventId: request.auditEventId,
        scope: request.scope,
        actor: request.actor,
        reason: request.reason,
        idempotencyKey: request.idempotencyKey,
      }),
    )
    .digest('hex');
}

export class DiagnosisJobStore {
  constructor(private readonly pool: pg.Pool) {}

  /** Startup guard used by the real server so a replica cannot advertise
   * service while silently lacking the durable delivery table. */
  async assertReady(): Promise<void> {
    await withStoreErrors(async () => {
      const columns = await this.pool.query<{
        table_name: string;
        column_name: string;
      }>(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema=current_schema()
            AND table_name IN ('diagnosis_jobs', 'diagnosis_job_replay_audit')`,
      );
      const present = new Set(
        columns.rows.map(({ table_name, column_name }) => `${table_name}.${column_name}`),
      );
      const missing = [
        ...REQUIRED_JOB_COLUMNS.map((column) => `diagnosis_jobs.${column}`),
        ...REQUIRED_REPLAY_AUDIT_COLUMNS.map(
          (column) => `diagnosis_job_replay_audit.${column}`,
        ),
      ].filter((column) => !present.has(column));
      const migrations = await this.pool.query<{ id: string }>(
        `SELECT id FROM schema_migrations
          WHERE id IN ('0005_diagnosis_jobs.sql', '0007_diagnosis_job_replays.sql')`,
      );
      const applied = new Set(migrations.rows.map(({ id }) => id));
      const missingMigrations = [
        '0005_diagnosis_jobs.sql',
        '0007_diagnosis_job_replays.sql',
      ].filter((id) => !applied.has(id));
      if (missing.length > 0 || missingMigrations.length > 0) {
        throw new Error(
          `diagnosis job schema is missing or stale: ${[
            ...missing,
            ...missingMigrations.map((id) => `migration:${id}`),
          ].join(', ')}`,
        );
      }
    });
  }

  async get(auditEventId: string): Promise<DiagnosisJob | null> {
    return withStoreErrors(async () => {
      const { rows } = await this.pool.query<DiagnosisJobRow>(
        `${JOB_SELECT} WHERE j.audit_event_id=$1`,
        [auditEventId],
      );
      return rows[0] ? rowToJob(rows[0]) : null;
    });
  }

  async list(filters: DiagnosisJobListFilters): Promise<DiagnosisJobPage> {
    assertBoundedString(filters.tenant, 'tenant', 128);
    if (filters.environment !== undefined) {
      assertBoundedString(filters.environment, 'environment', 64);
    }
    if (filters.agentId !== undefined) {
      assertBoundedString(filters.agentId, 'agentId', 128);
    }
    if (filters.status !== undefined && !JOB_STATUSES.has(filters.status)) {
      throw new RangeError('status is not a recognized diagnosis job status');
    }
    assertPositiveInteger(filters.limit, 'limit', 100);
    if (filters.cursor) {
      if (!Number.isFinite(Date.parse(filters.cursor.createdAt))) {
        throw new RangeError('cursor.createdAt must be an ISO timestamp');
      }
      if (!UUID.test(filters.cursor.auditEventId)) {
        throw new RangeError('cursor.auditEventId must be a UUID');
      }
    }

    return withStoreErrors(async () => {
      const { rows } = await this.pool.query<DiagnosisJobRow>(
        `${JOB_SELECT}
          WHERE a.tenant=$1
            AND ($2::text IS NULL OR a.environment=$2)
            AND ($3::text IS NULL OR a.agent_id=$3)
            AND ($4::text IS NULL OR j.status=$4)
            AND (
              $5::timestamptz IS NULL OR
              (j.created_at, j.audit_event_id) < ($5::timestamptz, $6::uuid)
            )
          ORDER BY j.created_at DESC, j.audit_event_id DESC
          LIMIT $7`,
        [
          filters.tenant,
          filters.environment ?? null,
          filters.agentId ?? null,
          filters.status ?? null,
          filters.cursor?.createdAt ?? null,
          filters.cursor?.auditEventId ?? null,
          filters.limit + 1,
        ],
      );
      const hasNext = rows.length > filters.limit;
      const pageRows = hasNext ? rows.slice(0, filters.limit) : rows;
      const last = pageRows.at(-1);
      return {
        jobs: pageRows.map(rowToJob),
        nextCursor:
          hasNext && last
            ? {
                createdAt: last.created_at.toISOString(),
                auditEventId: last.audit_event_id,
              }
            : null,
      };
    });
  }

  async countQueue(): Promise<DiagnosisQueueCounts> {
    return withStoreErrors(async () => {
      const { rows } = await this.pool.query<{
        status: DiagnosisJobStatus;
        count: string;
      }>(
        `SELECT status, count(*)::text AS count
           FROM diagnosis_jobs
          WHERE status IN ('pending', 'running', 'dead-letter')
          GROUP BY status`,
      );
      const counts: DiagnosisQueueCounts = {
        pending: 0,
        running: 0,
        'dead-letter': 0,
      };
      for (const row of rows) {
        if (row.status in counts)
          counts[row.status as keyof DiagnosisQueueCounts] = Number(row.count);
      }
      return counts;
    });
  }

  /** Claims up to `limit` due jobs. PostgreSQL row locks plus SKIP LOCKED
   * prevent two replicas from receiving the same live lease. Expired leases
   * are eligible again, and an abandoned final attempt is dead-lettered. */
  async claim(
    workerId: string,
    limit: number,
    leaseMs: number,
    maxAttempts: number,
  ): Promise<DiagnosisJob[]> {
    assertPositiveInteger(limit, 'limit', 100);
    assertPositiveInteger(leaseMs, 'leaseMs', 24 * 60 * 60_000);
    assertPositiveInteger(maxAttempts, 'maxAttempts', 100);
    if (workerId.length < 1 || workerId.length > 200) {
      throw new RangeError('workerId must contain between 1 and 200 characters');
    }

    return withStoreErrors(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE diagnosis_jobs
              SET status='dead-letter', leased_by=NULL, leased_until=NULL,
                  completed_at=now(), updated_at=now(),
                  last_error=COALESCE(last_error, 'lease expired after final attempt')
            WHERE status='running' AND leased_until <= now() AND attempts >= $1`,
          [maxAttempts],
        );
        const { rows } = await client.query<DiagnosisJobRow>(
          `WITH candidates AS (
             SELECT audit_event_id
               FROM diagnosis_jobs
              WHERE attempts < $1
                AND (
                  (status='pending' AND available_at <= now()) OR
                  (status='running' AND leased_until <= now())
                )
              ORDER BY available_at, created_at, audit_event_id
              FOR UPDATE SKIP LOCKED
              LIMIT $2
           ), claimed AS (
             UPDATE diagnosis_jobs j
                SET status='running', attempts=j.attempts + 1,
                    leased_by=$3,
                    leased_until=now() + ($4::bigint * interval '1 millisecond'),
                    updated_at=now(), completed_at=NULL
               FROM candidates c
              WHERE j.audit_event_id=c.audit_event_id
              RETURNING j.*
           )
           SELECT c.*, a.tenant, a.environment, a.agent_id, a.reason,
                  a.correlation_id, a.epoch_after
             FROM claimed c
             JOIN breaker_audit_log a ON a.id=c.audit_event_id
            ORDER BY c.available_at, c.created_at, c.audit_event_id`,
          [maxAttempts, limit, workerId, leaseMs],
        );
        await client.query('COMMIT');
        return rows.map(rowToJob);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });
  }

  async complete(auditEventId: string, workerId: string): Promise<boolean> {
    return withStoreErrors(async () => {
      const result = await this.pool.query(
        `UPDATE diagnosis_jobs
            SET status='succeeded', leased_by=NULL, leased_until=NULL,
                completed_at=now(), updated_at=now(), last_error=NULL
          WHERE audit_event_id=$1 AND status='running' AND leased_by=$2
            AND leased_until > now()`,
        [auditEventId, workerId],
      );
      return result.rowCount === 1;
    });
  }

  async renewLease(
    auditEventId: string,
    workerId: string,
    leaseMs: number,
  ): Promise<boolean> {
    assertPositiveInteger(leaseMs, 'leaseMs', 24 * 60 * 60_000);
    return withStoreErrors(async () => {
      const result = await this.pool.query(
        `UPDATE diagnosis_jobs
            SET leased_until=now() + ($3::bigint * interval '1 millisecond'),
                updated_at=now()
          WHERE audit_event_id=$1 AND status='running' AND leased_by=$2
            AND leased_until > now()`,
        [auditEventId, workerId, leaseMs],
      );
      return result.rowCount === 1;
    });
  }

  async fail(
    auditEventId: string,
    workerId: string,
    error: string,
    retryDelayMs: number,
    maxAttempts: number,
  ): Promise<'retry' | 'dead-letter' | 'lease-lost'> {
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
      throw new RangeError('retryDelayMs must be a nonnegative safe integer');
    }
    assertPositiveInteger(maxAttempts, 'maxAttempts', 100);
    const boundedError = error.slice(0, 1000) || 'diagnosis delivery failed';
    return withStoreErrors(async () => {
      const { rows } = await this.pool.query<{ status: DiagnosisJobStatus }>(
        `UPDATE diagnosis_jobs
            SET status=CASE WHEN attempts >= $5 THEN 'dead-letter' ELSE 'pending' END,
                available_at=CASE
                  WHEN attempts >= $5 THEN available_at
                  ELSE now() + ($4::bigint * interval '1 millisecond')
                END,
                leased_by=NULL, leased_until=NULL, last_error=$3,
                completed_at=CASE WHEN attempts >= $5 THEN now() ELSE NULL END,
                updated_at=now()
          WHERE audit_event_id=$1 AND status='running' AND leased_by=$2
            AND leased_until > now()
          RETURNING status`,
        [auditEventId, workerId, boundedError, retryDelayMs, maxAttempts],
      );
      const status = rows[0]?.status;
      if (!status) return 'lease-lost';
      return status === 'dead-letter' ? 'dead-letter' : 'retry';
    });
  }

  async replay(request: DiagnosisJobReplayRequest): Promise<DiagnosisJobReplayResult> {
    if (!UUID.test(request.auditEventId)) {
      throw new RangeError('auditEventId must be a UUID');
    }
    assertBoundedString(request.scope.tenant, 'scope.tenant', 128);
    assertBoundedString(request.scope.environment, 'scope.environment', 64);
    assertBoundedString(request.scope.agentId, 'scope.agentId', 128);
    if (request.actor.type !== 'manual') {
      throw new RangeError('diagnosis replay actor must be manual');
    }
    assertBoundedString(request.actor.id, 'actor.id', 256);
    assertBoundedString(request.reason, 'reason', 2_000);
    assertBoundedString(request.idempotencyKey, 'idempotencyKey', 200);
    const requestHash = replayRequestHash(request);

    return withStoreErrors(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended(
             length($1)::text || ':' || $1 || length($2)::text || ':' || $2, 0
           ))`,
          [request.scope.tenant, request.idempotencyKey],
        );
        const existing = await client.query<{
          audit_event_id: string;
          request_hash: string;
          created_at: Date;
        }>(
          `SELECT audit_event_id, request_hash, created_at
             FROM diagnosis_job_replay_audit
            WHERE tenant=$1 AND idempotency_key=$2`,
          [request.scope.tenant, request.idempotencyKey],
        );
        if (existing.rows[0]) {
          if (
            existing.rows[0].audit_event_id !== request.auditEventId ||
            existing.rows[0].request_hash !== requestHash
          ) {
            await client.query('ROLLBACK');
            return { kind: 'idempotency-conflict' };
          }
          const replayed = await client.query<DiagnosisJobRow>(
            `${JOB_SELECT}
              WHERE j.audit_event_id=$1 AND a.tenant=$2 AND a.environment=$3 AND a.agent_id=$4`,
            [
              request.auditEventId,
              request.scope.tenant,
              request.scope.environment,
              request.scope.agentId,
            ],
          );
          await client.query('COMMIT');
          return replayed.rows[0]
            ? {
                kind: 'replayed',
                job: rowToReplaySnapshot(replayed.rows[0], existing.rows[0].created_at),
              }
            : { kind: 'not-found' };
        }

        const target = await client.query<DiagnosisJobRow>(
          `${JOB_SELECT}
            WHERE j.audit_event_id=$1 AND a.tenant=$2 AND a.environment=$3 AND a.agent_id=$4
            FOR UPDATE OF j`,
          [
            request.auditEventId,
            request.scope.tenant,
            request.scope.environment,
            request.scope.agentId,
          ],
        );
        const row = target.rows[0];
        if (!row) {
          await client.query('ROLLBACK');
          return { kind: 'not-found' };
        }
        if (row.status !== 'dead-letter') {
          await client.query('ROLLBACK');
          return { kind: 'not-dead-letter' };
        }

        const replayAudit = await client.query<{ created_at: Date }>(
          `INSERT INTO diagnosis_job_replay_audit
             (id, audit_event_id, tenant, environment, agent_id, actor_type,
               actor_id, reason, idempotency_key, request_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING created_at`,
          [
            randomUUID(),
            request.auditEventId,
            request.scope.tenant,
            request.scope.environment,
            request.scope.agentId,
            request.actor.type,
            request.actor.id,
            request.reason,
            request.idempotencyKey,
            requestHash,
          ],
        );
        const updated = await client.query<DiagnosisJobRow>(
          `WITH requeued AS (
             UPDATE diagnosis_jobs
                SET status='pending', attempts=0, available_at=now(),
                    leased_by=NULL, leased_until=NULL, last_error=NULL,
                    completed_at=NULL, updated_at=now()
              WHERE audit_event_id=$1
              RETURNING *
           )
           SELECT r.*, a.tenant, a.environment, a.agent_id, a.reason,
                  a.correlation_id, a.epoch_after
             FROM requeued r
             JOIN breaker_audit_log a ON a.id=r.audit_event_id`,
          [request.auditEventId],
        );
        await client.query('COMMIT');
        return {
          kind: 'requeued',
          job: rowToReplaySnapshot(updated.rows[0]!, replayAudit.rows[0]!.created_at),
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    });
  }
}
