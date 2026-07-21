import type { Scope, SpanTelemetrySampleWire } from '@fuse/contracts';

export interface PreflightReporterOptions {
  scope: Scope;
  controlPlaneUrl: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  /** How often the background timer flushes a non-empty buffer. */
  flushIntervalMs?: number;
  /** Flush immediately (not just on the timer) once the buffer reaches
   * this size, so a bursty agent doesn't wait a full interval to report. */
  maxBatchSize?: number;
  /** Hard cap on buffered-but-unflushed samples. Oldest samples are
   * dropped first on overflow — under a sustained control-plane outage,
   * the freshest evidence matters more than complete history. */
  maxBufferSize?: number;
  onFlushError?: ((err: unknown) => void) | undefined;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BATCH_SIZE = 200;
const DEFAULT_MAX_BUFFER_SIZE = 2_000;

/**
 * Batches `SpanTelemetryObservation`s and periodically reports them to
 * `POST /v1/preflight/report`, entirely off the request critical path.
 * Preflight is an honesty signal about telemetry health, not an
 * enforcement mechanism — a reporting failure here must never affect
 * whether a guarded call proceeds, so every flush failure is swallowed
 * (after `onFlushError`) rather than thrown, and a failed batch is never
 * retried (retrying risks unbounded memory growth under a sustained
 * outage, and if the control plane is unreachable for reporting, it is
 * equally unreachable for reading status back, so nothing observes the
 * gap either way).
 */
export class PreflightReporter {
  private buffer: SpanTelemetrySampleWire[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly options: Required<Omit<PreflightReporterOptions, 'onFlushError'>> & {
    onFlushError: PreflightReporterOptions['onFlushError'];
  };

  constructor(options: PreflightReporterOptions) {
    this.options = {
      scope: options.scope,
      controlPlaneUrl: options.controlPlaneUrl.replace(/\/+$/, ''),
      apiToken: options.apiToken,
      fetchImpl: options.fetchImpl ?? fetch,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      maxBatchSize: options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      maxBufferSize: options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE,
      onFlushError: options.onFlushError,
    };
  }

  record(sample: SpanTelemetrySampleWire): void {
    this.buffer.push(sample);
    if (this.buffer.length > this.options.maxBufferSize) {
      this.buffer.splice(0, this.buffer.length - this.options.maxBufferSize);
    }
    if (this.buffer.length >= this.options.maxBatchSize) {
      void this.flush();
    }
  }

  /** Starts the background flush timer. Idempotent — calling it again
   * while already running is a no-op. The timer is unref'd so holding a
   * reporter never keeps a Node process alive by itself. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.options.flushIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      const res = await this.options.fetchImpl(
        `${this.options.controlPlaneUrl}/v1/preflight/report`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.apiToken}`,
          },
          body: JSON.stringify({ scope: this.options.scope, spans: batch }),
        },
      );
      if (!res.ok) {
        this.options.onFlushError?.(
          new Error(`preflight report rejected with HTTP ${res.status}`),
        );
      }
    } catch (err) {
      this.options.onFlushError?.(err);
    }
  }
}
