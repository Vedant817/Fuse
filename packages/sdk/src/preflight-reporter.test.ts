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

function delivery(
  sequence: number,
  overrides: Partial<{
    status: 'success' | 'failure';
    observedAtMs: number;
    sourceInstanceId: string;
  }> = {},
) {
  return {
    status: 'success' as const,
    observedAtMs: 1_000 + sequence,
    sourceInstanceId: 'process-1',
    sequence,
    ...overrides,
  };
}

describe('PreflightReporter', () => {
  it('does not call fetch when the buffer is empty', async () => {
    const fetchImpl = vi.fn();
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      exporterEvidenceToken: 'exporter-token',
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
      exporterEvidenceToken: 'exporter-token',
      fetchImpl,
    });
    reporter.record(sample());
    await reporter.flush();
    await reporter.flush();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('reports a real exporter result with its bounded structural span evidence', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => okResponse());
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      exporterEvidenceToken: 'exporter-token',
      fetchImpl,
    });
    reporter.recordTraceExportResult({
      scope: SCOPE,
      exporterDelivery: delivery(1, { observedAtMs: 1234 }),
      spans: [sample({ timestampMs: 1200 })],
    });
    await reporter.flush();
    await Promise.resolve();

    expect(fetchImpl.mock.calls[0]![0]).toBe('http://cp/v1/preflight/exporter-evidence');
    expect(fetchImpl.mock.calls[0]![1].headers.authorization).toBe(
      'Bearer exporter-token',
    );
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.exporterDelivery).toEqual(delivery(1, { observedAtMs: 1234 }));
    expect(body.spans).toHaveLength(1);
  });

  it('never falls back to the agent token when exporter evidence credential is absent', async () => {
    const onFlushError = vi.fn();
    const fetchImpl = vi.fn().mockImplementation(() => okResponse());
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'agent-token',
      fetchImpl,
      onFlushError,
    });

    await reporter.recordTraceExportResult({
      scope: SCOPE,
      exporterDelivery: delivery(1),
      spans: [sample()],
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://cp/v1/preflight/report');
    expect(fetchImpl.mock.calls[0]![1].headers.authorization).toBe('Bearer agent-token');
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.exporterDelivery).toBeUndefined();
    expect(body.spans).toHaveLength(1);
    expect(onFlushError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('not configured') }),
    );
  });

  it('auto-flushes once the buffer reaches maxBatchSize, without waiting for the timer', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => okResponse());
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      exporterEvidenceToken: 'exporter-token',
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
      exporterEvidenceToken: 'exporter-token',
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
      exporterEvidenceToken: 'exporter-token',
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
      exporterEvidenceToken: 'exporter-token',
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
      exporterEvidenceToken: 'exporter-token',
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

  it('start()/stop() manage a background timer without leaving it dangling', async () => {
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
      await Promise.resolve();
      expect(fetchImpl).toHaveBeenCalledOnce();
      reporter.stop();
      reporter.record(sample());
      vi.advanceTimersByTime(10_000);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not depend on client polling to age acknowledged exporter evidence', async () => {
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
      reporter.recordTraceExportResult({
        scope: SCOPE,
        exporterDelivery: delivery(1, { observedAtMs: 100 }),
        spans: [sample({ timestampMs: 90 })],
      });
      await reporter.flush();
      reporter.start();

      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchImpl).toHaveBeenCalledOnce();
      reporter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes concurrent exporter reports and drain without reordered HTTP calls', async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const fetchImpl = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          releases.push(() => {
            active -= 1;
            resolve(okResponse());
          });
        }),
    );
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      exporterEvidenceToken: 'exporter-token',
      fetchImpl,
    });
    void reporter.recordTraceExportResult({
      scope: SCOPE,
      exporterDelivery: delivery(1),
      spans: [sample({ timestampMs: 1 })],
    });
    void reporter.recordTraceExportResult({
      scope: SCOPE,
      exporterDelivery: delivery(2),
      spans: [sample({ timestampMs: 2 })],
    });
    const drained = reporter.drain();

    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    releases.shift()!();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    releases.shift()!();
    await drained;

    expect(maxActive).toBe(1);
    expect(
      fetchImpl.mock.calls.map(
        (call) => JSON.parse(call[1].body as string).exporterDelivery.sequence,
      ),
    ).toEqual([1, 2]);
  });

  it('ignores an older exporter completion before it can issue a report', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => okResponse());
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      exporterEvidenceToken: 'exporter-token',
      fetchImpl,
    });
    void reporter.recordTraceExportResult({
      scope: SCOPE,
      exporterDelivery: delivery(2),
      spans: [sample({ timestampMs: 2 })],
    });
    void reporter.recordTraceExportResult({
      scope: SCOPE,
      exporterDelivery: delivery(1),
      spans: [sample({ timestampMs: 1 })],
    });
    await reporter.drain();

    expect(fetchImpl).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.exporterDelivery.sequence).toBe(2);
  });

  it('retries the newest failed-export evidence after a 503 and recovers', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => new Response(null, { status: 503 }))
      .mockImplementation(() => okResponse());
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      exporterEvidenceToken: 'exporter-token',
      fetchImpl,
      retryBaseDelayMs: 5,
      retryMaxDelayMs: 5,
      retryJitterRatio: 0,
    });

    await reporter.recordTraceExportResult({
      scope: SCOPE,
      exporterDelivery: delivery(1, { status: 'failure' }),
      spans: [sample({ timestampMs: 1 })],
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    const retried = JSON.parse(fetchImpl.mock.calls[1]![1].body as string);
    expect(retried.exporterDelivery).toEqual(delivery(1, { status: 'failure' }));
    await reporter.drain();
  });

  it('coalesces sustained samples behind an AbortSignal-ignoring fetch', async () => {
    let releaseHung!: (response: Response) => void;
    const hung = new Promise<Response>((resolve) => {
      releaseHung = resolve;
    });
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => hung)
      .mockImplementation(() => okResponse());
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      exporterEvidenceToken: 'exporter-token',
      fetchImpl,
      maxBufferSize: 10,
      maxBatchSize: 10,
      requestTimeoutMs: 10,
      retryBaseDelayMs: 5,
      retryMaxDelayMs: 5,
      retryJitterRatio: 0,
    });

    const first = reporter.recordTraceExportResult({
      scope: SCOPE,
      exporterDelivery: delivery(1),
      spans: [sample({ timestampMs: 1 })],
    });
    for (let sequence = 2; sequence <= 1_000; sequence++) {
      void reporter.recordTraceExportResult({
        scope: SCOPE,
        exporterDelivery: delivery(sequence),
        spans: Array.from({ length: 20 }, (_, index) =>
          sample({ timestampMs: sequence * 100 + index }),
        ),
      });
    }
    await first;
    expect(fetchImpl).toHaveBeenCalledOnce();

    releaseHung(okResponse());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const newest = JSON.parse(fetchImpl.mock.calls[1]![1].body as string);
    expect(newest.exporterDelivery.sequence).toBe(1_000);
    expect(newest.spans).toHaveLength(10);
    await reporter.drain();
  });

  it('caps the serialized request body and retains the newest fitting samples', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => okResponse());
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      exporterEvidenceToken: 'exporter-token',
      fetchImpl,
      maxBufferSize: 100,
      maxBatchSize: 100,
      maxRequestBytes: 600,
    });
    await reporter.recordTraceExportResult({
      scope: SCOPE,
      exporterDelivery: delivery(1),
      spans: Array.from({ length: 100 }, (_, index) =>
        sample({ timestampMs: index + 1 }),
      ),
    });

    const body = fetchImpl.mock.calls[0]![1].body as string;
    const parsed = JSON.parse(body);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(600);
    expect(parsed.spans.length).toBeGreaterThan(0);
    expect(parsed.spans.length).toBeLessThan(100);
    expect(parsed.spans.at(-1).timestampMs).toBe(100);
  });

  it('does not allow configuration to bypass the hard queue or wire caps', () => {
    expect(
      () =>
        new PreflightReporter({
          scope: SCOPE,
          controlPlaneUrl: 'http://cp',
          apiToken: 'tok',
          maxBufferSize: 2_001,
        }),
    ).toThrow(/maxBufferSize/);
    expect(
      () =>
        new PreflightReporter({
          scope: SCOPE,
          controlPlaneUrl: 'http://cp',
          apiToken: 'tok',
          maxRequestBytes: 60 * 1024 + 1,
        }),
    ).toThrow(/maxRequestBytes/);
  });

  it('bounds shutdown when fetch permanently ignores AbortSignal', async () => {
    const reporter = new PreflightReporter({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'tok',
      fetchImpl: vi.fn(() => new Promise<Response>(() => {})),
      requestTimeoutMs: 50,
      shutdownTimeoutMs: 10,
    });
    void reporter.recordTraceExportResult({
      scope: SCOPE,
      exporterDelivery: delivery(1),
      spans: [sample()],
    });

    const startedAt = performance.now();
    await reporter.drain();
    expect(performance.now() - startedAt).toBeLessThan(100);
  });
});
