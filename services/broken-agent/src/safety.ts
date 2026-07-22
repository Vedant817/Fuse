import type { SafetyCeilingsConfig } from './types.js';

/**
 * Unconditional demo stop thresholds (task.md §3.1). `maxCalls` is a true
 * pre-dispatch hard cap: a misconfigured `maxCalls: 999_999` cannot produce
 * more than `ABSOLUTE_MAX_CALLS` dispatches. Runtime, cumulative tokens, and
 * estimated spend are checked before dispatch and again after a completed
 * call where applicable, but an already-dispatched provider call cannot be
 * cancelled or retroactively made cheaper. Those three thresholds may
 * therefore be exceeded by at most one call's duration/usage; they are not
 * strict upper bounds on provider-side consumption. There is no environment
 * variable or config path that raises any configured threshold.
 */
export const ABSOLUTE_MAX_CALLS = 60;
export const ABSOLUTE_MAX_RUNTIME_MS = 30_000;
export const ABSOLUTE_MAX_TOTAL_TOKENS = 300_000;
export const ABSOLUTE_MAX_SPEND_USD = 2.0;

export interface Ceilings {
  maxCalls: number;
  maxRuntimeMs: number;
  maxTotalTokens: number;
  maxSpendUsd: number;
}

/**
 * `Math.min(configured, absoluteMax)` only "tightens" when `configured` is
 * an ordinary comparable number. `NaN` poisons `Math.min` (it returns
 * `NaN`, not `absoluteMax`), and every `>=` comparison against `NaN` in the
 * run loop below is `false` — so a `NaN` ceiling doesn't tighten to zero
 * dispatches, it silently disables that ceiling's check for the rest of the
 * run. `+Infinity`/`-Infinity` happen to be handled correctly by `Math.min`
 * already, but are rejected here too for the same "reject non-finite
 * input outright" reasoning rather than relying on that being incidental.
 * Any non-finite `configured` value is treated as absent (falls back to
 * the absolute maximum), never as "no limit."
 *
 * The same "treated as absent" rule applies to `configured <= 0`: a zero or
 * negative value is a genuinely unusable ceiling (not a valid, tighter
 * limit), so it falls back to `absoluteMax` too rather than passing through
 * `Math.min` unmodified. Without this, a negative or zero ceiling would
 * silently produce a 0-dispatch run reported as `stopReason:
 * 'safety-ceiling'`, indistinguishable from genuine ceiling exhaustion. A
 * real, positive configured value can only ever tighten the ceiling, never
 * loosen it past `absoluteMax`.
 */
function clampCeiling(configured: number | undefined, absoluteMax: number): number {
  if (configured === undefined || !Number.isFinite(configured) || configured <= 0) {
    return absoluteMax;
  }
  return Math.min(configured, absoluteMax);
}

export function clampCeilings(configured: SafetyCeilingsConfig): Ceilings {
  return {
    maxCalls: clampCeiling(configured.maxCalls, ABSOLUTE_MAX_CALLS),
    maxRuntimeMs: clampCeiling(configured.maxRuntimeMs, ABSOLUTE_MAX_RUNTIME_MS),
    maxTotalTokens: clampCeiling(configured.maxTotalTokens, ABSOLUTE_MAX_TOTAL_TOKENS),
    maxSpendUsd: clampCeiling(configured.maxSpendUsd, ABSOLUTE_MAX_SPEND_USD),
  };
}

/** A demo-only, clearly-labeled synthetic price — NOT actual provider spend.
 * This threshold is a deterministic safety proxy; provider billing remains
 * authoritative. The versioned estimate table lives in @fuse/otel. */
export const DEMO_PRICE_PER_TOKEN_USD = 0.000002;
