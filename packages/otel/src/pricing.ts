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

export const PRICE_TABLE_VERSION = 'fuse-price-table-v2';

/** Illustrative estimates as of the effectiveDate below — verify against
 * each provider's current published pricing before relying on these for
 * anything beyond directional cost-velocity telemetry. */
export const PRICE_TABLE: readonly PriceEntry[] = [
  {
    // Demo-only synthetic pricing for the bounded broken-agent cost-velocity
    // scenario. It is an estimate fixture, not a provider price or real bill.
    provider: 'fuse-synthetic',
    model: 'mock-cost-velocity-v1',
    pricingAvailable: true,
    inputPricePerMillionTokensUsd: 2.5,
    outputPricePerMillionTokensUsd: 5,
    effectiveDate: '2026-08-24',
  },
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

export type CostEstimate =
  | {
      costUsd: number;
      priced: true;
      priceTableVersion: string;
    }
  | {
      /** `null` is intentionally not a numeric placeholder. No defensible
       * estimate exists for this provider/model pair. */
      costUsd: null;
      priced: false;
      priceTableVersion: string;
    };

export function estimateCostUsd(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): CostEstimate {
  const entry = PRICE_TABLE.find((e) => e.provider === provider && e.model === model);
  if (!entry || !entry.pricingAvailable) {
    return { costUsd: null, priced: false, priceTableVersion: PRICE_TABLE_VERSION };
  }
  const costUsd =
    (inputTokens / 1_000_000) * entry.inputPricePerMillionTokensUsd +
    (outputTokens / 1_000_000) * entry.outputPricePerMillionTokensUsd;
  return { costUsd, priced: true, priceTableVersion: PRICE_TABLE_VERSION };
}
