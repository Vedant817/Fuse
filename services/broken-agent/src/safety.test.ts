import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_MAX_CALLS,
  ABSOLUTE_MAX_RUNTIME_MS,
  ABSOLUTE_MAX_SPEND_USD,
  ABSOLUTE_MAX_TOTAL_TOKENS,
  clampCeilings,
} from './safety.js';

describe('clampCeilings', () => {
  it('falls back to the absolute maximum when nothing is configured', () => {
    expect(clampCeilings({})).toEqual({
      maxCalls: ABSOLUTE_MAX_CALLS,
      maxRuntimeMs: ABSOLUTE_MAX_RUNTIME_MS,
      maxTotalTokens: ABSOLUTE_MAX_TOTAL_TOKENS,
      maxSpendUsd: ABSOLUTE_MAX_SPEND_USD,
    });
  });

  it('tightens a configured value below the absolute maximum', () => {
    const result = clampCeilings({ maxCalls: 5, maxTotalTokens: 100 });
    expect(result.maxCalls).toBe(5);
    expect(result.maxTotalTokens).toBe(100);
  });

  it('clamps a configured value above the absolute maximum down to it', () => {
    const result = clampCeilings({
      maxCalls: 999_999,
      maxRuntimeMs: 999_999_999,
      maxTotalTokens: 999_999_999,
      maxSpendUsd: 999_999,
    });
    expect(result).toEqual({
      maxCalls: ABSOLUTE_MAX_CALLS,
      maxRuntimeMs: ABSOLUTE_MAX_RUNTIME_MS,
      maxTotalTokens: ABSOLUTE_MAX_TOTAL_TOKENS,
      maxSpendUsd: ABSOLUTE_MAX_SPEND_USD,
    });
  });

  // Regression: `Math.min(NaN, absoluteMax)` is `NaN`, and every `>=`
  // comparison against `NaN` in the run loop is `false` — so a `NaN`
  // ceiling used to silently disable that check for the whole run instead
  // of clamping to the absolute maximum. Found via an audit that fed NaN
  // token/runtime/spend config into `runAnalyzerVerifier` with a custom
  // Model returning huge per-call token counts: totalTokens reached
  // 6,000,000 against a documented ABSOLUTE_MAX_TOTAL_TOKENS of 300,000.
  it('treats NaN in every ceiling field as absent, not as "no limit"', () => {
    const result = clampCeilings({
      maxCalls: NaN,
      maxRuntimeMs: NaN,
      maxTotalTokens: NaN,
      maxSpendUsd: NaN,
    });
    expect(result).toEqual({
      maxCalls: ABSOLUTE_MAX_CALLS,
      maxRuntimeMs: ABSOLUTE_MAX_RUNTIME_MS,
      maxTotalTokens: ABSOLUTE_MAX_TOTAL_TOKENS,
      maxSpendUsd: ABSOLUTE_MAX_SPEND_USD,
    });
    // None of the clamped values are themselves NaN (which would make
    // every `>=` ceiling check downstream silently false).
    for (const value of Object.values(result)) {
      expect(Number.isNaN(value)).toBe(false);
    }
  });

  it('treats +/-Infinity in every ceiling field as absent, not as "no limit"', () => {
    const result = clampCeilings({
      maxCalls: Infinity,
      maxRuntimeMs: -Infinity,
      maxTotalTokens: Infinity,
      maxSpendUsd: -Infinity,
    });
    expect(result).toEqual({
      maxCalls: ABSOLUTE_MAX_CALLS,
      maxRuntimeMs: ABSOLUTE_MAX_RUNTIME_MS,
      maxTotalTokens: ABSOLUTE_MAX_TOTAL_TOKENS,
      maxSpendUsd: ABSOLUTE_MAX_SPEND_USD,
    });
  });

  // Regression: a negative or zero `configured` value passed `Number.isFinite`
  // and went straight into `Math.min(configured, absoluteMax)`, returning the
  // negative/zero value unmodified instead of falling back to the absolute
  // maximum — silently producing a 0-dispatch run indistinguishable from
  // genuine ceiling exhaustion.
  it('treats a negative configured value in every ceiling field as absent, not as a tighter limit', () => {
    const result = clampCeilings({
      maxCalls: -5,
      maxRuntimeMs: -1,
      maxTotalTokens: -100,
      maxSpendUsd: -0.5,
    });
    expect(result).toEqual({
      maxCalls: ABSOLUTE_MAX_CALLS,
      maxRuntimeMs: ABSOLUTE_MAX_RUNTIME_MS,
      maxTotalTokens: ABSOLUTE_MAX_TOTAL_TOKENS,
      maxSpendUsd: ABSOLUTE_MAX_SPEND_USD,
    });
  });

  it('treats a zero configured value in every ceiling field as absent, not as a tighter limit', () => {
    const result = clampCeilings({
      maxCalls: 0,
      maxRuntimeMs: 0,
      maxTotalTokens: 0,
      maxSpendUsd: 0,
    });
    expect(result).toEqual({
      maxCalls: ABSOLUTE_MAX_CALLS,
      maxRuntimeMs: ABSOLUTE_MAX_RUNTIME_MS,
      maxTotalTokens: ABSOLUTE_MAX_TOTAL_TOKENS,
      maxSpendUsd: ABSOLUTE_MAX_SPEND_USD,
    });
  });
});
