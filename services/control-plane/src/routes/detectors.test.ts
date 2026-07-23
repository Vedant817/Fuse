import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectorResult, Scope, StepObservationWire } from '@fuse/contracts';
import type { BreakerStore } from '@fuse/breaker-store';
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
  const evaluateWindow = vi.fn();
  const assertScopeRegistered = vi.fn();
  const getRecord = vi.fn();
  const trip = vi.fn();
  let runner: DetectorRunner;
  let store: BreakerStore;

  beforeEach(() => {
    evaluateWindow.mockReset();
    assertScopeRegistered.mockReset();
    assertScopeRegistered.mockResolvedValue(undefined);
    getRecord.mockReset();
    trip.mockReset();
    runner = { evaluateWindow } as unknown as DetectorRunner;
    store = { assertScopeRegistered, getRecord, trip } as unknown as BreakerStore;
  });

  it('evaluates the complete caller-supplied window and returns the result', async () => {
    const finalResults = [
      fakeResult('loop-signature'),
      fakeResult('context-bloat'),
      fakeResult('cost-velocity'),
    ];
    evaluateWindow.mockReturnValue(finalResults);

    const app = Fastify();
    registerDetectorRoutes(app, runner, store, {
      policyVersion: 'policy-v1',
      cooldownSeconds: 300,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/detectors/observe',
      payload: { scope: SCOPE, steps: [STEP, STEP] },
    });

    expect(res.statusCode).toBe(200);
    expect(evaluateWindow).toHaveBeenCalledOnce();
    expect(evaluateWindow).toHaveBeenCalledWith(
      SCOPE,
      [STEP, STEP],
      expect.any(Date),
      {},
    );
    expect(res.json().results).toEqual(finalResults);
    expect(res.json().enforcement).toEqual([]);
    expect(trip).not.toHaveBeenCalled();
    await app.close();
  });

  it('durably trips before acknowledging an observation whose detector fired', async () => {
    evaluateWindow.mockReturnValue([
      { ...fakeResult('context-bloat'), fired: true, score: 150_000 },
    ]);
    getRecord.mockResolvedValue({
      scope: SCOPE,
      state: 'armed',
      epoch: 4,
      reason: 'initialized',
      policyVersion: 'policy-v1',
      cooldownUntil: null,
      updatedAt: '2026-07-22T00:00:00.000Z',
      updatedBy: { type: 'system', id: 'system:init' },
    });
    trip.mockResolvedValue({ kind: 'applied', noop: false });

    const app = Fastify();
    registerDetectorRoutes(app, runner, store, {
      policyVersion: 'policy-v1',
      cooldownSeconds: 300,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/detectors/observe',
      payload: { scope: SCOPE, steps: [STEP] },
    });

    expect(res.statusCode).toBe(200);
    expect(trip).toHaveBeenCalledOnce();
    expect(trip.mock.calls[0]![0]).toMatchObject({
      scope: SCOPE,
      policyVersion: 'policy-v1',
      cooldownSeconds: 300,
      actor: { type: 'system', id: 'system:detector:context-bloat' },
    });
    expect(res.json().enforcement).toEqual([
      { detector: 'context-bloat', outcome: 'tripped' },
    ]);
    await app.close();
  });

  it('does not notify again when the detector trip is an idempotency replay', async () => {
    const fired = { ...fakeResult('context-bloat'), fired: true, score: 150_000 };
    const diagnose = vi.fn().mockResolvedValue(undefined);
    evaluateWindow.mockReturnValue([fired]);
    getRecord.mockResolvedValue({
      scope: SCOPE,
      state: 'armed',
      epoch: 4,
      reason: 'initialized',
      policyVersion: 'policy-v1',
      cooldownUntil: null,
      updatedAt: '2026-07-22T00:00:00.000Z',
      updatedBy: { type: 'system', id: 'system:init' },
    });
    trip.mockResolvedValue({ kind: 'applied', noop: false, replayed: true });

    const app = Fastify();
    registerDetectorRoutes(app, runner, store, {
      policyVersion: 'policy-v1',
      cooldownSeconds: 300,
      diagnosisConfig: {} as never,
      diagnose,
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/detectors/observe',
      payload: { scope: SCOPE, steps: [STEP] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().enforcement).toEqual([
      { detector: 'context-bloat', outcome: 'tripped' },
    ]);
    expect(diagnose).not.toHaveBeenCalled();
    await app.close();
  });

  it('honors a policy that has no Slack notification route', async () => {
    const diagnose = vi.fn().mockResolvedValue(undefined);
    evaluateWindow.mockReturnValue([
      { ...fakeResult('context-bloat'), fired: true, score: 150_000 },
    ]);
    getRecord.mockResolvedValue({
      scope: SCOPE,
      state: 'armed',
      epoch: 4,
      reason: 'initialized',
      policyVersion: 'policy-v1',
      cooldownUntil: null,
      updatedAt: '2026-07-22T00:00:00.000Z',
      updatedBy: { type: 'system', id: 'system:init' },
    });
    trip.mockResolvedValue({ kind: 'applied', noop: false });

    const app = Fastify();
    registerDetectorRoutes(app, runner, store, {
      policyVersion: 'policy-v1',
      cooldownSeconds: 300,
      resolvePolicy: () => ({
        policyVersion: 'silent-policy',
        cooldownSeconds: 300,
        storeOutageMode: 'fail-closed',
        controlPlaneOutageMode: 'fail-closed',
        detectors: {},
        notificationRoutes: [],
      }),
      diagnosisConfig: {} as never,
      diagnose,
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/detectors/observe',
      payload: { scope: SCOPE, steps: [STEP] },
    });

    expect(res.statusCode).toBe(200);
    expect(diagnose).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a malformed request without ever touching the runner', async () => {
    const app = Fastify();
    registerDetectorRoutes(app, runner, store, {
      policyVersion: 'policy-v1',
      cooldownSeconds: 300,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/detectors/observe',
      payload: { scope: SCOPE, steps: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(evaluateWindow).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a request with no scope', async () => {
    const app = Fastify();
    registerDetectorRoutes(app, runner, store, {
      policyVersion: 'policy-v1',
      cooldownSeconds: 300,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/detectors/observe',
      payload: { steps: [STEP] },
    });

    expect(res.statusCode).toBe(400);
    expect(evaluateWindow).not.toHaveBeenCalled();
    await app.close();
  });
});
