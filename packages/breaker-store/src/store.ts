import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  applyDisable,
  applyEnable,
  applyResume,
  applyTrip,
  permit as permitPure,
  type NoopReason,
} from '@fuse/breaker-core';
import type {
  Actor,
  BreakerAuditEvent,
  BreakerRecord,
  DisableRequest,
  EnableRequest,
  PermitResponse,
  RegisterScopeRequest,
  RegisterScopeResponse,
  ResumeRequest,
  Scope,
  ScopeRegistration,
  TripRequest,
} from '@fuse/contracts';
import { DetectorTypeSchema } from '@fuse/contracts';
import type { DiagnosisJobSpec } from './diagnosis-job-store.js';
import {
  CasContentionExhaustedError,
  IdempotencyConflictError,
  ScopeCapacityExceededError,
  UnknownScopeError,
} from './errors.js';
import { withStoreErrors } from './pool.js';
import {
  type BreakerAuditRow,
  type BreakerStateRow,
  rowToAuditEvent,
  rowToRecord,
} from './mapper.js';

export type TransitionResult =
  | {
      kind: 'applied';
      record: BreakerRecord;
      auditEvent: BreakerAuditEvent;
      noop: boolean;
      noopReason?: NoopReason;
      /** Internal delivery metadata: true when this result was loaded from
       * the idempotency snapshot rather than committed by this invocation.
       * HTTP mutation responses deliberately omit it, but side effects such
       * as Slack notification must only run for the original commit. */
      replayed?: boolean;
    }
  | {
      kind: 'rejected';
      code: 'invalid_transition' | 'cooldown_active' | 'stale_epoch';
      message: string;
    };

const MAX_CAS_ATTEMPTS = 5;
const IDEMPOTENCY_TTL_INTERVAL = "interval '7 days'";
export const DEFAULT_MAX_REGISTERED_SCOPES_PER_TENANT = 10_000;

interface RegisteredScopeRow {
  tenant: string;
  environment: string;
  agent_id: string;
  policy_version: string;
  registered_at: Date;
  registered_by_type: Actor['type'];
  registered_by_id: string;
  registration_reason: string;
}

function rowToRegistration(row: RegisteredScopeRow): ScopeRegistration {
  return {
    scope: {
      tenant: row.tenant,
      environment: row.environment,
      agentId: row.agent_id,
    },
    policyVersion: row.policy_version,
    registeredAt: row.registered_at.toISOString(),
    registeredBy: {
      type: row.registered_by_type,
      id: row.registered_by_id,
    },
    reason: row.registration_reason,
  };
}

function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

interface ExecuteTransitionArgs {
  scope: Scope;
  idempotencyKey: string;
  correlationId: string;
  actor: Actor;
  reason: string;
  expectedEpoch?: number | undefined;
  requestForHash: unknown;
  now: Date;
  diagnosisJob?: DiagnosisJobSpec;
  computeOutcome: (current: BreakerRecord) => ReturnType<typeof applyTrip>;
}

function inferredDetector(actorId: string): string {
  const candidate = actorId.split(':').at(-1);
  const parsed = DetectorTypeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : 'unknown';
}

