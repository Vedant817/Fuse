import type { DetectorResult, Scope } from '@fuse/contracts';
import type { StepRecord } from './types.js';

export const CONTEXT_BLOAT_DETECTOR_VERSION = 'context-bloat-v1';

export interface ContextBloatConfig {
  /** Fires immediately if any single step's input tokens reach this. */
  absoluteCeilingTokens: number;
  /** Fires if this many consecutive steps show strictly-increasing input
   * tokens — a legitimate history compaction/reset breaks the run instead
   * of being misread as "not growing enough yet." */
  minConsecutiveGrowthSteps: number;
  /** Fires if last/first input-token ratio over the window reaches this,
   * even without a perfectly monotonic run (catches noisy-but-growing
   * traces the consecutive-run check might miss). */
  minGrowthRatio: number;
  /** Minimum steps in the window before evaluating at all — avoids
   * flagging a session that has only just started. */
  minStepsRequired: number;
}

export const DEFAULT_CONTEXT_BLOAT_CONFIG: ContextBloatConfig = {
  absoluteCeilingTokens: 100_000,
  minConsecutiveGrowthSteps: 5,
  minGrowthRatio: 3,
  minStepsRequired: 4,
};

export function detectContextBloat(
  scope: Scope,
  steps: readonly StepRecord[],
  config: ContextBloatConfig,
  now: Date,
): DetectorResult {
  const windowStart =
    steps.length > 0 ? new Date(steps[0]!.timestampMs).toISOString() : now.toISOString();
  const base: Omit<DetectorResult, 'fired' | 'score' | 'evidence'> = {
    detector: 'context-bloat',
    detectorVersion: CONTEXT_BLOAT_DETECTOR_VERSION,
    scope,
    threshold: config.absoluteCeilingTokens,
    windowStart,
    windowEnd: now.toISOString(),
    dedupeKey: `context-bloat:${scope.tenant}/${scope.environment}/${scope.agentId}`,
  };

  if (steps.length < config.minStepsRequired) {
    return { ...base, fired: false, score: 0, evidence: [] };
  }

  const maxInputTokens = Math.max(...steps.map((s) => s.inputTokens));
  if (maxInputTokens >= config.absoluteCeilingTokens) {
    return {
      ...base,
      fired: true,
      score: maxInputTokens,
      evidence: [
        `input tokens reached ${maxInputTokens}, ceiling is ${config.absoluteCeilingTokens}`,
      ],
    };
  }

  const consecutiveGrowth = longestTrailingIncreasingRun(steps.map((s) => s.inputTokens));
  if (consecutiveGrowth >= config.minConsecutiveGrowthSteps) {
    return {
      ...base,
      fired: true,
      score: consecutiveGrowth,
      threshold: config.minConsecutiveGrowthSteps,
      evidence: [
        `${consecutiveGrowth} consecutive steps of strictly increasing input tokens`,
      ],
    };
  }

  const first = steps[0]!.inputTokens;
  const last = steps[steps.length - 1]!.inputTokens;
  const ratio = first > 0 ? last / first : last > 0 ? Number.POSITIVE_INFINITY : 0;
  if (ratio >= config.minGrowthRatio) {
    return {
      ...base,
      fired: true,
      score: ratio,
      threshold: config.minGrowthRatio,
      evidence: [
        `input tokens grew ${ratio.toFixed(1)}x over the window (${first} -> ${last})`,
      ],
    };
  }

  return { ...base, fired: false, score: consecutiveGrowth, evidence: [] };
}

/** Length of the longest run of strictly-increasing values ending at the
 * last element — a compaction/reset (a value <= its predecessor) breaks
 * the run rather than being counted against it. */
function longestTrailingIncreasingRun(values: readonly number[]): number {
  let run = 1;
  for (let i = values.length - 1; i > 0; i--) {
    if (values[i]! > values[i - 1]!) {
      run += 1;
    } else {
      break;
    }
  }
  return values.length > 0 ? run : 0;
}
