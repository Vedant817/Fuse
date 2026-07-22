import type pg from 'pg';
import {
  evaluatePreflight,
  type HeartbeatSignal,
  type PreflightEvaluatorConfig,
} from '@fuse/preflight';
import type { PreflightResult, Scope, SpanTelemetrySampleWire } from '@fuse/contracts';
import { withStoreErrors } from './pool.js';
import { rowToPreflightResult, type PreflightStateRow } from './mapper.js';

export interface EvaluateArgs {
  scope: Scope;
  spans: readonly SpanTelemetrySampleWire[];
  heartbeat?: HeartbeatSignal | undefined;
  config: PreflightEvaluatorConfig;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
}

/**
 * Persists Preflight evaluations so the evaluator's recovery-dwell
 * hysteresis (`@fuse/preflight`) has a previous result to compare
 * against across calls. Uses a plain row lock, not breaker_state's
 * epoch-CAS — see the migration file for why that's an intentional,
 * lower-stakes choice for this store.
 */
export class PreflightStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly clock: () => Date = () => new Date(),
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
    return withStoreErrors(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const existing = await client.query<PreflightStateRow>(
          `SELECT * FROM preflight_state WHERE tenant=$1 AND environment=$2 AND agent_id=$3 FOR UPDATE`,
          [args.scope.tenant, args.scope.environment, args.scope.agentId],
        );
        const previous =
          existing.rows.length > 0 ? rowToPreflightResult(existing.rows[0]!) : undefined;

        // Sticky disable: an operator's explicit `disabled: true` must
        // persist across ordinary telemetry reports that don't mention
        // `disabled` at all — which is what every real agent's routine
        // report looks like (packages/sdk/src/preflight-reporter.ts never
        // sends this field). `evaluatePreflight` itself is a pure function
        // that correctly treats an omitted `disabled` as "evaluate
        // normally" for THAT call (tested, intentional) — it has no
        // concept of persistence, so it's this store's job to carry
        // forward "still disabled" when the caller didn't say otherwise.
        // Only an explicit `disabled: true`/`false` in this specific
        // request changes the disabled status; omitting it must never
        // silently re-enable evaluation for a scope an operator disabled.
        const disabled =
          args.disabled !== undefined ? args.disabled : previous?.state === 'disabled';
        const disabledReason =
          args.disabled !== undefined
            ? args.disabledReason
            : previous?.state === 'disabled'
              ? previous.reason
              : undefined;

        const result = evaluatePreflight({
          scope: args.scope,
          spans: args.spans,
          heartbeat: args.heartbeat,
          now: this.clock(),
          config: args.config,
          previous,
          disabled,
          disabledReason,
        });

        await client.query(
          `INSERT INTO preflight_state
             (tenant, environment, agent_id, state, reason_code, reason, evaluated_at, last_good_at,
              required_field_coverage_percent, orphan_rate_percent, freshness_ms,
              pending_recovery_state, pending_since)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (tenant, environment, agent_id) DO UPDATE SET
             state = EXCLUDED.state,
             reason_code = EXCLUDED.reason_code,
             reason = EXCLUDED.reason,
             evaluated_at = EXCLUDED.evaluated_at,
             last_good_at = EXCLUDED.last_good_at,
             required_field_coverage_percent = EXCLUDED.required_field_coverage_percent,
             orphan_rate_percent = EXCLUDED.orphan_rate_percent,
             freshness_ms = EXCLUDED.freshness_ms,
             pending_recovery_state = EXCLUDED.pending_recovery_state,
             pending_since = EXCLUDED.pending_since`,
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
          ],
        );
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });
  }
}
