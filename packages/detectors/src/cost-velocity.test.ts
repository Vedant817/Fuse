import { describe, expect, it } from 'vitest';
import { DEFAULT_COST_VELOCITY_CONFIG, detectCostVelocity } from './cost-velocity.js';
import {
  buildContextBloatFixture,
  buildCostVelocitySpikeFixture,
  buildLoopFixture,
  buildNormalFixture,
  buildSparseFixture,
} from './fixtures.js';
import type { StepRecord } from './types.js';

const SCOPE = { tenant: 't1', environment: 'prod', agentId: 'agent-1' };
const NOW = new Date('2026-07-21T00:00:00.000Z');
const NOW_MS = NOW.getTime();

describe('detectCostVelocity', () => {
  it('fires on the cost-velocity spike fixture ($1.00 in ~4s, threshold $0.50/min)', () => {
    const result = detectCostVelocity(
      SCOPE,
      buildCostVelocitySpikeFixture(NOW_MS),
      DEFAULT_COST_VELOCITY_CONFIG,
      NOW,
    );
    expect(result.fired).toBe(true);
  });

  it('stays quiet on the normal fixture', () => {
    const result = detectCostVelocity(
      SCOPE,
      buildNormalFixture(NOW_MS),
      DEFAULT_COST_VELOCITY_CONFIG,
      NOW,
    );
    expect(result.fired).toBe(false);
  });

  it('stays quiet on the loop fixture (cheap calls, spaced out)', () => {
    const result = detectCostVelocity(
      SCOPE,
      buildLoopFixture(NOW_MS, 10),
      DEFAULT_COST_VELOCITY_CONFIG,
      NOW,
    );
    expect(result.fired).toBe(false);
  });

  it('stays quiet on the context-bloat fixture (expensive but spaced 2s apart, under the window sum)', () => {
    const result = detectCostVelocity(
      SCOPE,
      buildContextBloatFixture(NOW_MS),
      DEFAULT_COST_VELOCITY_CONFIG,
      NOW,
    );
    expect(result.fired).toBe(false);
  });

  it('applies the low-traffic safeguard: does not fire on a single expensive call', () => {
    const steps: StepRecord[] = [
      {
        timestampMs: NOW_MS,
        canonicalShape: 'a',
        inputTokens: 1000,
        outputTokens: 1000,
        estimatedCostUsd: 5,
      },
    ];
    const result = detectCostVelocity(SCOPE, steps, DEFAULT_COST_VELOCITY_CONFIG, NOW);
    expect(result.fired).toBe(false);
  });

  it('applies the incomplete-window safeguard: does not fire when calls are bunched in near-zero elapsed time', () => {
    const steps: StepRecord[] = Array.from({ length: 5 }, () => ({
      timestampMs: NOW_MS, // all at the exact same instant — elapsed ~ 0
      canonicalShape: 'a',
      inputTokens: 100,
      outputTokens: 100,
      estimatedCostUsd: 1,
    }));
    const result = detectCostVelocity(SCOPE, steps, DEFAULT_COST_VELOCITY_CONFIG, NOW);
    expect(result.fired).toBe(false);
  });

  it('stays quiet on a sparse/low-traffic fixture', () => {
    const result = detectCostVelocity(
      SCOPE,
      buildSparseFixture(NOW_MS),
      DEFAULT_COST_VELOCITY_CONFIG,
      NOW,
    );
    expect(result.fired).toBe(false);
  });

  it('detects sustained burn (many moderate calls) as well as a sharp spike', () => {
    const steps: StepRecord[] = Array.from({ length: 30 }, (_, i) => ({
      timestampMs: NOW_MS - (30 - i) * 1000, // 1s apart, 30s total
      canonicalShape: `call-${i}`,
      inputTokens: 500,
      outputTokens: 200,
      estimatedCostUsd: 0.02, // 30 * 0.02 = $0.60, over the $0.50 threshold
    }));
    const result = detectCostVelocity(SCOPE, steps, DEFAULT_COST_VELOCITY_CONFIG, NOW);
    expect(result.fired).toBe(true);
  });

  it('only sums calls actually inside the trailing window, ignoring older calls (a counter-reset-like scenario)', () => {
    const oldExpensiveCalls: StepRecord[] = Array.from({ length: 20 }, (_, i) => ({
      timestampMs: NOW_MS - 10 * 60_000 - i * 1000, // 10+ minutes ago — outside the 60s window
      canonicalShape: `old-${i}`,
      inputTokens: 500,
      outputTokens: 200,
      estimatedCostUsd: 1,
    }));
    const result = detectCostVelocity(
      SCOPE,
      oldExpensiveCalls,
      DEFAULT_COST_VELOCITY_CONFIG,
      NOW,
    );
    expect(result.fired).toBe(false);
  });

  it('handles delayed telemetry / an empty window without crashing', () => {
    const result = detectCostVelocity(SCOPE, [], DEFAULT_COST_VELOCITY_CONFIG, NOW);
    expect(result.fired).toBe(false);
  });

  it('is invariant to delayed/out-of-order delivery of the same calls', () => {
    const ordered: StepRecord[] = [-3000, -1500, 0].map((offset, i) => ({
      timestampMs: NOW_MS + offset,
      canonicalShape: `call-${i}`,
      inputTokens: 100,
      outputTokens: 100,
      estimatedCostUsd: 0.2,
    }));
    const reordered = [ordered[0]!, ordered[2]!, ordered[1]!];
    const expected = detectCostVelocity(
      SCOPE,
      ordered,
      DEFAULT_COST_VELOCITY_CONFIG,
      NOW,
    );
    const actual = detectCostVelocity(
      SCOPE,
      reordered,
      DEFAULT_COST_VELOCITY_CONFIG,
      NOW,
    );
    expect(expected.fired).toBe(true);
    expect(actual).toEqual(expected);
  });

  it('documents (does not fix): a burst split evenly across the trailing-window boundary can hide real spend from a single evaluation — inherent to the fixed window, see task.md §4.4', () => {
    const windowStartMs = NOW_MS - DEFAULT_COST_VELOCITY_CONFIG.windowMs;
    const steps: StepRecord[] = [
      // 3 calls just before the window edge — excluded from this evaluation.
      {
        timestampMs: windowStartMs - 3000,
        canonicalShape: 'a',
        inputTokens: 100,
        outputTokens: 100,
        estimatedCostUsd: 0.1,
      },
      {
        timestampMs: windowStartMs - 2000,
        canonicalShape: 'a',
        inputTokens: 100,
        outputTokens: 100,
        estimatedCostUsd: 0.1,
      },
      {
        timestampMs: windowStartMs - 1000,
        canonicalShape: 'a',
        inputTokens: 100,
        outputTokens: 100,
        estimatedCostUsd: 0.1,
      },
      // 3 calls just after the window edge — the only ones this evaluation sees.
      {
        timestampMs: windowStartMs + 1000,
        canonicalShape: 'a',
        inputTokens: 100,
        outputTokens: 100,
        estimatedCostUsd: 0.1,
      },
      {
        timestampMs: windowStartMs + 2000,
        canonicalShape: 'a',
        inputTokens: 100,
        outputTokens: 100,
        estimatedCostUsd: 0.1,
      },
      {
        timestampMs: windowStartMs + 3000,
        canonicalShape: 'a',
        inputTokens: 100,
        outputTokens: 100,
        estimatedCostUsd: 0.1,
      },
    ];
    // Genuine burst total ($0.60) is over the $0.50 threshold, but only the
    // in-window half ($0.30) is summed, so the detector reports quiet.
    const result = detectCostVelocity(SCOPE, steps, DEFAULT_COST_VELOCITY_CONFIG, NOW);
    expect(result.fired).toBe(false);
  });
});
