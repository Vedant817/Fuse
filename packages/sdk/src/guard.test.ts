import { describe, expect, it, vi } from 'vitest';
import type {
  Scope,
  SpanTelemetrySampleWire,
  StepObservationWire,
} from '@fuse/contracts';
import { BreakerTrippedError } from './errors.js';
import { FuseGuard, type PermitDecisionTelemetry } from './guard.js';

const SCOPE: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-1' };

function healthySample(): SpanTelemetrySampleWire {
  return {
    timestampMs: Date.now(),
    hasRequestModel: true,
    hasInputTokens: true,
    hasOutputTokens: true,
    hasScopedIdentity: true,
    hasValidTimestamps: true,
    isRootSpan: true,
    hasParent: false,
  };
}

function healthyStep(): StepObservationWire {
  return {
    timestampMs: Date.now(),
    canonicalShape: 'analyzer:abc123',
    inputTokens: 200,
    outputTokens: 50,
    estimatedCostUsd: 0.001,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('FuseGuard', () => {
  it('invokes dispatch when the control plane allows the call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        allowed: true,
        state: 'armed',
        reason: 'armed',
        epoch: 0,
        degraded: false,
        correlationId: 'corr-1',
      }),
    );
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp.internal',
      apiToken: 'tok',
      fetchImpl,
    });
    const dispatch = vi.fn().mockResolvedValue('provider-result');
    const result = await guard.guard(dispatch, 'corr-1');
    expect(result).toBe('provider-result');
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('never invokes dispatch when the control plane denies the call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        allowed: false,
        state: 'tripped',
        reason: 'loop detected',
        epoch: 3,
        degraded: false,
        correlationId: 'corr-1',
      }),
    );
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp.internal',
      apiToken: 'tok',
      fetchImpl,
    });
    const dispatch = vi.fn().mockResolvedValue('should-not-happen');
    await expect(guard.guard(dispatch, 'corr-1')).rejects.toThrow(BreakerTrippedError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('carries scope/reason/correlationId on BreakerTrippedError without extra internals', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        allowed: false,
        state: 'tripped',
        reason: 'context bloat: 120k tokens',
        epoch: 7,
        degraded: false,
        correlationId: 'corr-xyz',
      }),
    );
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });
    try {
      await guard.guard(() => Promise.resolve(1), 'corr-xyz');
      throw new Error('expected guard() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BreakerTrippedError);
      const tripped = err as BreakerTrippedError;
      expect(tripped.scope).toEqual(SCOPE);
      expect(tripped.reason).toBe('context bloat: 120k tokens');
      expect(tripped.correlationId).toBe('corr-xyz');
      expect(tripped.state).toBe('tripped');
    }
  });

  it('fails closed by default when the control plane is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });
    const dispatch = vi.fn().mockResolvedValue('x');
    await expect(guard.guard(dispatch, 'corr-1')).rejects.toThrow(BreakerTrippedError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails open when explicitly configured to, on control-plane outage', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      outageMode: 'fail-open',
    });
    const dispatch = vi.fn().mockResolvedValue('provider-result');
    const result = await guard.guard(dispatch, 'corr-1');
    expect(result).toBe('provider-result');
  });

  it('treats a non-2xx control-plane response as an outage, not as "allowed"', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'internal_error' }, 500));
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });
    const dispatch = vi.fn().mockResolvedValue('x');
    await expect(guard.guard(dispatch, 'corr-1')).rejects.toThrow(BreakerTrippedError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('treats a malformed (schema-invalid) response as an outage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ nonsense: true }));
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });
    const dispatch = vi.fn().mockResolvedValue('x');
    await expect(guard.guard(dispatch, 'corr-1')).rejects.toThrow(BreakerTrippedError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('times out a hanging control-plane call and fails closed', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
    });
    const dispatch = vi.fn().mockResolvedValue('x');
    await expect(guard.guard(dispatch, 'corr-1')).rejects.toThrow(BreakerTrippedError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('reports decision telemetry for both allowed and denied calls', async () => {
    const events: PermitDecisionTelemetry[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          allowed: true,
          state: 'armed',
          reason: 'armed',
          epoch: 0,
          degraded: false,
          correlationId: 'c1',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          allowed: false,
          state: 'tripped',
          reason: 'loop',
          epoch: 1,
          degraded: false,
          correlationId: 'c2',
        }),
      );
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      onDecision: (e) => events.push(e),
    });
    await guard.guard(() => Promise.resolve('x'), 'c1');
    await guard.guard(() => Promise.resolve('x'), 'c2').catch(() => {});
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ allowed: true, correlationId: 'c1' });
    expect(events[1]).toMatchObject({ allowed: false, correlationId: 'c2' });
    expect(events[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('sends the bearer token and scope on every permit request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        allowed: true,
        state: 'armed',
        reason: 'armed',
        epoch: 0,
        degraded: false,
        correlationId: 'c1',
      }),
    );
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp.internal/',
      apiToken: 'secret-token',
      fetchImpl,
    });
    await guard.guard(() => Promise.resolve('x'), 'c1');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://cp.internal/v1/permit',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer secret-token' }),
      }),
    );
  });

  it('never reports Preflight telemetry (and never touches fetch for it) unless recordSpanTelemetry is called', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        allowed: true,
        state: 'armed',
        reason: 'armed',
        epoch: 0,
        degraded: false,
        correlationId: 'c1',
      }),
    );
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });
    await guard.guard(() => Promise.resolve('x'), 'c1');
    // Only the one permit-check call — no background Preflight timer was
    // ever started, since recordSpanTelemetry was never invoked.
    expect(fetchImpl).toHaveBeenCalledOnce();
    guard.stopPreflightReporting();
  });

  it('recordSpanTelemetry forwards samples to POST /v1/preflight/report on flush', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/v1/preflight/report'))
        return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch to ${url}`);
    });
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp.internal',
      apiToken: 'tok',
      fetchImpl,
    });
    guard.recordSpanTelemetry(healthySample());
    await guard.flushPreflightTelemetry();
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://cp.internal/v1/preflight/report',
      expect.objectContaining({ method: 'POST' }),
    );
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.scope).toEqual(SCOPE);
    expect(body.spans).toHaveLength(1);
    guard.stopPreflightReporting();
  });

  it('does not report Preflight telemetry when reportPreflightTelemetry is false', async () => {
    const fetchImpl = vi.fn();
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      reportPreflightTelemetry: false,
    });
    guard.recordSpanTelemetry(healthySample());
    await guard.flushPreflightTelemetry();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never reports step observations (and never touches fetch for it) unless recordStepObservation is called', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        allowed: true,
        state: 'armed',
        reason: 'armed',
        epoch: 0,
        degraded: false,
        correlationId: 'c1',
      }),
    );
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });
    await guard.guard(() => Promise.resolve('x'), 'c1');
    expect(fetchImpl).toHaveBeenCalledOnce();
    guard.stopStepObservationReporting();
  });

  it('recordStepObservation forwards steps to POST /v1/detectors/observe on flush', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/v1/detectors/observe'))
        return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch to ${url}`);
    });
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp.internal',
      apiToken: 'tok',
      fetchImpl,
    });
    guard.recordStepObservation(healthyStep());
    await guard.flushStepObservations();
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://cp.internal/v1/detectors/observe',
      expect.objectContaining({ method: 'POST' }),
    );
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.scope).toEqual(SCOPE);
    expect(body.steps).toHaveLength(1);
    guard.stopStepObservationReporting();
  });

  it('does not report step observations when reportStepObservations is false', async () => {
    const fetchImpl = vi.fn();
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      reportStepObservations: false,
    });
    guard.recordStepObservation(healthyStep());
    await guard.flushStepObservations();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
