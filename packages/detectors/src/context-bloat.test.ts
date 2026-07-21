import { describe, expect, it } from 'vitest';
import { detectContextBloat, DEFAULT_CONTEXT_BLOAT_CONFIG } from './context-bloat.js';
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

describe('detectContextBloat', () => {
  it('fires on the context-bloat fixture (quadratic input-token growth)', () => {
    const result = detectContextBloat(
      SCOPE,
      buildContextBloatFixture(NOW_MS),
      DEFAULT_CONTEXT_BLOAT_CONFIG,
      NOW,
    );
    expect(result.fired).toBe(true);
  });

  it('stays quiet on the normal fixture', () => {
    const result = detectContextBloat(
      SCOPE,
      buildNormalFixture(NOW_MS),
      DEFAULT_CONTEXT_BLOAT_CONFIG,
      NOW,
    );
    expect(result.fired).toBe(false);
  });

  it('stays quiet on the loop fixture (tokens stay roughly flat, not growing)', () => {
    const result = detectContextBloat(
      SCOPE,
      buildLoopFixture(NOW_MS, 10),
      DEFAULT_CONTEXT_BLOAT_CONFIG,
      NOW,
    );
    expect(result.fired).toBe(false);
  });

  it('stays quiet on the cost-velocity fixture (flat token sizes, just a fast rate)', () => {
    const result = detectContextBloat(
      SCOPE,
      buildCostVelocitySpikeFixture(NOW_MS),
      DEFAULT_CONTEXT_BLOAT_CONFIG,
      NOW,
    );
    expect(result.fired).toBe(false);
  });

  it('stays quiet on a sparse/low-traffic fixture', () => {
    const result = detectContextBloat(
      SCOPE,
      buildSparseFixture(NOW_MS),
      DEFAULT_CONTEXT_BLOAT_CONFIG,
      NOW,
    );
    expect(result.fired).toBe(false);
  });

  it('does not fire on too few steps even if tokens look large (minStepsRequired safeguard)', () => {
    const steps: StepRecord[] = [
      {
        timestampMs: NOW_MS - 1000,
        canonicalShape: 'a',
        inputTokens: 50_000,
        outputTokens: 100,
        estimatedCostUsd: 0.01,
      },
      {
        timestampMs: NOW_MS,
        canonicalShape: 'b',
        inputTokens: 90_000,
        outputTokens: 100,
        estimatedCostUsd: 0.01,
      },
    ];
    const result = detectContextBloat(SCOPE, steps, DEFAULT_CONTEXT_BLOAT_CONFIG, NOW);
    expect(result.fired).toBe(false);
  });

  it('fires immediately on an absolute ceiling breach even without a long growth run', () => {
    const steps: StepRecord[] = Array.from({ length: 5 }, (_, i) => ({
      timestampMs: NOW_MS - (5 - i) * 1000,
      canonicalShape: `s${i}`,
      inputTokens: i === 4 ? 150_000 : 1000, // a sudden jump on the last call
      outputTokens: 50,
      estimatedCostUsd: 0.01,
    }));
    const result = detectContextBloat(SCOPE, steps, DEFAULT_CONTEXT_BLOAT_CONFIG, NOW);
    expect(result.fired).toBe(true);
    expect(result.evidence[0]).toContain('ceiling');
  });

  it('does not penalize a legitimate history compaction/reset (a drop resets the growth run)', () => {
    const steps: StepRecord[] = [
      {
        timestampMs: NOW_MS - 5000,
        canonicalShape: 'a',
        inputTokens: 1000,
        outputTokens: 50,
        estimatedCostUsd: 0.001,
      },
      {
        timestampMs: NOW_MS - 4000,
        canonicalShape: 'b',
        inputTokens: 2000,
        outputTokens: 50,
        estimatedCostUsd: 0.001,
      },
      {
        timestampMs: NOW_MS - 3000,
        canonicalShape: 'c',
        inputTokens: 3000,
        outputTokens: 50,
        estimatedCostUsd: 0.001,
      },
      // compaction: history was summarized, tokens drop back down
      {
        timestampMs: NOW_MS - 2000,
        canonicalShape: 'd',
        inputTokens: 500,
        outputTokens: 50,
        estimatedCostUsd: 0.001,
      },
      {
        timestampMs: NOW_MS - 1000,
        canonicalShape: 'e',
        inputTokens: 600,
        outputTokens: 50,
        estimatedCostUsd: 0.001,
      },
    ];
    const result = detectContextBloat(SCOPE, steps, DEFAULT_CONTEXT_BLOAT_CONFIG, NOW);
    expect(result.fired).toBe(false);
  });

  it('handles a stable large context without flagging it (large but not growing)', () => {
    const steps: StepRecord[] = Array.from({ length: 10 }, (_, i) => ({
      timestampMs: NOW_MS - (10 - i) * 1000,
      canonicalShape: `s${i}`,
      inputTokens: 40_000, // large, but constant
      outputTokens: 50,
      estimatedCostUsd: 0.005,
    }));
    const result = detectContextBloat(SCOPE, steps, DEFAULT_CONTEXT_BLOAT_CONFIG, NOW);
    expect(result.fired).toBe(false);
  });

  it('is robust to a missing/zero token attribute on the first step (avoids a divide-by-zero false positive)', () => {
    const steps: StepRecord[] = [
      {
        timestampMs: NOW_MS - 4000,
        canonicalShape: 'a',
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      },
      {
        timestampMs: NOW_MS - 3000,
        canonicalShape: 'b',
        inputTokens: 100,
        outputTokens: 20,
        estimatedCostUsd: 0.001,
      },
      {
        timestampMs: NOW_MS - 2000,
        canonicalShape: 'c',
        inputTokens: 90,
        outputTokens: 20,
        estimatedCostUsd: 0.001,
      },
      {
        timestampMs: NOW_MS - 1000,
        canonicalShape: 'd',
        inputTokens: 95,
        outputTokens: 20,
        estimatedCostUsd: 0.001,
      },
    ];
    expect(() =>
      detectContextBloat(SCOPE, steps, DEFAULT_CONTEXT_BLOAT_CONFIG, NOW),
    ).not.toThrow();
  });

  it('handles an empty window without crashing (missing token attributes / no data)', () => {
    const result = detectContextBloat(SCOPE, [], DEFAULT_CONTEXT_BLOAT_CONFIG, NOW);
    expect(result.fired).toBe(false);
  });
});
