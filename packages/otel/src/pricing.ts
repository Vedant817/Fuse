/**
 * A versioned, clearly-labeled ESTIMATE table — not a live pricing feed,
 * not guaranteed current, and never a substitute for a provider's actual
 * bill. Every cost figure derived from this table is paired with the raw
 * token counts it came from, so it can always be recomputed if a real
 * price changes (AGENTS.md: "label calculated cost as estimated and
 * retain raw token counts").
 */
export interface PriceEntry {
  provider: string;
  model: string;
  /** False when the row exists only to document that no defensible
   * per-token list price is available. Such rows must never emit a $0
   * estimate as though the provider were free. */
  pricingAvailable: boolean;
  inputPricePerMillionTokensUsd: number;
  outputPricePerMillionTokensUsd: number;
  /** ISO date this entry's figures were last checked against the
   * provider's published pricing. */
  effectiveDate: string;
}

export const PRICE_TABLE_VERSION = 'fuse-price-table-v1';

/** Illustrative estimates as of the effectiveDate below — verify against
 * each provider's current published pricing before relying on these for
 * anything beyond directional cost-velocity telemetry. */
export const PRICE_TABLE: readonly PriceEntry[] = [
  {
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    pricingAvailable: true,
    inputPricePerMillionTokensUsd: 0.05,
    outputPricePerMillionTokensUsd: 0.08,
    effectiveDate: '2026-07-21',
  },
  {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    pricingAvailable: true,
    inputPricePerMillionTokensUsd: 0.59,
    outputPricePerMillionTokensUsd: 0.79,
    effectiveDate: '2026-07-21',
  },
  // NVIDIA Build's hosted inference is credit-based, not per-token list
  // pricing, as of this writing — 0 is a deliberate "no per-token price
  // exists" placeholder, not a claim that usage is free. `priced: false`
  // is what callers should actually branch on (see estimateCostUsd).
  {
    provider: 'nvidia',
    model: 'meta/llama-3.1-8b-instruct',
    pricingAvailable: false,
    inputPricePerMillionTokensUsd: 0,
    outputPricePerMillionTokensUsd: 0,
    effectiveDate: '2026-07-21',
  },
];

export interface CostEstimate {
  costUsd: number;
  /** false means no price-table entry matched — `costUsd` is 0 and MUST
   * NOT be treated as "this call was free." Callers should omit cost
   * attributes/metrics entirely rather than emit a misleading zero. */
  priced: boolean;
  priceTableVersion: string;
}

export function estimateCostUsd(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): CostEstimate {
  const entry = PRICE_TABLE.find((e) => e.provider === provider && e.model === model);
  if (!entry || !entry.pricingAvailable) {
    return { costUsd: 0, priced: false, priceTableVersion: PRICE_TABLE_VERSION };
  }
  const costUsd =
    (inputTokens / 1_000_000) * entry.inputPricePerMillionTokensUsd +
    (outputTokens / 1_000_000) * entry.outputPricePerMillionTokensUsd;
  return { costUsd, priced: true, priceTableVersion: PRICE_TABLE_VERSION };
}
