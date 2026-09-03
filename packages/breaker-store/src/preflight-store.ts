import type pg from 'pg';
import {
  evaluatePreflight,
  type HeartbeatSignal,
  type PreflightEvaluatorConfig,
} from '@fuse/preflight';
import {
  compareExporterDeliverySignals,
  SpanTelemetrySampleSchema,
  type ExporterDeliverySignal,
  type PreflightResult,
  type PreflightState,
  type Scope,
  type SpanTelemetrySampleWire,
} from '@fuse/contracts';
import { UnknownScopeError } from './errors.js';
import { withStoreErrors } from './pool.js';
import { rowToPreflightResult, type PreflightStateRow } from './mapper.js';

export interface EvaluateArgs {
  scope: Scope;
  spans: readonly SpanTelemetrySampleWire[];
  heartbeat?: HeartbeatSignal | undefined;
  exporterDelivery?: ExporterDeliverySignal | undefined;
  revalidate?: boolean | undefined;
  config: PreflightEvaluatorConfig;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
}

export interface PreflightSelfAlertTransition {
  kind: 'opened' | 'recovered';
  fromState: PreflightState | null;
  toState: PreflightState;
  reasonCode: PreflightResult['reasonCode'];
}

export interface PreflightEvaluationOutcome {
  result: PreflightResult;
  selfAlertTransition: PreflightSelfAlertTransition | null;
}

interface OrderedPreflightStateRow extends PreflightStateRow {
  evidence_watermark_ms: string | null;
}

interface PreflightSourceEvidenceRow {
  source_instance_id: string;
  sequence: string;
  observed_at_ms: string;
  status: ExporterDeliverySignal['status'];
  spans: unknown;
  received_at: Date;
}

interface SourceEvidence {
  signal: ExporterDeliverySignal;
  spans: SpanTelemetrySampleWire[];
  receivedAt: Date;
}

const STATE_RANK: Record<'blind' | 'degraded' | 'protected', number> = {
  blind: 0,
  degraded: 1,
  protected: 2,
};

function selfAlertTransition(
  previous: PreflightResult | undefined,
  result: PreflightResult,
): PreflightSelfAlertTransition | null {
  const wasAlerting = previous?.state === 'degraded' || previous?.state === 'blind';
  const isAlerting = result.state === 'degraded' || result.state === 'blind';
  if (!wasAlerting && isAlerting) {
    return {
      kind: 'opened',
      fromState: previous?.state ?? null,
      toState: result.state,
      reasonCode: result.reasonCode,
    };
  }
  if (wasAlerting && result.state === 'protected') {
    return {
      kind: 'recovered',
      fromState: previous.state,
      toState: result.state,
      reasonCode: result.reasonCode,
    };
  }
  return null;
}

function rowToSourceEvidence(row: PreflightSourceEvidenceRow): SourceEvidence {
  return {
    signal: {
      sourceInstanceId: row.source_instance_id,
      sequence: Number(row.sequence),
      observedAtMs: Number(row.observed_at_ms),
      status: row.status,
    },
    spans: SpanTelemetrySampleSchema.array().max(2_000).parse(row.spans),
    receivedAt: row.received_at,
  };
}

export const PREFLIGHT_ACTIVE_SOURCE_TTL_MULTIPLIER = 2;
export const PREFLIGHT_SOURCE_RETENTION_MULTIPLIER = 4;

function boundedMultiply(value: number, multiplier: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value * multiplier);
}

export function preflightActiveSourceTtlMs(config: PreflightEvaluatorConfig): number {
  // A dead peer must remain part of the aggregate after its evidence first
  // becomes stale; otherwise a healthy peer could mask the death immediately.
  return boundedMultiply(
    config.maxEvidenceStalenessMs,
    PREFLIGHT_ACTIVE_SOURCE_TTL_MULTIPLIER,
  );
}

export function preflightSourceRetentionMs(config: PreflightEvaluatorConfig): number {
  // Retention is twice the active-source TTL. This leaves a full active window
  // of safety before evidence becomes deletion-eligible.
  return boundedMultiply(
    config.maxEvidenceStalenessMs,
    PREFLIGHT_SOURCE_RETENTION_MULTIPLIER,
  );
}

