import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DetectorResultSchema, type Scope } from '@fuse/contracts';
import { detectContextBloat, DEFAULT_CONTEXT_BLOAT_CONFIG } from './context-bloat.js';
import { detectCostVelocity, DEFAULT_COST_VELOCITY_CONFIG } from './cost-velocity.js';
import { detectLoopSignature, DEFAULT_LOOP_SIGNATURE_CONFIG } from './loop-signature.js';
import type { StepRecord } from './types.js';

/**
 * task.md §10.1 "Property/fuzz: ... detector invariants". Every detector
 * must be safe to run against ANY step history a real (or buggy) agent
 * integration could ever report — not just the hand-picked fixtures in
 * context-bloat.test.ts/cost-velocity.test.ts/loop-signature.test.ts.
 *
 * The specific invariant fuzzed here — `score` must always be finite — is
 * not a hypothetical: context-bloat.ts's own comment documents a real prior
 * bug where a zero-token first step produced `score: Infinity`, which
 * `JSON.stringify` silently turns into `null` for every HTTP/DB consumer,
 * since `DetectorResultSchema`'s `score: z.number()` has no `.finite()`
 * guard to catch it at the schema layer either. Fuzzing guards against
 * every OTHER edge case in the same class (zero-cost steps, huge token
 * counts, single-element/empty histories, duplicate timestamps) that
 * hand-written fixtures don't happen to cover.
 */

const SCOPE: Scope = { tenant: 't1', environment: 'test', agentId: 'fuzz-agent' };
const NOW = new Date('2026-07-23T00:00:00.000Z');

const stepArbitrary = fc.record({
  timestampMs: fc.integer({ min: 0, max: NOW.getTime() }),
  canonicalShape: fc.string({ minLength: 0, maxLength: 20 }),
  inputTokens: fc.integer({ min: 0, max: 10_000_000 }),
  outputTokens: fc.integer({ min: 0, max: 10_000_000 }),
  estimatedCostUsd: fc.double({ min: 0, max: 1000, noNaN: true }),
});

const stepsArbitrary: fc.Arbitrary<StepRecord[]> = fc.array(stepArbitrary, {
  minLength: 0,
  maxLength: 50,
});

describe('detector invariants (task.md §10.1 property/fuzz)', () => {
  it('detectContextBloat always returns a finite score and a schema-valid result for arbitrary step histories', () => {
    fc.assert(
      fc.property(stepsArbitrary, (steps) => {
        const result = detectContextBloat(
          SCOPE,
          steps,
          DEFAULT_CONTEXT_BLOAT_CONFIG,
          NOW,
        );
        expect(Number.isFinite(result.score)).toBe(true);
        expect(Number.isFinite(result.threshold)).toBe(true);
        expect(() => DetectorResultSchema.parse(result)).not.toThrow();
      }),
    );
  });

  it('detectCostVelocity always returns a finite score and a schema-valid result for arbitrary step histories', () => {
    fc.assert(
      fc.property(stepsArbitrary, (steps) => {
        const result = detectCostVelocity(
          SCOPE,
          steps,
          DEFAULT_COST_VELOCITY_CONFIG,
          NOW,
        );
        expect(Number.isFinite(result.score)).toBe(true);
        expect(Number.isFinite(result.threshold)).toBe(true);
        expect(() => DetectorResultSchema.parse(result)).not.toThrow();
      }),
    );
  });

  it('detectLoopSignature always returns a finite score and a schema-valid result for arbitrary step histories', () => {
    fc.assert(
      fc.property(stepsArbitrary, (steps) => {
        const result = detectLoopSignature(
          SCOPE,
          steps,
          DEFAULT_LOOP_SIGNATURE_CONFIG,
          NOW,
        );
        expect(Number.isFinite(result.score)).toBe(true);
        expect(Number.isFinite(result.threshold)).toBe(true);
        expect(() => DetectorResultSchema.parse(result)).not.toThrow();
      }),
    );
  });

  it('no detector ever fires on a completely empty step history', () => {
    fc.assert(
      fc.property(fc.constant([]), (steps: StepRecord[]) => {
        expect(
          detectContextBloat(SCOPE, steps, DEFAULT_CONTEXT_BLOAT_CONFIG, NOW).fired,
        ).toBe(false);
        expect(
          detectCostVelocity(SCOPE, steps, DEFAULT_COST_VELOCITY_CONFIG, NOW).fired,
        ).toBe(false);
        expect(
          detectLoopSignature(SCOPE, steps, DEFAULT_LOOP_SIGNATURE_CONFIG, NOW).fired,
        ).toBe(false);
      }),
    );
  });
});
