import type { DetectorResult, Scope } from '@fuse/contracts';
import type { StepRecord } from './types.js';

export const COST_VELOCITY_DETECTOR_VERSION = 'cost-velocity-v1';

export interface CostVelocityConfig {
  /** The trailing time window to sum estimated cost over. */
  windowMs: number;
  /** Static, deterministic spend threshold for the window (task.md §4.4:
   * "Implement a deterministic static threshold for the demo" — a learned
   * baseline is explicitly deferred, see the module doc comment). */
  thresholdUsdPerWindow: number;
  /** Low-traffic safeguard: don't evaluate a rate off too few data points
   * (a single expensive call is a cost event, not a *velocity* anomaly). */
  minCallsForSignal: number;
  /** Incomplete-window safeguard: don't divide/compare against a window
   * that has barely started (avoids a near-zero-elapsed-time false spike). */
  minElapsedMsForSignal: number;
}

export const DEFAULT_COST_VELOCITY_CONFIG: CostVelocityConfig = {
  windowMs: 60_000,
  thresholdUsdPerWindow: 0.5,
  minCallsForSignal: 3,
  minElapsedMsForSignal: 2_000,
};

/**
 * Learned-baseline cost velocity (minimum history, outlier-robust,
 * seasonality-aware, cold-start fallback) is explicitly out of scope for
 * this slice — task.md §4.4 marks it optional and lower priority than a
 * working static-threshold detector. Revisit once real production traffic
 * history exists to learn from.
 */
export function detectCostVelocity(
  scope: Scope,
  steps: readonly StepRecord[],
  config: CostVelocityConfig,
  now: Date,
): DetectorResult {
  const windowStartMs = now.getTime() - config.windowMs;
  const inWindow = steps.filter(
    (s) => s.timestampMs >= windowStartMs && s.timestampMs <= now.getTime(),
  );
  const dedupeKey = `cost-velocity:${scope.tenant}/${scope.environment}/${scope.agentId}`;
  const base = {
    detector: 'cost-velocity' as const,
    detectorVersion: COST_VELOCITY_DETECTOR_VERSION,
    scope,
    threshold: config.thresholdUsdPerWindow,
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: now.toISOString(),
    dedupeKey,
  };

  if (inWindow.length < config.minCallsForSignal) {
    return { ...base, fired: false, score: 0, evidence: [] };
  }

  const elapsedMs = inWindow[inWindow.length - 1]!.timestampMs - inWindow[0]!.timestampMs;
  if (elapsedMs < config.minElapsedMsForSignal) {
    return { ...base, fired: false, score: 0, evidence: [] };
  }

  const totalCostUsd = inWindow.reduce((sum, s) => sum + s.estimatedCostUsd, 0);
  const fired = totalCostUsd >= config.thresholdUsdPerWindow;
  return {
    ...base,
    fired,
    score: totalCostUsd,
    evidence: fired
      ? [
          `$${totalCostUsd.toFixed(4)} across ${inWindow.length} calls in the trailing ${config.windowMs}ms window`,
        ]
      : [],
  };
}