function normalizeDiagnosisJobSpec(
  req: TripRequest,
  spec: DiagnosisJobSpec | undefined,
  now: Date,
): DiagnosisJobSpec {
  if (!spec) {
    return {
      detector: inferredDetector(req.actor.id),
      startsAt: now.toISOString(),
      notifySlack: false,
    };
  }
  if (spec.detector.length < 1 || spec.detector.length > 200) {
    throw new RangeError('diagnosis detector must contain between 1 and 200 characters');
  }
  const startsAtMs = Date.parse(spec.startsAt);
  if (!Number.isFinite(startsAtMs)) {
    throw new RangeError('diagnosis startsAt must be a valid timestamp');
  }
  let measurement: DiagnosisJobSpec['measurement'];
  if (spec.measurement) {
    const windowEndMs = Date.parse(spec.measurement.windowEnd);
    if (
      spec.measurement.detectorVersion.length < 1 ||
      spec.measurement.detectorVersion.length > 200 ||
      !Number.isFinite(spec.measurement.score) ||
      !Number.isFinite(spec.measurement.threshold) ||
      !Number.isFinite(windowEndMs)
    ) {
      throw new RangeError('diagnosis measurement must contain bounded finite values');
    }
    measurement = {
      detectorVersion: spec.measurement.detectorVersion,
      score: spec.measurement.score,
      threshold: spec.measurement.threshold,
      windowEnd: new Date(windowEndMs).toISOString(),
    };
  }
  return {
    detector: spec.detector,
    startsAt: new Date(startsAtMs).toISOString(),
    notifySlack: spec.notifySlack,
    ...(measurement ? { measurement } : {}),
  };
}

