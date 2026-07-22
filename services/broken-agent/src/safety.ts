import type { SafetyCeilingsConfig } from './types.js';

/**
 * Hard, unconditional demo safety ceilings (task.md §3.1). These are
 * absolute in-code maximums, not defaults — `clampCeilings` only ever
 * *tightens* a caller-configured value, never loosens past these numbers.
 * A misconfigured `maxCalls: 999_999` cannot produce more than
 * `ABSOLUTE_MAX_CALLS` real dispatches; there is no environment variable
 * or config path that raises these ceilings. This is a backstop
 * independent of the breaker itself — even if enforcement were somehow
 * bypassed or misconfigured, the fixture still cannot run away.
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
 */
function clampCeiling(configured: number | undefined, absoluteMax: number): number {
  if (configured === undefined || !Number.isFinite(configured)) {
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

/** A demo-only, clearly-labeled synthetic price — NOT any real provider's
 * actual pricing. The versioned real price table is task.md §3.2's job. */
export const DEMO_PRICE_PER_TOKEN_USD = 0.000002;
