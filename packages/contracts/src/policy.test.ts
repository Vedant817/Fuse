import { describe, expect, it } from 'vitest';
import {
  ContextBloatDetectorConfigSchema,
  CostVelocityDetectorConfigSchema,
  DetectorsConfigSchema,
  LoopSignatureDetectorConfigSchema,
  PolicySchema,
} from './policy.js';

const MINIMAL_POLICY = {
  policyVersion: 'v1',
  scope: { tenant: 't1', environment: 'prod' },
};

describe('PolicySchema', () => {
  it('accepts a minimal policy and fills in every default, including detectors', () => {
    const result = PolicySchema.safeParse(MINIMAL_POLICY);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.cooldownSeconds).toBe(300);
    expect(result.data.storeOutageMode).toBe('fail-closed');
    expect(result.data.controlPlaneOutageMode).toBe('fail-closed');
    expect(result.data.notificationRoutes).toEqual([]);
    expect(result.data.detectors).toEqual({});
  });

  it('accepts a policy with explicit per-detector config overrides', () => {
    const result = PolicySchema.safeParse({
      ...MINIMAL_POLICY,
      detectors: {
        'cost-velocity': { thresholdUsdPerWindow: 1.5 },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.detectors['cost-velocity']).toEqual({
      windowMs: 60_000,
      thresholdUsdPerWindow: 1.5,
      minCallsForSignal: 3,
      minElapsedMsForSignal: 2_000,
    });
  });

  it('rejects an unknown detector key', () => {
    const result = PolicySchema.safeParse({
      ...MINIMAL_POLICY,
      detectors: { 'not-a-real-detector': {} },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative cooldown', () => {
    const result = PolicySchema.safeParse({ ...MINIMAL_POLICY, cooldownSeconds: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects notification routes the runtime cannot deliver', () => {
    const result = PolicySchema.safeParse({
      ...MINIMAL_POLICY,
      notificationRoutes: ['pager-that-is-not-implemented'],
    });
    expect(result.success).toBe(false);
  });
});

describe('DetectorsConfigSchema', () => {
  it('allows an empty object (all detectors default)', () => {
    const result = DetectorsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('per-detector config schemas', () => {
  it('LoopSignatureDetectorConfigSchema fills in documented defaults', () => {
    const result = LoopSignatureDetectorConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ windowSize: 40, minRepetitions: 3, maxCycleLength: 4 });
  });

  it('ContextBloatDetectorConfigSchema fills in documented defaults', () => {
    const result = ContextBloatDetectorConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      absoluteCeilingTokens: 100_000,
      minConsecutiveGrowthSteps: 5,
      minGrowthRatio: 3,
      minInputTokensForGrowthSignal: 8_000,
      minStepsRequired: 4,
    });
  });

  it('CostVelocityDetectorConfigSchema fills in documented defaults', () => {
    const result = CostVelocityDetectorConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      windowMs: 60_000,
      thresholdUsdPerWindow: 0.5,
      minCallsForSignal: 3,
      minElapsedMsForSignal: 2_000,
    });
  });

  it('rejects a non-positive windowSize', () => {
    const result = LoopSignatureDetectorConfigSchema.safeParse({ windowSize: 0 });
    expect(result.success).toBe(false);
  });
});
