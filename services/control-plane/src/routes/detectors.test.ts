import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectorResult, Scope, StepObservationWire } from '@fuse/contracts';
import type { BreakerStore } from '@fuse/breaker-store';
import type { DetectorRunner } from '../detector-runner.js';
import { registerDetectorRoutes } from './detectors.js';

const SCOPE: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-1' };
const STEP: StepObservationWire = {
  executionId: 'execution-1',
  timestampMs: 1_700_000_000_000,
  canonicalShape: 'analyzer:abc',
  inputTokens: 100,
  outputTokens: 20,
  pricingStatus: 'available',
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
  const getRecord = vi.fn();
  const trip = vi.fn();
  let runner: DetectorRunner;
  let store: BreakerStore;

  beforeEach(() => {
    evaluateWindow.mockReset();
    getRecord.mockReset();
    getRecord.mockResolvedValue({
      scope: SCOPE,
      state: 'armed',
      epoch: 0,
      reason: 'initialized',
      policyVersion: 'policy-v1',
      cooldownUntil: null,
      updatedAt: '2026-07-22T00:00:00.000Z',
      updatedBy: { type: 'system', id: 'system:init' },
    });
    trip.mockReset();
    runner = { evaluateWindow } as unknown as DetectorRunner;
    store = { getRecord, trip } as unknown as BreakerStore;
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
      0,
      expect.any(Date),
      {},
    );
    expect(res.json().results).toEqual(finalResults);
    expect(res.json().enforcement).toEqual([]);
    expect(trip).not.toHaveBeenCalled();
    expect(getRecord).toHaveBeenCalledOnce();
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
    expect(trip).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: SCOPE,
        policyVersion: 'policy-v1',
        cooldownSeconds: 300,
        actor: { type: 'system', id: 'system:detector:context-bloat' },
        expectedEpoch: 4,
      }),
      {
        detector: 'context-bloat',
        startsAt: '2026-07-22T00:00:00.000Z',
        notifySlack: true,
        measurement: {
          detectorVersion: 'context-bloat-v1',
          score: 150_000,
          threshold: 1,
          windowEnd: '2026-07-22T00:00:00.000Z',
        },
      },
    );
    expect(res.json().enforcement).toEqual([
      { detector: 'context-bloat', outcome: 'tripped' },
    ]);
    await app.close();
  });

  it('does no route-level diagnosis work when the detector trip is an idempotency replay', async () => {
    const fired = { ...fakeResult('context-bloat'), fired: true, score: 150_000 };
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
    expect(trip).toHaveBeenCalledOnce();
    await app.close();
  });

  it('atomically requests a Slack-enabled job for a direct detector trip', async () => {
    const fired = { ...fakeResult('loop-signature'), fired: true, score: 4 };
    evaluateWindow.mockReturnValue([fired]);
    getRecord.mockResolvedValue({
      scope: SCOPE,
      state: 'armed',
      epoch: 6,
      reason: 'operator resumed',
      policyVersion: 'policy-v1',
      cooldownUntil: null,
      updatedAt: '2026-07-22T00:00:00.000Z',
      updatedBy: { type: 'manual', id: 'operator:test' },
    });
    trip.mockResolvedValue({
      kind: 'applied',
      noop: false,
      replayed: false,
      record: { epoch: 7 },
    });

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
    expect(trip).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: SCOPE,
        expectedEpoch: 6,
      }),
      {
        detector: 'loop-signature',
        startsAt: fired.windowStart,
        notifySlack: true,
        measurement: {
          detectorVersion: fired.detectorVersion,
          score: fired.score,
          threshold: fired.threshold,
          windowEnd: fired.windowEnd,
        },
      },
    );
    await app.close();
  });

  it('fails closed when the breaker epoch changes before the direct trip commits', async () => {
    evaluateWindow.mockReturnValue([
      { ...fakeResult('loop-signature'), fired: true, score: 4 },
    ]);
    getRecord.mockResolvedValue({
      scope: SCOPE,
      state: 'armed',
      epoch: 6,
      reason: 'operator resumed',
      policyVersion: 'policy-v1',
      cooldownUntil: null,
      updatedAt: '2026-07-22T00:00:00.000Z',
      updatedBy: { type: 'manual', id: 'operator:test' },
    });
    trip.mockResolvedValue({
      kind: 'rejected',
      code: 'stale_epoch',
      message: 'expected epoch 6, current epoch is 7',
    });

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

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('contention_exhausted');
    expect(res.headers['retry-after']).toBe('1');
    expect(trip).toHaveBeenCalledWith(
      expect.objectContaining({ expectedEpoch: 6 }),
      expect.any(Object),
    );
    await app.close();
  });

  it('binds two fired detectors to one baseline and commits at most one direct trip', async () => {
    evaluateWindow.mockReturnValue([
      { ...fakeResult('loop-signature'), fired: true, score: 4 },
      { ...fakeResult('context-bloat'), fired: true, score: 150_000 },
    ]);
    getRecord.mockResolvedValue({
      scope: SCOPE,
      state: 'armed',
      epoch: 12,
      reason: 'operator resumed',
      policyVersion: 'policy-v1',
      cooldownUntil: null,
      updatedAt: '2026-07-22T00:00:00.000Z',
      updatedBy: { type: 'manual', id: 'operator:test' },
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
    expect(getRecord).toHaveBeenCalledOnce();
    expect(evaluateWindow).toHaveBeenCalledWith(SCOPE, [STEP], 12, expect.any(Date), {});
    expect(trip).toHaveBeenCalledOnce();
    expect(trip).toHaveBeenCalledWith(
      expect.objectContaining({ expectedEpoch: 12 }),
      expect.any(Object),
    );
    expect(res.json().enforcement).toEqual([
      { detector: 'loop-signature', outcome: 'tripped' },
      { detector: 'context-bloat', outcome: 'already-tripped' },
    ]);
    await app.close();
  });

  it('honors a policy that has no Slack notification route', async () => {
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
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/detectors/observe',
      payload: { scope: SCOPE, steps: [STEP] },
    });

    expect(res.statusCode).toBe(200);
    expect(trip).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ notifySlack: false }),
    );
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
