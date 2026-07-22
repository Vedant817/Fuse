import { describe, expect, it, vi } from 'vitest';
import type { Scope, StepObservationWire } from '@fuse/contracts';
import { StepObservationReporter } from './step-observation-reporter.js';

const SCOPE: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-1' };

function step(overrides: Partial<StepObservationWire> = {}): StepObservationWire {
  return {
    timestampMs: Date.now(),
    canonicalShape: 'step',
    inputTokens: 100,
    outputTokens: 20,
    estimatedCostUsd: 0.001,
    ...overrides,
  };
}

function okResponse(): Response {
  return new Response(null, { status: 200 });
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

  it('clears the buffer after a successful flush (no duplicate reporting)', async () => {
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
    expect(body.steps.map((s: StepObservationWire) => s.timestampMs)).toEqual([2, 3]);
  });

  it('swallows a network error and reports it via onFlushError, never throwing', async () => {
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
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(onFlushError).toHaveBeenCalledOnce();
  });

  it('treats a non-2xx response as a reportable flush error', async () => {
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
    await reporter.flush();
    expect(onFlushError).toHaveBeenCalledOnce();
  });

  it('does not retry a batch dropped on flush failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
    const reporter = new StepObservationReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      onFlushError: () => {},
    });
    reporter.record(step());
    await reporter.flush();
    await reporter.flush();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('start()/stop() manage a background timer without leaving it dangling', () => {
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
      vi.advanceTimersByTime(1_000);
      expect(fetchImpl).toHaveBeenCalledOnce();
      reporter.stop();
      reporter.record(step());
      vi.advanceTimersByTime(10_000);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
