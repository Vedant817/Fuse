import { describe, expect, it } from 'vitest';
import {
  buildContextBloatFixture,
  buildCostVelocitySpikeFixture,
  buildLoopFixture,
  buildNormalFixture,
  buildSparseFixture,
} from './fixtures.js';
import { DEFAULT_LOOP_SIGNATURE_CONFIG, detectLoopSignature } from './loop-signature.js';

const SCOPE = { tenant: 't1', environment: 'prod', agentId: 'agent-1' };
const NOW = new Date('2026-07-21T00:00:00.000Z');
const NOW_MS = NOW.getTime();

describe('detectLoopSignature', () => {
  it('fires on the Analyzer/Verifier ping-pong (cycle length 2) fixture', () => {
    const result = detectLoopSignature(
      SCOPE,
      buildLoopFixture(NOW_MS, 10),
      DEFAULT_LOOP_SIGNATURE_CONFIG,
      NOW,
    );
    expect(result.fired).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(
      DEFAULT_LOOP_SIGNATURE_CONFIG.minRepetitions,
    );
  });

  it('stays quiet on the normal fixture', () => {
    const result = detectLoopSignature(
      SCOPE,
      buildNormalFixture(NOW_MS),
      DEFAULT_LOOP_SIGNATURE_CONFIG,
      NOW,
    );
    expect(result.fired).toBe(false);
  });

  it('stays quiet on the context-bloat fixture (distinct step shapes, no repeats)', () => {
    const result = detectLoopSignature(
      SCOPE,
      buildContextBloatFixture(NOW_MS),
      DEFAULT_LOOP_SIGNATURE_CONFIG,
      NOW,
    );
    expect(result.fired).toBe(false);
  });

  it('stays quiet on the cost-velocity fixture (distinct step shapes, no repeats)', () => {
    const result = detectLoopSignature(
      SCOPE,
      buildCostVelocitySpikeFixture(NOW_MS),
      DEFAULT_LOOP_SIGNATURE_CONFIG,
      NOW,
    );
    expect(result.fired).toBe(false);
  });

  it('stays quiet on a sparse/low-traffic fixture', () => {
    const result = detectLoopSignature(
      SCOPE,
      buildSparseFixture(NOW_MS),
      DEFAULT_LOOP_SIGNATURE_CONFIG,
      NOW,
    );
    expect(result.fired).toBe(false);
  });

  it('does not fire on a short, legitimate bounded loop (2 repetitions, below the minimum)', () => {
    const steps = buildLoopFixture(NOW_MS, 2); // only 2 cycles — a normal bounded retry, not pathological
    const result = detectLoopSignature(SCOPE, steps, DEFAULT_LOOP_SIGNATURE_CONFIG, NOW);
    expect(result.fired).toBe(false);
  });

  it('detects a cycle-length-1 (immediate consecutive repeat), not just cycle-length-2', () => {
    const steps = Array.from({ length: 8 }, (_, i) => ({
      timestampMs: NOW_MS - (8 - i) * 1000,
      canonicalShape: 'retry:same-request',
      inputTokens: 100,
      outputTokens: 20,
      estimatedCostUsd: 0.0001,
    }));
    const result = detectLoopSignature(SCOPE, steps, DEFAULT_LOOP_SIGNATURE_CONFIG, NOW);
    expect(result.fired).toBe(true);
  });

  it('handles missing/delayed spans gracefully (fewer steps than window, no crash)', () => {
    const result = detectLoopSignature(SCOPE, [], DEFAULT_LOOP_SIGNATURE_CONFIG, NOW);
    expect(result.fired).toBe(false);
    expect(result.score).toBe(0);
  });

  it('is invariant to delayed/out-of-order delivery of the same steps', () => {
    const ordered = buildLoopFixture(NOW_MS, 5);
    const reordered = [...ordered].sort((a, b) =>
      a.timestampMs === b.timestampMs ? 0 : a.timestampMs < b.timestampMs ? 1 : -1,
    );
    const expected = detectLoopSignature(
      SCOPE,
      ordered,
      DEFAULT_LOOP_SIGNATURE_CONFIG,
      NOW,
    );
    const actual = detectLoopSignature(
      SCOPE,
      reordered,
      DEFAULT_LOOP_SIGNATURE_CONFIG,
      NOW,
    );
    expect(expected.fired).toBe(true);
    expect(actual).toEqual(expected);
  });

  it('handles a high-volume window without misclassifying noisy-but-distinct steps as a loop', () => {
    const steps = Array.from({ length: 100 }, (_, i) => ({
      timestampMs: NOW_MS - (100 - i) * 100,
      canonicalShape: `distinct-step-${i}`, // every step is unique
      inputTokens: 200,
      outputTokens: 50,
      estimatedCostUsd: 0.0002,
    }));
    const result = detectLoopSignature(SCOPE, steps, DEFAULT_LOOP_SIGNATURE_CONFIG, NOW);
    expect(result.fired).toBe(false);
  });
});
