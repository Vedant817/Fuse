import type { StepRecord } from './types.js';

/**
 * Deterministic, synthetic, non-sensitive telemetry fixtures — no real
 * prompt/tool content, no timing randomness — for detector unit tests and
 * threshold tuning (task.md §4.1's "deterministic fixture/replay tooling
 * from synthetic, non-sensitive telemetry").
 */

export function buildNormalFixture(now: number): StepRecord[] {
  return [
    {
      timestampMs: now - 3000,
      canonicalShape: 'analyzer:draft',
      inputTokens: 200,
      outputTokens: 80,
      estimatedCostUsd: 0.001,
    },
    {
      timestampMs: now - 2000,
      canonicalShape: 'verifier:review',
      inputTokens: 260,
      outputTokens: 40,
      estimatedCostUsd: 0.001,
    },
    {
      timestampMs: now - 1000,
      canonicalShape: 'analyzer:revise',
      inputTokens: 300,
      outputTokens: 90,
      estimatedCostUsd: 0.001,
    },
    {
      timestampMs: now,
      canonicalShape: 'verifier:approve',
      inputTokens: 340,
      outputTokens: 20,
      estimatedCostUsd: 0.001,
    },
  ];
}

/** Cycle-length-2 Analyzer/Verifier ping-pong repeated well past any
 * reasonable "just iterating normally" bound. */
export function buildLoopFixture(now: number, repetitions = 10): StepRecord[] {
  const steps: StepRecord[] = [];
  for (let i = 0; i < repetitions; i++) {
    steps.push({
      timestampMs: now - (repetitions - i) * 2000,
      canonicalShape: 'analyzer:draft-unchanged',
      inputTokens: 200,
      outputTokens: 50,
      estimatedCostUsd: 0.0005,
    });
    steps.push({
      timestampMs: now - (repetitions - i) * 2000 + 1000,
      canonicalShape: 'verifier:needs-revision',
      inputTokens: 220,
      outputTokens: 30,
      estimatedCostUsd: 0.0005,
    });
  }
  return steps;
}

/** Input tokens growing every step because history is never compacted. */
export function buildContextBloatFixture(now: number, steps = 12): StepRecord[] {
  return Array.from({ length: steps }, (_, i) => ({
    timestampMs: now - (steps - i) * 2000,
    canonicalShape: `step-${i}`,
    inputTokens: 500 * (i + 1) * (i + 1), // quadratic growth, clearly not noise
    outputTokens: 50,
    estimatedCostUsd: 0.0002 * (i + 1),
  }));
}

/** Many calls in a short window summing to a cost spend spike. */
export function buildCostVelocitySpikeFixture(now: number, calls = 20): StepRecord[] {
  return Array.from({ length: calls }, (_, i) => ({
    timestampMs: now - (calls - i) * 200, // 200ms apart: a burst
    canonicalShape: `burst-${i}`,
    inputTokens: 300,
    outputTokens: 100,
    estimatedCostUsd: 0.05, // 20 * 0.05 = $1.00 in ~4s
  }));
}

/** Sparse, low-traffic workload — should never fire any detector. */
export function buildSparseFixture(now: number): StepRecord[] {
  return [
    {
      timestampMs: now - 3_600_000,
      canonicalShape: 'occasional-call',
      inputTokens: 150,
      outputTokens: 60,
      estimatedCostUsd: 0.0003,
    },
  ];
}
