/**
 * One observed span, reduced to just the fields Preflight needs to judge
 * "can Fuse actually trust this scope's telemetry right now" — task.md
 * §6.1's required-field list (model, token counts, scoped identity,
 * parent propagation, flow timestamps). "estimated cost inputs" isn't a
 * separate field here: cost is derived from token counts, so token-count
 * presence already covers it.
 */
export interface SpanTelemetrySample {
  timestampMs: number;
  hasRequestModel: boolean;
  hasInputTokens: boolean;
  hasOutputTokens: boolean;
  hasScopedIdentity: boolean;
  hasValidTimestamps: boolean;
  /** True for a span that is legitimately expected to be a root (e.g. the
   * top-level `invoke_agent` span) — such spans are exempt from the
   * orphan-rate calculation, which only judges spans that *should* have a
   * parent. */
  isRootSpan: boolean;
  hasParent: boolean;
}

/** An independent liveness signal — e.g. an SDK/agent heartbeat ping —
 * used specifically to distinguish "no traffic right now" (agent alive,
 * legitimately idle) from "telemetry broke" (task.md §6.1). */
export interface HeartbeatSignal {
  lastSeenAtMs: number;
}

export interface ExporterDeliverySignal {
  status: 'success' | 'failure';
  observedAtMs: number;
  sourceInstanceId: string;
  sequence: number;
}

export interface DetectorProtectionEvidence {
  /** All three direct detectors aggregate within this one execution only. */
  executionId: string;
  /** Pricing status for each completed model call retained in that window. */
  pricingStatuses: readonly ('available' | 'unavailable')[];
  /** False when the direct observation endpoint could not acknowledge evidence. */
  reportingAvailable: boolean;
}

export interface PreflightEvaluatorConfig {
  /** How far back `spans` is expected to cover — used only for
   * documentation/consistency; the evaluator itself trusts whatever
   * samples it's given. */
  windowMs: number;
  /** Below this required-field coverage fraction (0-1), telemetry is
   * judged too broken to trust at all (`blind`), not just `degraded`. */
  blindCoverageThreshold: number;
  /** Above this orphan-rate fraction (0-1), telemetry is judged `blind`. */
  blindOrphanRateThreshold: number;
  /** Above this fraction (0-1) of spans missing input/output token counts,
   * telemetry is judged `blind` regardless of the overall coverage
   * average. Token counts get their own, more sensitive threshold because
   * they are what the brief specifically calls out as the critical
   * blind-spot signal: without them, cost-velocity and context-bloat
   * detection fail entirely even if every other field looks fine — a
   * flat average across all required fields would let this get diluted
   * and under-detected. */
  blindTokenMissingRateThreshold: number;
  /** A heartbeat older than this is no longer treated as proof the agent
   * is alive. */
  heartbeatGraceMs: number;
  /** Once the most recent span is older than this, it's no longer trusted
   * as *current* evidence of protection, even if it looked healthy. */
  maxEvidenceStalenessMs: number;
  /** How long a computed improvement (e.g. blind -> protected) must
   * persist before it's actually committed — fast-to-degrade,
   * slow-to-recover hysteresis, so a single good sample right after a
   * break doesn't immediately flip the status back. */
  minRecoveryDwellMs: number;
}

export const DEFAULT_PREFLIGHT_CONFIG: PreflightEvaluatorConfig = {
  windowMs: 5 * 60_000,
  blindCoverageThreshold: 0.5,
  blindOrphanRateThreshold: 0.5,
  blindTokenMissingRateThreshold: 0.3,
  heartbeatGraceMs: 2 * 60_000,
  maxEvidenceStalenessMs: 5 * 60_000,
  minRecoveryDwellMs: 60_000,
};
