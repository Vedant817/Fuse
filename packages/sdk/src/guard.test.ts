import { describe, expect, it, vi } from 'vitest';
import type {
  Scope,
  SpanTelemetrySampleWire,
  StepObservationInputWire,
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

function healthyStep(): StepObservationInputWire {
  return {
    executionId: 'execution-1',
    timestampMs: Date.now(),
    canonicalShape: 'analyzer:abc123',
    inputTokens: 200,
    outputTokens: 50,
    pricingStatus: 'available',
    estimatedCostUsd: 0.001,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function detectorResponse(
  enforcement: Array<{
    detector: 'loop-signature' | 'context-bloat' | 'cost-velocity';
    outcome: 'tripped' | 'already-tripped' | 'breaker-disabled';
  }> = [],
): Response {
  return jsonResponse({ results: [], enforcement });
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

  it('forwards only matching-scope real OTLP export results to Preflight', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      exporterEvidenceToken: 'exporter-token',
      fetchImpl,
    });

    guard.recordTraceExportResult({
      scope: { ...SCOPE, agentId: 'another-agent' },
      exporterDelivery: {
        status: 'success',
        observedAtMs: 100,
        sourceInstanceId: 'process-1',
        sequence: 1,
      },
      spans: [healthySample()],
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    guard.recordTraceExportResult({
      scope: SCOPE,
      exporterDelivery: {
        status: 'success',
        observedAtMs: 200,
        sourceInstanceId: 'process-1',
        sequence: 2,
      },
      spans: [healthySample()],
    });
    await guard.flushPreflightTelemetry();
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://cp/v1/preflight/exporter-evidence');
    expect(fetchImpl.mock.calls[0]![1].headers.authorization).toBe(
      'Bearer exporter-token',
    );
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.exporterDelivery).toEqual({
      status: 'success',
      observedAtMs: 200,
      sourceInstanceId: 'process-1',
      sequence: 2,
    });
    guard.stopPreflightReporting();
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
      if (url.endsWith('/v1/detectors/observe')) return detectorResponse();
      throw new Error(`unexpected fetch to ${url}`);
    });
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp.internal',
      apiToken: 'tok',
      fetchImpl,
    });
    await guard.recordStepObservation(healthyStep());
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

  it('latches a fail-closed report failure without rejecting the completed call path', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('detector offline'));
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });

    await expect(guard.recordStepObservation(healthyStep())).resolves.toBeUndefined();
  });

  it('denies the next guarded call with a typed actionable error and zero dispatches', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('detector offline'));
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      stepObservationTimeoutMs: 50,
    });
    await guard.recordStepObservation(healthyStep());
    const dispatch = vi.fn().mockResolvedValue('paid-result');

    try {
      await guard.guard(dispatch, 'next-call');
      throw new Error('expected guard() to deny');
    } catch (err) {
      expect(err).toBeInstanceOf(BreakerTrippedError);
      const denial = err as BreakerTrippedError;
      expect(denial.code).toBe('detector_reporting_unavailable');
      expect(denial.degraded).toBe(true);
      expect(denial.action).toContain('Restore detector reporting');
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('uses the next call as a recovery barrier, then permits a later call', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('detector offline'))
      .mockResolvedValueOnce(detectorResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          allowed: true,
          state: 'armed',
          reason: 'armed',
          epoch: 0,
          degraded: false,
          correlationId: 'after-recovery',
        }),
      );
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });
    await guard.recordStepObservation(healthyStep());
    const dispatch = vi.fn().mockResolvedValue('provider-result');

    await expect(guard.guard(dispatch, 'recovery-barrier')).rejects.toMatchObject({
      code: 'detector_reporting_unavailable',
      reason: expect.stringContaining('reporting recovered'),
    });
    expect(dispatch).not.toHaveBeenCalled();

    await expect(guard.guard(dispatch, 'after-recovery')).resolves.toBe(
      'provider-result',
    );
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('clears retained detector history after a permit denial', async () => {
    const reportedBodies: Array<{ steps: StepObservationInputWire[] }> = [];
    let permitCount = 0;
    const fetchImpl = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/detectors/observe')) {
        reportedBodies.push(JSON.parse(init?.body as string));
        return detectorResponse();
      }
      permitCount += 1;
      return jsonResponse({
        allowed: permitCount > 1,
        state: permitCount > 1 ? 'armed' : 'tripped',
        reason: permitCount > 1 ? 'armed' : 'operator trip',
        epoch: permitCount,
        degraded: false,
        correlationId: permitCount > 1 ? 'allowed' : 'denied',
      });
    });
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });
    await guard.recordStepObservation(healthyStep());
    await expect(guard.guard(() => Promise.resolve('no'))).rejects.toThrow(
      BreakerTrippedError,
    );
    await guard.recordStepObservation({ ...healthyStep(), timestampMs: Date.now() + 1 });

    expect(reportedBodies).toHaveLength(2);
    expect(reportedBodies[1]!.steps).toHaveLength(1);
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
    await guard.recordStepObservation(healthyStep());
    await guard.flushStepObservations();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('public runStep performs permit, provider dispatch, canonicalization, and direct reporting', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/v1/permit')) {
        return jsonResponse({
          allowed: true,
          state: 'armed',
          reason: 'armed',
          epoch: 0,
          degraded: false,
          correlationId: 'quickstart-1',
        });
      }
      if (url.endsWith('/v1/detectors/observe')) return detectorResponse();
      throw new Error(`unexpected fetch to ${url}`);
    });
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      reportPreflightTelemetry: false,
    });
    const dispatch = vi.fn().mockResolvedValue({
      text: 'Needs revision after checking the same retry.',
      inputTokens: 200,
      outputTokens: 50,
    });

    const result = await guard.runStep<{
      text: string;
      inputTokens: number;
      outputTokens: number;
    }>({
      executionId: 'session-quickstart',
      providerName: 'groq',
      requestModel: 'llama-3.1-8b-instant',
      kind: 'verifier',
      stepIndex: 0,
      correlationId: 'quickstart-1',
      dispatch,
      observe: (completion) => ({
        text: completion.text,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        structure: ['review', 'revision-request'],
      }),
    });

    expect(result.text).toContain('Needs revision');
    expect(dispatch).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const detectorCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).endsWith('/v1/detectors/observe'),
    )!;
    const body = JSON.parse(detectorCall[1].body as string);
    expect(body.steps).toEqual([
      expect.objectContaining({
        executionId: 'session-quickstart',
        canonicalShape: expect.stringMatching(/^shape-v1:/u),
        pricingStatus: 'available',
      }),
    ]);
    expect(guard.getDetectorProtection('session-quickstart')).toEqual([
      expect.objectContaining({ detector: 'loop-signature', status: 'protected' }),
      expect.objectContaining({ detector: 'context-bloat', status: 'protected' }),
      expect.objectContaining({ detector: 'cost-velocity', status: 'protected' }),
    ]);
  });

  it('keeps loop/context protected but degrades cost velocity for an unknown model', async () => {
    const reportedBodies: Array<{ steps: StepObservationInputWire[] }> = [];
    const fetchImpl = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/permit')) {
        return jsonResponse({
          allowed: true,
          state: 'armed',
          reason: 'armed',
          epoch: 0,
          degraded: false,
          correlationId: 'unknown-price',
        });
      }
      if (url.endsWith('/v1/detectors/observe')) {
        reportedBodies.push(JSON.parse(init?.body as string));
        return detectorResponse();
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      reportPreflightTelemetry: false,
    });

    await expect(
      guard.runStep({
        executionId: 'unknown-price-session',
        providerName: 'custom-provider',
        requestModel: 'unpriced-model',
        kind: 'analyzer',
        stepIndex: 0,
        correlationId: 'unknown-price',
        dispatch: () =>
          Promise.resolve({ text: 'A bounded useful result.', input: 10, output: 5 }),
        observe: (result) => ({
          text: result.text,
          inputTokens: result.input,
          outputTokens: result.output,
        }),
      }),
    ).resolves.toMatchObject({ text: 'A bounded useful result.' });

    expect(reportedBodies[0]!.steps[0]).toMatchObject({
      pricingStatus: 'unavailable',
      estimatedCostUsd: null,
    });
    expect(guard.getDetectorProtection('unknown-price-session')).toEqual([
      expect.objectContaining({ detector: 'loop-signature', status: 'protected' }),
      expect.objectContaining({ detector: 'context-bloat', status: 'protected' }),
      expect.objectContaining({
        detector: 'cost-velocity',
        status: 'degraded',
        reasonCode: 'pricing-unavailable',
      }),
    ]);
  });

  it('runStep returns the paid result on report failure and latches the next call', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/v1/permit')) {
        return jsonResponse({
          allowed: true,
          state: 'armed',
          reason: 'armed',
          epoch: 0,
          degraded: false,
          correlationId: 'paid-call',
        });
      }
      throw new Error('detector endpoint unavailable');
    });
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      reportPreflightTelemetry: false,
      stepObservationTimeoutMs: 50,
    });

    await expect(
      guard.runStep({
        executionId: 'paid-session',
        providerName: 'groq',
        requestModel: 'llama-3.1-8b-instant',
        kind: 'analyzer',
        stepIndex: 0,
        correlationId: 'paid-call',
        dispatch: () => Promise.resolve({ text: 'paid result' }),
        observe: (result) => ({
          text: result.text,
          inputTokens: 10,
          outputTokens: 5,
        }),
      }),
    ).resolves.toEqual({ text: 'paid result' });

    const nextDispatch = vi.fn().mockResolvedValue('must not run');
    await expect(guard.guard(nextDispatch, 'next-call')).rejects.toMatchObject({
      code: 'detector_reporting_unavailable',
    });
    expect(nextDispatch).not.toHaveBeenCalled();
  });
});
