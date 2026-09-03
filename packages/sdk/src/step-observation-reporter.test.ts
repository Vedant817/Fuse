import { describe, expect, it, vi } from 'vitest';
import type { Scope, StepObservationInputWire } from '@fuse/contracts';
import { StepObservationReporter } from './step-observation-reporter.js';

const SCOPE: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-1' };

function step(
  overrides: Partial<StepObservationInputWire> = {},
): StepObservationInputWire {
  return {
    executionId: 'execution-1',
    timestampMs: Date.now(),
    canonicalShape: 'step',
    inputTokens: 100,
    outputTokens: 20,
    pricingStatus: 'available',
    estimatedCostUsd: 0.001,
    ...overrides,
  } as StepObservationInputWire;
}

function okResponse(): Response {
  return new Response(JSON.stringify({ results: [], enforcement: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function trippedResponse(): Response {
  return new Response(
    JSON.stringify({
      results: [],
      enforcement: [{ detector: 'context-bloat', outcome: 'tripped' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('StepObservationReporter', () => {
  it('does not call fetch when the buffer is empty', async () => {
    const fetchImpl = vi.fn();
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });
    await reporter.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('flush() sends every buffered step as one batch to /v1/detectors/observe', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => okResponse());
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp.internal/',
      apiToken: 'secret',
      fetchImpl,
    });
    reporter.record(step());
    reporter.record(step());
    await reporter.flush();

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://cp.internal/v1/detectors/observe');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer secret');
    const body = JSON.parse(init.body as string);
    expect(body.scope).toEqual(SCOPE);
    expect(body.steps).toHaveLength(2);
  });

  it('does not resend an unchanged window after a successful flush', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => okResponse());
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });
    reporter.record(step());
    await reporter.flush();
    await reporter.flush();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('recordAndFlush sends synchronously and carries the complete trailing window', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => okResponse());
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });
    await reporter.recordAndFlush(step({ timestampMs: 1 }));
    await reporter.recordAndFlush(step({ timestampMs: 2 }));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchImpl.mock.calls[1]![1].body as string);
    expect(
      secondBody.steps.map((item: StepObservationInputWire) => item.timestampMs),
    ).toEqual([1, 2]);
  });

  it('auto-flushes once the buffer reaches maxBatchSize, without waiting for the timer', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => okResponse());
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      maxBatchSize: 3,
    });
    reporter.record(step());
    reporter.record(step());
    expect(fetchImpl).not.toHaveBeenCalled();
    reporter.record(step());
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('drops the oldest steps once maxBufferSize is exceeded', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => okResponse());
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      maxBatchSize: 1_000,
      maxBufferSize: 2,
    });
    reporter.record(step({ timestampMs: 1 }));
    reporter.record(step({ timestampMs: 2 }));
    reporter.record(step({ timestampMs: 3 }));
    await reporter.flush();
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.steps.map((s: StepObservationInputWire) => s.timestampMs)).toEqual([
      2, 3,
    ]);
  });

  it('never sends more than the API contract maximum of 200 observations', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => okResponse());
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      maxBatchSize: 1_000,
    });
    for (let timestampMs = 1; timestampMs <= 201; timestampMs++) {
      reporter.record(step({ timestampMs }));
    }
    await reporter.flush();

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.steps).toHaveLength(200);
    expect(body.steps[0].timestampMs).toBe(2);
    expect(body.steps[199].timestampMs).toBe(201);
  });

  it('rejects a configured buffer that would violate the API contract', () => {
    expect(
      () =>
        new StepObservationReporter({
          scope: SCOPE,
          controlPlaneUrl: 'http://cp',
          apiToken: 'tok',
          maxBufferSize: 201,
        }),
    ).toThrow('maxBufferSize must be an integer from 1 to 200');
  });

  it('fails closed on a network error and reports it via onFlushError', async () => {
    const onFlushError = vi.fn();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      onFlushError,
    });
    reporter.record(step());
    await expect(reporter.flush()).rejects.toThrow('ECONNREFUSED');
    expect(onFlushError).toHaveBeenCalledOnce();
  });

  it('supports an explicit fail-open observation path', async () => {
    const onFlushError = vi.fn();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      outageMode: 'fail-open',
      onFlushError,
    });
    reporter.record(step());
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(onFlushError).toHaveBeenCalledOnce();
  });

  it('treats a non-2xx response as a fail-closed report error', async () => {
    const onFlushError = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => new Response(null, { status: 503 }));
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      onFlushError,
    });
    reporter.record(step());
    await expect(reporter.flush()).rejects.toThrow(
      'step observation report rejected with HTTP 503',
    );
    expect(onFlushError).toHaveBeenCalledOnce();
  });

  it('retains the complete window and retries after a transient flush failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockImplementationOnce(() => okResponse());
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      onFlushError: () => {},
    });
    reporter.record(step());
    await expect(reporter.flush()).rejects.toThrow('down');
    await reporter.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('enforces a hard timeout even when fetch ignores the abort signal', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => new Promise(() => {}));
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://blackhole',
      apiToken: 'tok',
      fetchImpl,
      timeoutMs: 20,
    });
    reporter.record(step());

    await expect(reporter.flush()).rejects.toThrow(
      'step observation report timed out after 20ms',
    );
  });

  it('rejects a malformed successful detector response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ accepted: true }), { status: 200 }),
      );
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });
    reporter.record(step());

    await expect(reporter.flush()).rejects.toThrow(
      'control plane returned a malformed detector response',
    );
  });

  it('clears acknowledged history after a detector-triggered trip', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => trippedResponse())
      .mockImplementationOnce(() => okResponse());
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });
    await reporter.recordAndFlush(step({ timestampMs: 1, inputTokens: 100_000 }));
    await reporter.recordAndFlush(step({ timestampMs: 2, inputTokens: 100 }));

    const secondBody = JSON.parse(fetchImpl.mock.calls[1]![1].body as string);
    expect(secondBody.steps).toEqual([
      expect.objectContaining({ timestampMs: 2, inputTokens: 100 }),
    ]);
  });

  it('clearHistory removes pre-denial observations from the next window', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => okResponse());
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });
    await reporter.recordAndFlush(step({ timestampMs: 1 }));
    reporter.clearHistory();
    await reporter.recordAndFlush(step({ timestampMs: 2 }));

    const secondBody = JSON.parse(fetchImpl.mock.calls[1]![1].body as string);
    expect(
      secondBody.steps.map((item: StepObservationInputWire) => item.timestampMs),
    ).toEqual([2]);
  });

  it('keeps concurrent execution histories separate even when completions interleave', async () => {
    const bodies: Array<{ steps: StepObservationInputWire[] }> = [];
    const fetchImpl = vi.fn().mockImplementation((_url, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return okResponse();
    });
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });

    await Promise.all([
      reporter.recordAndFlush(step({ executionId: 'execution-a', timestampMs: 1 })),
      reporter.recordAndFlush(step({ executionId: 'execution-b', timestampMs: 2 })),
    ]);
    await reporter.recordAndFlush(step({ executionId: 'execution-a', timestampMs: 3 }));

    expect(bodies).toHaveLength(3);
    expect(
      bodies.every(
        ({ steps }) => new Set(steps.map((item) => item.executionId)).size === 1,
      ),
    ).toBe(true);
    expect(
      bodies
        .find(({ steps }) => steps.at(-1)?.timestampMs === 3)!
        .steps.map((item) => item.timestampMs),
    ).toEqual([1, 3]);
  });

  it('degrades only cost velocity when execution pricing is unavailable', async () => {
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl: vi.fn().mockImplementation(() => okResponse()),
    });
    await reporter.recordAndFlush(
      step({
        pricingStatus: 'unavailable',
        estimatedCostUsd: null,
      }),
    );

    expect(reporter.getDetectorProtection('execution-1')).toEqual([
      expect.objectContaining({ detector: 'loop-signature', status: 'protected' }),
      expect.objectContaining({ detector: 'context-bloat', status: 'protected' }),
      expect.objectContaining({
        detector: 'cost-velocity',
        status: 'degraded',
        reasonCode: 'pricing-unavailable',
      }),
    ]);
  });

  it('supports explicit reset/end and bounded oldest-history eviction', () => {
    vi.useFakeTimers({ now: 1 });
    try {
      const reporter = new StepObservationReporter({
        scope: SCOPE,
        controlPlaneUrl: 'http://cp',
        apiToken: 'tok',
        maxExecutions: 2,
      });
      reporter.record(step({ executionId: 'oldest' }));
      vi.setSystemTime(2);
      reporter.record(step({ executionId: 'kept' }));
      vi.setSystemTime(3);
      reporter.record(step({ executionId: 'newest' }));

      expect(reporter.getDetectorProtection('oldest')[0]).toMatchObject({
        status: 'degraded',
        reasonCode: 'no-observations',
      });
      reporter.clearHistory('kept');
      expect(reporter.getDetectorProtection('kept')[0]).toMatchObject({
        status: 'degraded',
        reasonCode: 'no-observations',
      });
      reporter.endExecution('newest');
      expect(reporter.getDetectorProtection('newest')[0]).toMatchObject({
        status: 'degraded',
        reasonCode: 'no-observations',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('start()/stop() manage a background timer without leaving it dangling', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockImplementation(() => okResponse());
      const reporter = new StepObservationReporter({
        scope: SCOPE,
        controlPlaneUrl: 'http://cp',
        apiToken: 'tok',
        fetchImpl,
        flushIntervalMs: 1_000,
      });
      reporter.record(step());
      reporter.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchImpl).toHaveBeenCalledOnce();
      reporter.stop();
      reporter.record(step());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
