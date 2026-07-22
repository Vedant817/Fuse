import { describe, expect, it } from 'vitest';
import {
  ObserveStepsRequestSchema,
  StepObservationSchema,
} from './detector-observation.js';

const SCOPE = { tenant: 't1', environment: 'prod', agentId: 'agent-1' };
const VALID_STEP = {
  timestampMs: 1_700_000_000_000,
  canonicalShape: 'analyzer:abc123',
  inputTokens: 200,
  outputTokens: 50,
  estimatedCostUsd: 0.001,
};

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
});