function reasonPriority(result: PreflightResult): number {
  if (result.reasonCode === 'exporter-delivery-failed') return 0;
  if (
    result.reasonCode === 'exporter-delivery-stale' ||
    result.reasonCode === 'stale-evidence' ||
    result.reasonCode === 'no-signal'
  ) {
    return 1;
  }
  return 2;
}

/**
 * Persists per-source exporter evidence and a conservative scope aggregate.
 * Sequence orders callbacks only within one source instance. Cross-source
 * liveness uses PostgreSQL receipt time, never reporter wall-clock order.
 */
export class PreflightStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly clock?: (() => Date) | undefined,
  ) {}

  async getResult(scope: Scope): Promise<PreflightResult | null> {
    return withStoreErrors(async () => {
      const { rows } = await this.pool.query<PreflightStateRow>(
        `SELECT * FROM preflight_state WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
        [scope.tenant, scope.environment, scope.agentId],
      );
      return rows.length > 0 ? rowToPreflightResult(rows[0]!) : null;
    });
  }

  async evaluate(args: EvaluateArgs): Promise<PreflightResult> {
    return (await this.evaluateWithTransition(args)).result;
  }

  /** Revalidates an existing scope against PostgreSQL time and persisted
   * evidence only. Returns null when no report has ever established state. */
  async getRevalidatedResult(
    scope: Scope,
    config: PreflightEvaluatorConfig,
  ): Promise<PreflightEvaluationOutcome | null> {
    const existing = await this.getResult(scope);
    if (!existing) return null;
    return this.evaluateWithTransition({ scope, spans: [], revalidate: true, config });
  }

  /** Revalidates at most `limit` oldest aggregate rows. Updating evaluated_at
   * rotates work fairly across subsequent bounded sweeps. */
  async sweepStale(
    config: PreflightEvaluatorConfig,
    limit: number,
  ): Promise<PreflightEvaluationOutcome[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError('Preflight sweep limit must be an integer from 1 to 1000');
    }
    await this.deleteInactiveSourceEvidence(config, limit);
    const scopes = await withStoreErrors(async () => {
      const { rows } = await this.pool.query<{
        tenant: string;
        environment: string;
        agent_id: string;
      }>(
        `SELECT tenant, environment, agent_id
           FROM preflight_state
          WHERE state <> 'disabled'
          ORDER BY evaluated_at ASC, tenant, environment, agent_id
          LIMIT $1`,
        [limit],
      );
      return rows;
    });

    const outcomes: PreflightEvaluationOutcome[] = [];
    for (const row of scopes) {
      outcomes.push(
        await this.evaluateWithTransition({
          scope: {
            tenant: row.tenant,
            environment: row.environment,
            agentId: row.agent_id,
          },
          spans: [],
          revalidate: true,
          config,
        }),
      );
    }
    return outcomes;
  }

  /** Deletes one bounded batch after the retention horizon. SKIP LOCKED lets
   * replicas share cleanup without waiting on one another or a concurrent
   * reporter refresh. */
  async deleteInactiveSourceEvidence(
    config: PreflightEvaluatorConfig,
    limit: number,
  ): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError(
        'Preflight source-evidence deletion limit must be an integer from 1 to 1000',
      );
    }
    return withStoreErrors(async () => {
      const deleted = await this.pool.query(
        `WITH candidates AS (
           SELECT ctid
             FROM preflight_source_evidence
            WHERE received_at < clock_timestamp()
                  - ($1::double precision * interval '1 millisecond')
            ORDER BY received_at, tenant, environment, agent_id, source_instance_id
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         DELETE FROM preflight_source_evidence AS evidence
          USING candidates
          WHERE evidence.ctid = candidates.ctid
         RETURNING evidence.source_instance_id`,
        [preflightSourceRetentionMs(config), limit],
      );
      return deleted.rowCount ?? 0;
    });
  }

  /** Derives the self-alert edge under the same scope lock as the aggregate
   * write, making transition dedupe durable across reports, sweeps, and
   * control-plane replicas. */
  async evaluateWithTransition(args: EvaluateArgs): Promise<PreflightEvaluationOutcome> {
    return withStoreErrors(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const registration = await client.query<{ registered: number }>(
          `SELECT 1 AS registered
             FROM registered_scopes
            WHERE tenant=$1 AND environment=$2 AND agent_id=$3
            FOR UPDATE`,
          [args.scope.tenant, args.scope.environment, args.scope.agentId],
        );
        if (registration.rows.length === 0) {
          throw new UnknownScopeError(
            `scope ${args.scope.tenant}/${args.scope.environment}/${args.scope.agentId} is not registered`,
          );
        }

        const existing = await client.query<OrderedPreflightStateRow>(
          `SELECT * FROM preflight_state
            WHERE tenant=$1 AND environment=$2 AND agent_id=$3
            FOR UPDATE`,
          [args.scope.tenant, args.scope.environment, args.scope.agentId],
        );
        const previous = existing.rows[0]
          ? rowToPreflightResult(existing.rows[0])
          : undefined;
        const now = this.clock
          ? this.clock()
          : (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now'))
              .rows[0]!.now;

        let acceptedIncoming: SourceEvidence | undefined;
        let ignoredIncoming = false;
        if (args.exporterDelivery) {
          const current = await client.query<PreflightSourceEvidenceRow>(
            `SELECT source_instance_id, sequence, observed_at_ms, status, spans, received_at
               FROM preflight_source_evidence
              WHERE tenant=$1 AND environment=$2 AND agent_id=$3 AND source_instance_id=$4
              FOR UPDATE`,
            [
              args.scope.tenant,
              args.scope.environment,
              args.scope.agentId,
              args.exporterDelivery.sourceInstanceId,
            ],
          );
          const currentEvidence = current.rows[0]
            ? rowToSourceEvidence(current.rows[0])
            : undefined;
          const order = currentEvidence
            ? compareExporterDeliverySignals(
                args.exporterDelivery,
                currentEvidence.signal,
              )
            : 1;
          if (order > 0) {
            acceptedIncoming = {
              signal: args.exporterDelivery,
              spans: [...args.spans],
              receivedAt: now,
            };
            await client.query(
              `INSERT INTO preflight_source_evidence
                 (tenant, environment, agent_id, source_instance_id, sequence,
                  observed_at_ms, status, spans, received_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
               ON CONFLICT (tenant, environment, agent_id, source_instance_id)
               DO UPDATE SET sequence=EXCLUDED.sequence,
                             observed_at_ms=EXCLUDED.observed_at_ms,
                             status=EXCLUDED.status,
                             spans=EXCLUDED.spans,
                             received_at=EXCLUDED.received_at`,
              [
                args.scope.tenant,
                args.scope.environment,
                args.scope.agentId,
                args.exporterDelivery.sourceInstanceId,
                args.exporterDelivery.sequence,
                args.exporterDelivery.observedAtMs,
                args.exporterDelivery.status,
                JSON.stringify(args.spans),
                now,
              ],
            );
          } else {
            ignoredIncoming = true;
          }
        }

        const sourceRows = await client.query<PreflightSourceEvidenceRow>(
          `SELECT source_instance_id, sequence, observed_at_ms, status, spans, received_at
             FROM preflight_source_evidence
            WHERE tenant=$1 AND environment=$2 AND agent_id=$3
              AND received_at >= $4::timestamptz - ($5::double precision * interval '1 millisecond')
            ORDER BY source_instance_id`,
          [
            args.scope.tenant,
            args.scope.environment,
            args.scope.agentId,
            now,
            preflightActiveSourceTtlMs(args.config),
          ],
        );
        const activeSources = sourceRows.rows.map(rowToSourceEvidence);

        if (
          previous &&
          args.disabled === undefined &&
          ((args.exporterDelivery !== undefined && ignoredIncoming) ||
            (args.exporterDelivery === undefined &&
              args.revalidate !== true &&
              activeSources.length > 0))
        ) {
          await client.query('COMMIT');
          return { result: previous, selfAlertTransition: null };
        }

        const disabled =
          args.disabled !== undefined ? args.disabled : previous?.state === 'disabled';
        const disabledReason =
          args.disabled !== undefined
            ? args.disabledReason
            : previous?.state === 'disabled'
              ? previous.reason
              : undefined;

        let selectedSource: SourceEvidence | undefined;
        if (!disabled && activeSources.length > 0) {
          selectedSource = activeSources
            .map((source) => ({
              source,
              raw: evaluatePreflight({
                scope: args.scope,
                spans: source.spans,
                exporterDelivery: {
                  ...source.signal,
                  // Receipt time is the trusted liveness clock. The reporter's
                  // observedAtMs is retained as evidence but never compares peers.
                  observedAtMs: source.receivedAt.getTime(),
                },
                now,
                config: args.config,
              }),
            }))
            .sort((left, right) => {
              const rank =
                STATE_RANK[left.raw.state as keyof typeof STATE_RANK] -
                STATE_RANK[right.raw.state as keyof typeof STATE_RANK];
              if (rank !== 0) return rank;
              const reason = reasonPriority(left.raw) - reasonPriority(right.raw);
              if (reason !== 0) return reason;
              return left.source.signal.sourceInstanceId.localeCompare(
                right.source.signal.sourceInstanceId,
              );
            })[0]!.source;
        }

        const result = evaluatePreflight({
          scope: args.scope,
          spans: selectedSource
            ? selectedSource.spans
            : args.revalidate
              ? []
              : args.spans,
          heartbeat: selectedSource || args.revalidate ? undefined : args.heartbeat,
          exporterDelivery: selectedSource
            ? {
                ...selectedSource.signal,
                observedAtMs: selectedSource.receivedAt.getTime(),
              }
            : undefined,
          now,
          config: args.config,
          previous,
          disabled,
          disabledReason,
        });

        const representative = selectedSource ?? acceptedIncoming;
        await client.query(
          `INSERT INTO preflight_state
             (tenant, environment, agent_id, state, reason_code, reason, evaluated_at,
              last_good_at, required_field_coverage_percent, orphan_rate_percent,
              freshness_ms, pending_recovery_state, pending_since,
              evidence_watermark_ms, evidence_version,
              exporter_source_instance_id, exporter_sequence,
              exporter_observed_at_ms, exporter_status, exporter_spans)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16,$17,$18,$19::jsonb)
           ON CONFLICT (tenant, environment, agent_id) DO UPDATE SET
             state=EXCLUDED.state,
             reason_code=EXCLUDED.reason_code,
             reason=EXCLUDED.reason,
             evaluated_at=EXCLUDED.evaluated_at,
             last_good_at=EXCLUDED.last_good_at,
             required_field_coverage_percent=EXCLUDED.required_field_coverage_percent,
             orphan_rate_percent=EXCLUDED.orphan_rate_percent,
             freshness_ms=EXCLUDED.freshness_ms,
             pending_recovery_state=EXCLUDED.pending_recovery_state,
             pending_since=EXCLUDED.pending_since,
             evidence_watermark_ms=EXCLUDED.evidence_watermark_ms,
             evidence_version=preflight_state.evidence_version + 1,
             exporter_source_instance_id=EXCLUDED.exporter_source_instance_id,
             exporter_sequence=EXCLUDED.exporter_sequence,
             exporter_observed_at_ms=EXCLUDED.exporter_observed_at_ms,
             exporter_status=EXCLUDED.exporter_status,
             exporter_spans=EXCLUDED.exporter_spans`,
          [
            args.scope.tenant,
            args.scope.environment,
            args.scope.agentId,
            result.state,
            result.reasonCode,
            result.reason,
            result.evaluatedAt,
            result.lastGoodAt,
            result.requiredFieldCoveragePercent,
            result.orphanRatePercent,
            result.freshnessMs,
            result.pendingRecoveryState,
            result.pendingSince,
            representative?.signal.observedAtMs ??
              existing.rows[0]?.evidence_watermark_ms ??
              null,
            representative?.signal.sourceInstanceId ?? null,
            representative?.signal.sequence ?? null,
            representative?.signal.observedAtMs ?? null,
            representative?.signal.status ?? null,
            JSON.stringify(representative?.spans ?? []),
          ],
        );
        await client.query('COMMIT');
        return {
          result,
          selfAlertTransition: selfAlertTransition(previous, result),
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });
  }
}
