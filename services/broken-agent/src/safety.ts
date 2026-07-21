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

export function clampCeilings(configured: SafetyCeilingsConfig): Ceilings {
  return {
    maxCalls: Math.min(configured.maxCalls ?? ABSOLUTE_MAX_CALLS, ABSOLUTE_MAX_CALLS),
    maxRuntimeMs: Math.min(
      configured.maxRuntimeMs ?? ABSOLUTE_MAX_RUNTIME_MS,
      ABSOLUTE_MAX_RUNTIME_MS,
    ),
    maxTotalTokens: Math.min(
      configured.maxTotalTokens ?? ABSOLUTE_MAX_TOTAL_TOKENS,
      ABSOLUTE_MAX_TOTAL_TOKENS,
    ),
    maxSpendUsd: Math.min(
      configured.maxSpendUsd ?? ABSOLUTE_MAX_SPEND_USD,
      ABSOLUTE_MAX_SPEND_USD,
    ),
  };
}

/** A demo-only, clearly-labeled synthetic price — NOT any real provider's
 * actual pricing. The versioned real price table is task.md §3.2's job. */
export const DEMO_PRICE_PER_TOKEN_USD = 0.000002;
