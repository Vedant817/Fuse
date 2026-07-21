import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  applyDisable,
  applyEnable,
  applyResume,
  applyTrip,
  permit as permitPure,
} from '@fuse/breaker-core';
import type {
  Actor,
  BreakerAuditEvent,
  BreakerRecord,
  DisableRequest,
  EnableRequest,
  PermitResponse,
  ResumeRequest,
  Scope,
  TripRequest,
} from '@fuse/contracts';
import { IdempotencyConflictError } from './errors.js';
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
    }
  | {
      kind: 'rejected';
      code: 'invalid_transition' | 'cooldown_active' | 'stale_epoch';
      message: string;
    };

const MAX_CAS_ATTEMPTS = 5;
const IDEMPOTENCY_TTL_INTERVAL = "interval '7 days'";
const SYSTEM_INIT_ACTOR: Actor = { type: 'system', id: 'system:lazy-init' };

function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

interface ExecuteTransitionArgs {
  scope: Scope;
  idempotencyKey: string;
  correlationId: string;
  policyVersionForInit: string;
  expectedEpoch?: number | undefined;
  requestForHash: unknown;
  now: Date;
  computeOutcome: (current: BreakerRecord) => ReturnType<typeof applyTrip>;
}

export class BreakerStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async ensureRecordExists(
    client: pg.PoolClient,
    scope: Scope,
    policyVersion: string,
    actor: Actor,
    now: Date,
  ): Promise<void> {
    await client.query(
      `INSERT INTO breaker_state
         (tenant, environment, agent_id, state, epoch, reason, policy_version, cooldown_until, updated_at, updated_by_type, updated_by_id)
       VALUES ($1,$2,$3,'armed',0,'initialized',$4,NULL,$5,$6,$7)
       ON CONFLICT (tenant, environment, agent_id) DO NOTHING`,
      [
        scope.tenant,
        scope.environment,
        scope.agentId,
        policyVersion,
        now.toISOString(),
        actor.type,
        actor.id,
      ],
    );
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
    defaultPolicyVersion = 'unversioned',
  ): Promise<PermitResponse & { record: BreakerRecord }> {
    return withStoreErrors(async () => {
      const client = await this.pool.connect();
      try {
        await this.ensureRecordExists(
          client,
          scope,
          defaultPolicyVersion,
          SYSTEM_INIT_ACTOR,
          this.clock(),
        );
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

  private async executeTransition(
    args: ExecuteTransitionArgs,
  ): Promise<TransitionResult> {
    return withStoreErrors(async () => {
      const requestHash = hashRequest(args.requestForHash);

      const existing = await this.pool.query<{
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
        return row.response_snapshot;
      }

      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          await this.ensureRecordExists(
            client,
            args.scope,
            args.policyVersionForInit,
            SYSTEM_INIT_ACTOR,
            args.now,
          );
          const currentRes = await client.query<BreakerStateRow>(
            `SELECT * FROM breaker_state WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
            [args.scope.tenant, args.scope.environment, args.scope.agentId],
          );
          const current = rowToRecord(currentRes.rows[0]!);

          if (args.expectedEpoch !== undefined && args.expectedEpoch !== current.epoch) {
            await client.query('ROLLBACK');
            return {
              kind: 'rejected',
              code: 'stale_epoch',
              message: `expected epoch ${args.expectedEpoch}, current epoch is ${current.epoch}`,
            };
          }

          const outcome = args.computeOutcome(current);
          if (!outcome.ok) {
            await client.query('ROLLBACK');
            return { kind: 'rejected', code: outcome.code, message: outcome.message };
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
              // Lost the CAS race to a concurrent writer; retry with a fresh read.
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
              finalRecord.updatedBy.type,
              finalRecord.updatedBy.id,
              finalRecord.reason,
              args.correlationId,
              finalRecord.policyVersion,
              outcome.noop,
            ],
          );
          const result: TransitionResult = {
            kind: 'applied',
            record: finalRecord,
            auditEvent: rowToAuditEvent(auditRes.rows[0]!),
            noop: outcome.noop,
          };

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
            // A concurrent duplicate request committed under this key first;
            // replay its response so both callers observe the same outcome.
            const replay = await this.pool.query<{
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
            return row.response_snapshot;
          }

          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }
      throw new Error(
        `exceeded ${MAX_CAS_ATTEMPTS} retry attempts for ${args.scope.tenant}/${args.scope.environment}/${args.scope.agentId} due to CAS contention`,
      );
    });
  }

  async trip(req: TripRequest): Promise<TransitionResult> {
    const now = this.clock();
    return this.executeTransition({
      scope: req.scope,
      idempotencyKey: req.idempotencyKey,
      correlationId: req.correlationId,
      policyVersionForInit: req.policyVersion,
      expectedEpoch: req.expectedEpoch,
      requestForHash: req,
      now,
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
      policyVersionForInit: 'unversioned',
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
      policyVersionForInit: 'unversioned',
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
      policyVersionForInit: 'unversioned',
      requestForHash: req,
      now,
      computeOutcome: (current) =>
        applyEnable(current, { reason: req.reason, actor: req.actor, now }),
    });
  }
}
