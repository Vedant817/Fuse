import { describe, expect, it } from 'vitest';
import {
  ObserveStepsRequestSchema,
  StepObservationSchema,
} from './detector-observation.js';

const SCOPE = { tenant: 't1', environment: 'prod', agentId: 'agent-1' };
const VALID_STEP = {
  executionId: 'session-1',
  timestampMs: 1_700_000_000_000,
  canonicalShape: 'analyzer:abc123',
  inputTokens: 200,
  outputTokens: 50,
  pricingStatus: 'available',
  estimatedCostUsd: 0.001,
} as const;

describe('StepObservationSchema', () => {
  it('accepts a valid step', () => {
    expect(StepObservationSchema.safeParse(VALID_STEP).success).toBe(true);
  });

  it('rejects a missing canonicalShape', () => {
    const { canonicalShape: _drop, ...rest } = VALID_STEP;
    expect(StepObservationSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects negative token counts', () => {
    expect(
      StepObservationSchema.safeParse({ ...VALID_STEP, inputTokens: -1 }).success,
    ).toBe(false);
  });

  it('represents unavailable pricing as null rather than semantic zero', () => {
    const result = StepObservationSchema.parse({
      ...VALID_STEP,
      pricingStatus: 'unavailable',
      estimatedCostUsd: null,
    });
    expect(result.pricingStatus).toBe('unavailable');
    expect(result.estimatedCostUsd).toBeNull();
  });

  it('rejects missing, oversized, and unsafe execution identifiers', () => {
    const { executionId: _drop, ...missing } = VALID_STEP;
    expect(StepObservationSchema.safeParse(missing).success).toBe(false);
    expect(
      StepObservationSchema.safeParse({ ...VALID_STEP, executionId: 'x'.repeat(129) })
        .success,
    ).toBe(false);
    expect(
      StepObservationSchema.safeParse({ ...VALID_STEP, executionId: 'session/unsafe' })
        .success,
    ).toBe(false);
  });

  it('rejects a missing or inconsistent pricing status', () => {
    const { pricingStatus: _drop, ...missing } = VALID_STEP;
    expect(StepObservationSchema.safeParse(missing).success).toBe(false);
    expect(
      StepObservationSchema.safeParse({
        ...VALID_STEP,
        pricingStatus: 'unavailable',
      }).success,
    ).toBe(false);
  });
});

describe('ObserveStepsRequestSchema', () => {
  it('accepts a scope with one or more steps', () => {
    const result = ObserveStepsRequestSchema.safeParse({
      scope: SCOPE,
      steps: [VALID_STEP, VALID_STEP],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty steps array', () => {
    const result = ObserveStepsRequestSchema.safeParse({ scope: SCOPE, steps: [] });
    expect(result.success).toBe(false);
  });

  it('rejects more than 200 steps in one request', () => {
    const steps = Array.from({ length: 201 }, () => VALID_STEP);
    const result = ObserveStepsRequestSchema.safeParse({ scope: SCOPE, steps });
    expect(result.success).toBe(false);
  });

  it('rejects a missing scope', () => {
    const result = ObserveStepsRequestSchema.safeParse({ steps: [VALID_STEP] });
    expect(result.success).toBe(false);
  });

  it('rejects a request that interleaves multiple executions', () => {
    const result = ObserveStepsRequestSchema.safeParse({
      scope: SCOPE,
      steps: [VALID_STEP, { ...VALID_STEP, executionId: 'session-2' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects observations without execution identity or explicit pricing status', () => {
    const { executionId: _execution, ...withoutExecution } = VALID_STEP;
    const { pricingStatus: _pricing, ...withoutPricing } = VALID_STEP;
    expect(
      ObserveStepsRequestSchema.safeParse({ scope: SCOPE, steps: [withoutExecution] })
        .success,
    ).toBe(false);
    expect(
      ObserveStepsRequestSchema.safeParse({ scope: SCOPE, steps: [withoutPricing] })
        .success,
    ).toBe(false);
  });
});
