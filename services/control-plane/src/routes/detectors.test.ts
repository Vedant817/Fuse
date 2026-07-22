import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectorResult, Scope, StepObservationWire } from '@fuse/contracts';
import type { DetectorRunner } from '../detector-runner.js';
import { registerDetectorRoutes } from './detectors.js';

const SCOPE: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-1' };
const STEP: StepObservationWire = {
  timestampMs: 1_700_000_000_000,
  canonicalShape: 'analyzer:abc',
  inputTokens: 100,
  outputTokens: 20,
  estimatedCostUsd: 0.001,
};

function fakeResult(detector: DetectorResult['detector']): DetectorResult {
  return {
    detector,
    detectorVersion: `${detector}-v1`,
    scope: SCOPE,
    fired: false,
    score: 0,
    threshold: 1,
    windowStart: '2026-07-22T00:00:00.000Z',
    windowEnd: '2026-07-22T00:00:00.000Z',
    evidence: [],
    dedupeKey: `${detector}:t1/test/agent-1`,
  };
}

describe('registerDetectorRoutes', () => {
  const recordStep = vi.fn();
  let runner: DetectorRunner;

  beforeEach(() => {
    recordStep.mockReset();
    runner = { recordStep } as unknown as DetectorRunner;
  });

  it('feeds every step in order and returns the final evaluation', async () => {
    const finalResults = [
      fakeResult('loop-signature'),
      fakeResult('context-bloat'),
      fakeResult('cost-velocity'),
    ];
    recordStep
      .mockReturnValueOnce([fakeResult('loop-signature')])
      .mockReturnValueOnce(finalResults);

    const app = Fastify();
    registerDetectorRoutes(app, runner);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/detectors/observe',
      payload: { scope: SCOPE, steps: [STEP, STEP] },
    });

    expect(res.statusCode).toBe(200);
    expect(recordStep).toHaveBeenCalledTimes(2);
    expect(recordStep).toHaveBeenNthCalledWith(1, SCOPE, STEP);
    expect(recordStep).toHaveBeenNthCalledWith(2, SCOPE, STEP);
    expect(res.json().results).toEqual(finalResults);
    await app.close();
  });

  it('rejects a malformed request without ever touching the runner', async () => {
    const app = Fastify();
    registerDetectorRoutes(app, runner);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/detectors/observe',
      payload: { scope: SCOPE, steps: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(recordStep).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a request with no scope', async () => {
    const app = Fastify();
    registerDetectorRoutes(app, runner);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/detectors/observe',
      payload: { steps: [STEP] },
    });

    expect(res.statusCode).toBe(400);
    expect(recordStep).not.toHaveBeenCalled();
    await app.close();
  });
});
