import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from './pricing.js';

describe('estimateCostUsd', () => {
  it('labels the bounded demo cost-velocity model with explicit synthetic estimated pricing', () => {
    const result = estimateCostUsd(
      'fuse-synthetic',
      'mock-cost-velocity-v1',
      50_000,
      10_000,
    );
    expect(result).toEqual({
      costUsd: 0.175,
      priced: true,
      priceTableVersion: 'fuse-price-table-v2',
    });
  });

  it('computes cost from the price table for a known provider/model', () => {
    const result = estimateCostUsd('groq', 'llama-3.1-8b-instant', 1_000_000, 1_000_000);
    expect(result.priced).toBe(true);
    expect(result.costUsd).toBeCloseTo(0.05 + 0.08, 5);
  });

  it('scales linearly with token counts', () => {
    const result = estimateCostUsd('groq', 'llama-3.1-8b-instant', 500_000, 0);
    expect(result.costUsd).toBeCloseTo(0.025, 5);
  });

  it('reports priced:false (not a misleading zero cost) for an unknown model', () => {
    const result = estimateCostUsd('groq', 'nonexistent-model', 1000, 1000);
    expect(result.priced).toBe(false);
    expect(result.costUsd).toBeNull();
  });

  it('reports priced:false for an unknown provider even with a known model name', () => {
    const result = estimateCostUsd(
      'some-other-provider',
      'llama-3.1-8b-instant',
      1000,
      1000,
    );
    expect(result.priced).toBe(false);
  });

  it('reports priced:false for a documented model whose provider has no per-token list price', () => {
    const result = estimateCostUsd(
      'nvidia',
      'meta/llama-3.1-8b-instruct',
      1_000_000,
      1_000_000,
    );
    expect(result).toEqual({
      costUsd: null,
      priced: false,
      priceTableVersion: 'fuse-price-table-v2',
    });
  });
});
