import type { DetectorResult } from '@fuse/contracts';
import type { Scope } from '@fuse/contracts';
import type { StepRecord } from './types.js';

export const LOOP_SIGNATURE_DETECTOR_VERSION = 'loop-signature-v1';

export interface LoopSignatureConfig {
  /** How many trailing steps to examine. */
  windowSize: number;
  /** Minimum number of full-cycle repeats required to fire — this is what
   * distinguishes "the agent looped twice, unremarkable" from a
   * pathological, progress-free repetition. */
  minRepetitions: number;
  /** Search cycle lengths 1..maxCycleLength (1 = immediate repeat, 2 =
   * A,B,A,B ping-pong, etc). */
  maxCycleLength: number;
}

export const DEFAULT_LOOP_SIGNATURE_CONFIG: LoopSignatureConfig = {
  windowSize: 40,
  minRepetitions: 3,
  maxCycleLength: 4,
};

/**
 * Looks for a repeating cycle of canonical step shapes at the *end* of the
 * window — the most recent behavior, which is what matters for "is this
 * agent looping right now." Consecutive repeats are cycle length 1;
 * Analyzer↔Verifier ping-pong is typically cycle length 2. Returns the
 * best (highest-repetition) match across all tried cycle lengths so a
 * long cycle-1 run and a shorter but still-qualifying cycle-2 run don't
 * silently mask each other.
 */
export function detectLoopSignature(
  scope: Scope,
  steps: readonly StepRecord[],
  config: LoopSignatureConfig,
  now: Date,
): DetectorResult {
  const window = [...steps]
    .sort((a, b) => a.timestampMs - b.timestampMs)
    .slice(-config.windowSize);
  const windowStart =
    window.length > 0
      ? new Date(window[0]!.timestampMs).toISOString()
      : now.toISOString();

  let bestCycleLength = 0;
  let bestRepetitions = 0;

  for (let cycleLength = 1; cycleLength <= config.maxCycleLength; cycleLength++) {
    const repetitions = countTrailingCycleRepetitions(window, cycleLength);
    if (repetitions > bestRepetitions) {
      bestRepetitions = repetitions;
      bestCycleLength = cycleLength;
    }
  }

  const fired = bestRepetitions >= config.minRepetitions;
  const dedupeKey = `loop-signature:${scope.tenant}/${scope.environment}/${scope.agentId}`;

  return {
    detector: 'loop-signature',
    detectorVersion: LOOP_SIGNATURE_DETECTOR_VERSION,
    scope,
    fired,
    score: bestRepetitions,
    threshold: config.minRepetitions,
    windowStart,
    windowEnd: now.toISOString(),
    evidence: fired
      ? [
          `cycle length ${bestCycleLength} repeated ${bestRepetitions} times in the trailing ${window.length} steps`,
        ]
      : [],
    dedupeKey,
  };
}

/** How many times does the cycle-of-length-N ending the array repeat,
 * counting backwards from the end? Returns 0/1 if there isn't enough data
 * or the trailing steps don't form a clean repeating cycle of this length. */
function countTrailingCycleRepetitions(
  window: readonly StepRecord[],
  cycleLength: number,
): number {
  if (window.length < cycleLength * 2) return 0;
  const shapes = window.map((s) => s.canonicalShape);
  const cycle = shapes.slice(-cycleLength);

  let repetitions = 0;
  let cursor = shapes.length;
  while (cursor - cycleLength >= 0) {
    const candidate = shapes.slice(cursor - cycleLength, cursor);
    if (!arraysEqual(candidate, cycle)) break;
    repetitions += 1;
    cursor -= cycleLength;
  }
  return repetitions;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
