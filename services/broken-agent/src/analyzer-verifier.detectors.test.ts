import type { StepObservationInputWire, StepObservationWire } from '@fuse/contracts';
import {
  DEFAULT_CONTEXT_BLOAT_CONFIG,
  DEFAULT_COST_VELOCITY_CONFIG,
  DEFAULT_LOOP_SIGNATURE_CONFIG,
  detectContextBloat,
  detectCostVelocity,
  detectLoopSignature,
} from '@fuse/detectors';
import { FuseGuard } from '@fuse/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAnalyzerVerifier } from './analyzer-verifier.js';
import type { Scenario } from './types.js';

const SCOPE = { tenant: 't1', environment: 'test', agentId: 'broken-agent' };

function collectingGuard(observed: StepObservationInputWire[]): FuseGuard {
  const fetchImpl = vi.fn().mockImplementation((input: string | URL | Request) => {
    const body = String(input).endsWith('/v1/detectors/observe')
      ? { results: [], enforcement: [] }
      : {
          allowed: true,
          state: 'armed',
          reason: 'armed',
          epoch: 0,
          degraded: false,
          correlationId: 'detector-e2e',
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const guard = new FuseGuard({
    scope: SCOPE,
    controlPlaneUrl: 'http://cp.internal',
    apiToken: 'tok',
    fetchImpl,
  });
  vi.spyOn(guard, 'recordStepObservation').mockImplementation(async (step) => {
    observed.push(step);
  });
  return guard;
}

function evaluate(observed: StepObservationInputWire[]) {
  const now = new Date(Math.max(...observed.map((step) => step.timestampMs)));
  const detectorSteps: StepObservationWire[] = observed.map((step) => ({
    ...step,
    estimatedCostUsd: step.estimatedCostUsd ?? 0,
  }));
  return [
    detectLoopSignature(SCOPE, detectorSteps, DEFAULT_LOOP_SIGNATURE_CONFIG, now),
    detectContextBloat(SCOPE, detectorSteps, DEFAULT_CONTEXT_BLOAT_CONFIG, now),
    detectCostVelocity(SCOPE, detectorSteps, DEFAULT_COST_VELOCITY_CONFIG, now),
  ];
}

async function runScenario(scenario: Scenario): Promise<StepObservationInputWire[]> {
  const observed: StepObservationInputWire[] = [];
  const pending = runAnalyzerVerifier({
    scenario,
    seed: 1,
    guard: collectingGuard(observed),
    maxCalls: scenario === 'loop' ? 12 : 30,
  });
  if (scenario === 'cost-velocity') await vi.advanceTimersByTimeAsync(3_000);
  await pending;
  return observed;
}

afterEach(() => vi.useRealTimers());

describe('broken scenarios invoke the real default detectors end to end', () => {
  it.each([
    ['loop', 'loop-signature'],
    ['context-bloat', 'context-bloat'],
    ['cost-velocity', 'cost-velocity'],
  ] as const)(
    '%s fires only its matching default detector',
    async (scenario, expected) => {
      vi.useFakeTimers({ now: new Date('2026-08-24T00:00:00.000Z') });
      const observed = await runScenario(scenario);
      const results = evaluate(observed);
      expect(
        results.filter((result) => result.fired).map((result) => result.detector),
      ).toEqual([expected]);
      if (scenario === 'cost-velocity') {
        expect(
          observed.at(-1)!.timestampMs - observed[0]!.timestampMs,
        ).toBeGreaterThanOrEqual(DEFAULT_COST_VELOCITY_CONFIG.minElapsedMsForSignal);
        expect(observed.every((step) => step.estimatedCostUsd === 0.175)).toBe(true);
      }
    },
  );

  it('normal progress stays quiet under every default detector', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-24T00:00:00.000Z') });
    expect(evaluate(await runScenario('normal')).every((result) => !result.fired)).toBe(
      true,
    );
  });
});