export class BreakerStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly clock: () => Date = () => new Date(),
    private readonly maxRegisteredScopesPerTenant: number = DEFAULT_MAX_REGISTERED_SCOPES_PER_TENANT,
  ) {
    if (
      !Number.isSafeInteger(maxRegisteredScopesPerTenant) ||
      maxRegisteredScopesPerTenant < 1
    ) {
      throw new RangeError('maxRegisteredScopesPerTenant must be a positive integer');
    }
  }

  private async insertInitialRecord(
    client: pg.PoolClient,
    req: RegisterScopeRequest,
    now: Date,
  ): Promise<void> {
    await client.query(
      `INSERT INTO breaker_state
         (tenant, environment, agent_id, state, epoch, reason, policy_version, cooldown_until, updated_at, updated_by_type, updated_by_id)
       VALUES ($1,$2,$3,'armed',0,'initialized',$4,NULL,$5,$6,$7)
       ON CONFLICT (tenant, environment, agent_id) DO NOTHING`,
      [
        req.scope.tenant,
        req.scope.environment,
        req.scope.agentId,
        req.policyVersion,
        now.toISOString(),
        req.actor.type,
        req.actor.id,
      ],
    );
  }

  private async assertScopeRegisteredWithClient(
    client: pg.PoolClient,
    scope: Scope,
  ): Promise<void> {
    const registered = await client.query<{ registered: number }>(
      `SELECT 1 AS registered
         FROM registered_scopes
        WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
      [scope.tenant, scope.environment, scope.agentId],
    );
    if (registered.rows.length === 0) {
      throw new UnknownScopeError(
        `scope ${scope.tenant}/${scope.environment}/${scope.agentId} is not registered`,
      );
    }
  }

  async assertScopeRegistered(scope: Scope): Promise<void> {
    return withStoreErrors(async () => {
      const client = await this.pool.connect();
      try {
        await this.assertScopeRegisteredWithClient(client, scope);
      } finally {
        client.release();
      }
    });
  }

  async isScopeRegistered(scope: Scope): Promise<boolean> {
    return withStoreErrors(async () => {
      const { rows } = await this.pool.query<{ registered: number }>(
        `SELECT 1 AS registered
           FROM registered_scopes
          WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
        [scope.tenant, scope.environment, scope.agentId],
      );
      return rows.length > 0;
    });
  }

  async getRegistration(scope: Scope): Promise<ScopeRegistration | null> {
    return withStoreErrors(async () => {
      const { rows } = await this.pool.query<RegisteredScopeRow>(
        `SELECT * FROM registered_scopes
          WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
        [scope.tenant, scope.environment, scope.agentId],
      );
      return rows.length > 0 ? rowToRegistration(rows[0]!) : null;
    });
  }

  /**
   * Registers and initializes one scope atomically. A transaction-scoped
   * advisory lock serializes registration by tenant, making the count+insert
   * ceiling race-free across control-plane replicas. Repeating a registration
   * for an existing scope is an idempotent read of the original metadata.
   */
  async registerScope(req: RegisterScopeRequest): Promise<RegisterScopeResponse> {
    return withStoreErrors(async () => {
      const client = await this.pool.connect();
      const now = this.clock();
      try {
        await client.query('BEGIN');
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('scope-registration/' || $1)::bigint)",
          [req.scope.tenant],
        );

        const existing = await client.query<RegisteredScopeRow>(
          `SELECT * FROM registered_scopes
            WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
          [req.scope.tenant, req.scope.environment, req.scope.agentId],
        );
        if (existing.rows.length > 0) {
          const breaker = await client.query<BreakerStateRow>(
            `SELECT * FROM breaker_state
              WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
            [req.scope.tenant, req.scope.environment, req.scope.agentId],
          );
          await client.query('COMMIT');
          return {
            registration: rowToRegistration(existing.rows[0]!),
            breaker: rowToRecord(breaker.rows[0]!),
            created: false,
          };
        }

        const count = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM registered_scopes WHERE tenant=$1',
          [req.scope.tenant],
        );
        if (Number(count.rows[0]!.count) >= this.maxRegisteredScopesPerTenant) {
          throw new ScopeCapacityExceededError(
            `tenant ${req.scope.tenant} has reached its registered-scope limit of ${this.maxRegisteredScopesPerTenant}`,
          );
        }

        const registration = await client.query<RegisteredScopeRow>(
          `INSERT INTO registered_scopes
             (tenant, environment, agent_id, policy_version, registered_at,
              registered_by_type, registered_by_id, registration_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING *`,
          [
            req.scope.tenant,
            req.scope.environment,
            req.scope.agentId,
            req.policyVersion,
            now.toISOString(),
            req.actor.type,
            req.actor.id,
            req.reason,
          ],
        );
        await this.insertInitialRecord(client, req, now);
        const breaker = await client.query<BreakerStateRow>(
          `SELECT * FROM breaker_state
            WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
          [req.scope.tenant, req.scope.environment, req.scope.agentId],
        );
        await client.query('COMMIT');
        return {
          registration: rowToRegistration(registration.rows[0]!),
          breaker: rowToRecord(breaker.rows[0]!),
          created: true,
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });
  }

  async getRecord(scope: Scope): Promise<BreakerRecord | null> {
    return withStoreErrors(async () => {
      const { rows } = await this.pool.query<BreakerStateRow>(
        `SELECT * FROM breaker_state WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
        [scope.tenant, scope.environment, scope.agentId],
      );
      return rows.length > 0 ? rowToRecord(rows[0]!) : null;
    });
  }

  async permit(
    scope: Scope,
    correlationId: string,
    _defaultPolicyVersion = 'unversioned',
  ): Promise<PermitResponse & { record: BreakerRecord }> {
    return withStoreErrors(async () => {
      const client = await this.pool.connect();
      try {
        await this.assertScopeRegisteredWithClient(client, scope);
        const { rows } = await client.query<BreakerStateRow>(
          `SELECT * FROM breaker_state WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
          [scope.tenant, scope.environment, scope.agentId],
        );
        const record = rowToRecord(rows[0]!);
        const decision = permitPure(record);
        return {
          allowed: decision.allowed,
          state: decision.state,
          reason: decision.reason,
          epoch: record.epoch,
          degraded: false,
          correlationId,
          record,
        };
      } finally {
        client.release();
      }
    });
  }

  /**
   * Every mutating operation for a given idempotency key is serialized
   * through a single Postgres session-level advisory lock keyed by
   * `hashtext(tenant/environment/agentId/idempotencyKey)`, held for the
   * entire method (idempotency check through final commit) on one
   * checked-out client. This is deliberate, not incidental: without it, two
   * truly concurrent requests carrying the *same* idempotency key can both
   * observe "key not found," both compute and commit a transition (one real,
   * one no-op), and both write their own `breaker_audit_log` row before
   * either discovers — via `ON CONFLICT DO NOTHING` on the idempotency
   * insert — that only one of them should have run at all. Clients still
   * get an identical, correct response either way (the loser replays the
   * winner's snapshot), but the audit trail would gain a phantom "duplicate
   * observed" row that never corresponds to a second real event — exactly
   * the kind of alert-forgery-shaped noise AGENTS.md requires this trail to
   * be free of. Holding the lock for the key's full lifetime means the
   * second caller simply blocks until the first commits, then finds the
   * idempotency row already populated and returns early without ever
   * computing an outcome or touching the audit log.
   *
   * Different idempotency keys (including concurrent trip/resume/etc. for
   * the same scope with distinct keys) use distinct lock hashes and do not
   * contend with each other — only the epoch-CAS loop below governs that
   * case, unchanged.
   */
  private async executeTransition(
    args: ExecuteTransitionArgs,
  ): Promise<TransitionResult> {
    return withStoreErrors(async () => {
      const requestHash = hashRequest(args.requestForHash);
      const lockKey = `${args.scope.tenant}/${args.scope.environment}/${args.scope.agentId}/${args.idempotencyKey}`;

      const client = await this.pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [lockKey]);
        try {
          await client.query(
            `DELETE FROM idempotency_keys
              WHERE tenant=$1 AND environment=$2 AND agent_id=$3 AND key=$4
                AND expires_at <= now()`,
            [
              args.scope.tenant,
              args.scope.environment,
              args.scope.agentId,
              args.idempotencyKey,
            ],
          );
          const existing = await client.query<{
            request_hash: string;
            response_snapshot: TransitionResult;
          }>(
            `SELECT request_hash, response_snapshot FROM idempotency_keys
             WHERE tenant=$1 AND environment=$2 AND agent_id=$3 AND key=$4`,
            [
              args.scope.tenant,
              args.scope.environment,
              args.scope.agentId,
              args.idempotencyKey,
            ],
          );
          if (existing.rows.length > 0) {
            const row = existing.rows[0]!;
            if (row.request_hash !== requestHash) {
              throw new IdempotencyConflictError(
                `idempotency key ${args.idempotencyKey} was already used with a different request`,
              );
            }
            return row.response_snapshot.kind === 'applied'
              ? { ...row.response_snapshot, replayed: true }
              : row.response_snapshot;
          }

          for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            try {
              await client.query('BEGIN');
              await this.assertScopeRegisteredWithClient(client, args.scope);
              const currentRes = await client.query<BreakerStateRow>(
                `SELECT * FROM breaker_state WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
                [args.scope.tenant, args.scope.environment, args.scope.agentId],
              );
              const current = rowToRecord(currentRes.rows[0]!);

              if (
                args.expectedEpoch !== undefined &&
                args.expectedEpoch !== current.epoch
              ) {
                const result: TransitionResult = {
                  kind: 'rejected',
                  code: 'stale_epoch',
                  message: `expected epoch ${args.expectedEpoch}, current epoch is ${current.epoch}`,
                };
                await client.query(
                  `INSERT INTO idempotency_keys (tenant, environment, agent_id, key, request_hash, response_snapshot, expires_at)
                   VALUES ($1,$2,$3,$4,$5,$6, now() + ${IDEMPOTENCY_TTL_INTERVAL})`,
                  [
                    args.scope.tenant,
                    args.scope.environment,
                    args.scope.agentId,
                    args.idempotencyKey,
                    requestHash,
                    JSON.stringify(result),
                  ],
                );
                await client.query('COMMIT');
                return result;
              }

              const outcome = args.computeOutcome(current);
              if (!outcome.ok) {
                const result: TransitionResult = {
                  kind: 'rejected',
                  code: outcome.code,
                  message: outcome.message,
                };
                await client.query(
                  `INSERT INTO idempotency_keys (tenant, environment, agent_id, key, request_hash, response_snapshot, expires_at)
                   VALUES ($1,$2,$3,$4,$5,$6, now() + ${IDEMPOTENCY_TTL_INTERVAL})`,
                  [
                    args.scope.tenant,
                    args.scope.environment,
                    args.scope.agentId,
                    args.idempotencyKey,
                    requestHash,
                    JSON.stringify(result),
                  ],
                );
                await client.query('COMMIT');
                return result;
              }

              let finalRecord = outcome.record;
              if (!outcome.noop) {
                const updateRes = await client.query<BreakerStateRow>(
                  `UPDATE breaker_state
                     SET state=$1, epoch=$2, reason=$3, policy_version=$4, cooldown_until=$5,
                         updated_at=$6, updated_by_type=$7, updated_by_id=$8
                   WHERE tenant=$9 AND environment=$10 AND agent_id=$11 AND epoch=$12
                   RETURNING *`,
                  [
                    outcome.record.state,
                    outcome.record.epoch,
                    outcome.record.reason,
                    outcome.record.policyVersion,
                    outcome.record.cooldownUntil,
                    outcome.record.updatedAt,
                    outcome.record.updatedBy.type,
                    outcome.record.updatedBy.id,
                    args.scope.tenant,
                    args.scope.environment,
                    args.scope.agentId,
                    current.epoch,
                  ],
                );
                if (updateRes.rows.length === 0) {
                  // Lost the CAS race to a writer using a *different*
                  // idempotency key on this scope; retry with a fresh read.
                  await client.query('ROLLBACK');
                  continue;
                }
                finalRecord = rowToRecord(updateRes.rows[0]!);
              }

              const auditRes = await client.query<BreakerAuditRow>(
                `INSERT INTO breaker_audit_log
                   (id, tenant, environment, agent_id, from_state, to_state, epoch_before, epoch_after,
                    actor_type, actor_id, reason, correlation_id, policy_version, noop)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                 RETURNING *`,
                [
                  randomUUID(),
                  args.scope.tenant,
                  args.scope.environment,
                  args.scope.agentId,
                  current.state,
                  finalRecord.state,
                  current.epoch,
                  finalRecord.epoch,
                  args.actor.type,
                  args.actor.id,
                  args.reason,
                  args.correlationId,
                  finalRecord.policyVersion,
                  outcome.noop,
                ],
              );
              const auditRow = auditRes.rows[0]!;
              if (
                !outcome.noop &&
                current.state === 'armed' &&
                finalRecord.state === 'tripped' &&
                args.diagnosisJob
              ) {
                await client.query(
                  `INSERT INTO diagnosis_jobs
                     (audit_event_id, detector, detector_version, score,
                      threshold, starts_at, window_end, notify_slack)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                   ON CONFLICT (audit_event_id) DO NOTHING`,
                  [
                    auditRow.id,
                    args.diagnosisJob.detector,
                    args.diagnosisJob.measurement?.detectorVersion ?? null,
                    args.diagnosisJob.measurement?.score ?? null,
                    args.diagnosisJob.measurement?.threshold ?? null,
                    args.diagnosisJob.startsAt,
                    args.diagnosisJob.measurement?.windowEnd ?? null,
                    args.diagnosisJob.notifySlack,
                  ],
                );
              }
              const result: TransitionResult = {
                kind: 'applied',
                record: finalRecord,
                auditEvent: rowToAuditEvent(auditRow),
                noop: outcome.noop,
                ...(outcome.noop ? { noopReason: outcome.noopReason } : {}),
              };

              // Under the advisory lock held since the top of this method,
              // no other writer can have inserted this exact key: the
              // ON CONFLICT branch below is unreachable in normal operation
              // and exists only as a defensive backstop.
              const idemRes = await client.query<{ key: string }>(
                `INSERT INTO idempotency_keys (tenant, environment, agent_id, key, request_hash, response_snapshot, expires_at)
                 VALUES ($1,$2,$3,$4,$5,$6, now() + ${IDEMPOTENCY_TTL_INTERVAL})
                 ON CONFLICT (tenant, environment, agent_id, key) DO NOTHING
                 RETURNING key`,
                [
                  args.scope.tenant,
                  args.scope.environment,
                  args.scope.agentId,
                  args.idempotencyKey,
                  requestHash,
                  JSON.stringify(result),
                ],
              );
              await client.query('COMMIT');

              if (idemRes.rows.length === 0) {
                const replay = await client.query<{
                  request_hash: string;
                  response_snapshot: TransitionResult;
                }>(
                  `SELECT request_hash, response_snapshot FROM idempotency_keys
                   WHERE tenant=$1 AND environment=$2 AND agent_id=$3 AND key=$4`,
                  [
                    args.scope.tenant,
                    args.scope.environment,
                    args.scope.agentId,
                    args.idempotencyKey,
                  ],
                );
                const row = replay.rows[0]!;
                if (row.request_hash !== requestHash) {
                  throw new IdempotencyConflictError(
                    `idempotency key ${args.idempotencyKey} was already used with a different request`,
                  );
                }
                return row.response_snapshot.kind === 'applied'
                  ? { ...row.response_snapshot, replayed: true }
                  : row.response_snapshot;
              }

              return result;
            } catch (err) {
              await client.query('ROLLBACK').catch(() => {});
              throw err;
            }
          }
          throw new CasContentionExhaustedError(
            `exceeded ${MAX_CAS_ATTEMPTS} retry attempts for ${args.scope.tenant}/${args.scope.environment}/${args.scope.agentId} due to CAS contention; retry the request`,
          );
        } finally {
          await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [
            lockKey,
          ]);
        }
      } finally {
        client.release();
      }
    });
  }

  async trip(
    req: TripRequest,
    diagnosisJob?: DiagnosisJobSpec,
  ): Promise<TransitionResult> {
    const now = this.clock();
    const normalizedDiagnosisJob = normalizeDiagnosisJobSpec(req, diagnosisJob, now);
    return this.executeTransition({
      scope: req.scope,
      idempotencyKey: req.idempotencyKey,
      correlationId: req.correlationId,
      actor: req.actor,
      reason: req.reason,
      expectedEpoch: req.expectedEpoch,
      requestForHash: req,
      now,
      diagnosisJob: normalizedDiagnosisJob,
      computeOutcome: (current) =>
        applyTrip(current, {
          reason: req.reason,
          policyVersion: req.policyVersion,
          cooldownSeconds: req.cooldownSeconds,
          actor: req.actor,
          now,
        }),
    });
  }

  async resume(req: ResumeRequest): Promise<TransitionResult> {
    const now = this.clock();
    return this.executeTransition({
      scope: req.scope,
      idempotencyKey: req.idempotencyKey,
      correlationId: req.correlationId,
      actor: req.actor,
      reason: req.reason,
      expectedEpoch: req.expectedEpoch,
      requestForHash: req,
      now,
      computeOutcome: (current) =>
        applyResume(current, { reason: req.reason, actor: req.actor, now }),
    });
  }

  async disable(req: DisableRequest): Promise<TransitionResult> {
    const now = this.clock();
    return this.executeTransition({
      scope: req.scope,
      idempotencyKey: req.idempotencyKey,
      correlationId: req.correlationId,
      actor: req.actor,
      reason: req.reason,
      expectedEpoch: req.expectedEpoch,
      requestForHash: req,
      now,
      computeOutcome: (current) =>
        applyDisable(current, { reason: req.reason, actor: req.actor, now }),
    });
  }

  async enable(req: EnableRequest): Promise<TransitionResult> {
    const now = this.clock();
    return this.executeTransition({
      scope: req.scope,
      idempotencyKey: req.idempotencyKey,
      correlationId: req.correlationId,
      actor: req.actor,
      reason: req.reason,
      expectedEpoch: req.expectedEpoch,
      requestForHash: req,
      now,
      computeOutcome: (current) =>
        applyEnable(current, { reason: req.reason, actor: req.actor, now }),
    });
  }
}
