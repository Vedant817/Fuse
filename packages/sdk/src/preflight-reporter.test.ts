import { describe, expect, it, vi } from 'vitest';
import type { Scope, SpanTelemetrySampleWire } from '@fuse/contracts';
import { PreflightReporter } from './preflight-reporter.js';

const SCOPE: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-1' };

function sample(
  overrides: Partial<SpanTelemetrySampleWire> = {},
): SpanTelemetrySampleWire {
  return {
    timestampMs: Date.now(),
    hasRequestModel: true,
    hasInputTokens: true,
    hasOutputTokens: true,
    hasScopedIdentity: true,
    hasValidTimestamps: true,
    isRootSpan: true,
    hasParent: false,
    ...overrides,
  };
}

function okResponse(): Response {
  return new Response(null, { status: 200 });
}

describe('PreflightReporter', () => {
  it('does not call fetch when the buffer is empty', async () => {
    const fetchImpl = vi.fn();
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });
    await reporter.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('flush() sends every buffered sample as one batch to /v1/preflight/report', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => okResponse());
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp.internal/',
      apiToken: 'secret',
      fetchImpl,
    });
    reporter.record(sample());
    reporter.record(sample());
    await reporter.flush();

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://cp.internal/v1/preflight/report');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer secret');
    const body = JSON.parse(init.body as string);
    expect(body.scope).toEqual(SCOPE);
    expect(body.spans).toHaveLength(2);
  });

  it('clears the buffer after a successful flush (no duplicate reporting)', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => okResponse());
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
    });
    reporter.record(sample());
    await reporter.flush();
    await reporter.flush();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('auto-flushes once the buffer reaches maxBatchSize, without waiting for the timer', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => okResponse());
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      maxBatchSize: 3,
    });
    reporter.record(sample());
    reporter.record(sample());
    expect(fetchImpl).not.toHaveBeenCalled();
    reporter.record(sample());
    // record() fires flush() without awaiting it (fire-and-forget) —
    // give the microtask queue a turn to run it.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('drops the oldest samples once maxBufferSize is exceeded', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => okResponse());
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      maxBatchSize: 1_000, // never auto-flush from this
      maxBufferSize: 2,
    });
    reporter.record(sample({ timestampMs: 1 }));
    reporter.record(sample({ timestampMs: 2 }));
    reporter.record(sample({ timestampMs: 3 }));
    await reporter.flush();
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.spans.map((s: SpanTelemetrySampleWire) => s.timestampMs)).toEqual([2, 3]);
  });

  it('swallows a network error and reports it via onFlushError, never throwing', async () => {
    const onFlushError = vi.fn();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      onFlushError,
    });
    reporter.record(sample());
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(onFlushError).toHaveBeenCalledOnce();
  });

  it('treats a non-2xx response as a reportable flush error', async () => {
    const onFlushError = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => new Response(null, { status: 503 }));
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      onFlushError,
    });
    reporter.record(sample());
    await reporter.flush();
    expect(onFlushError).toHaveBeenCalledOnce();
  });

  it('does not retry a batch dropped on flush failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl,
      onFlushError: () => {},
    });
    reporter.record(sample());
    await reporter.flush();
    await reporter.flush();
    // Second flush finds an empty buffer (the failed batch was not
    // requeued) so fetch is only ever called for the first attempt.
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('start()/stop() manage a background timer without leaving it dangling', () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockImplementation(() => okResponse());
      const reporter = new PreflightReporter({
        scope: SCOPE,
        controlPlaneUrl: 'http://cp',
        apiToken: 'tok',
        fetchImpl,
        flushIntervalMs: 1_000,
      });
      reporter.record(sample());
      reporter.start();
      vi.advanceTimersByTime(1_000);
      expect(fetchImpl).toHaveBeenCalledOnce();
      reporter.stop();
      reporter.record(sample());
      vi.advanceTimersByTime(10_000);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
