import type { Scope, StepObservationWire } from '@fuse/contracts';

export interface StepObservationReporterOptions {
  scope: Scope;
  controlPlaneUrl: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  /** How often the background timer flushes a non-empty buffer. */
  flushIntervalMs?: number;
  /** Flush immediately (not just on the timer) once the buffer reaches
   * this size, so a bursty agent doesn't wait a full interval to report. */
  maxBatchSize?: number;
  /** Hard cap on buffered-but-unflushed steps. Oldest steps are dropped
   * first on overflow — same rationale as `PreflightReporter`: under a
   * sustained control-plane outage, the freshest evidence matters more
   * than complete history. */
  maxBufferSize?: number;
  onFlushError?: ((err: unknown) => void) | undefined;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BATCH_SIZE = 200;
const DEFAULT_MAX_BUFFER_SIZE = 2_000;

/**
 * Batches `StepObservation`s and periodically reports them to
 * `POST /v1/detectors/observe`, entirely off the request critical path —
 * the same shape as `PreflightReporter` (task.md §4: detector evaluation is
 * a live signal feeding a SigNoz alert rule, not an enforcement mechanism
 * in its own right, so a reporting failure here must never affect whether
 * a guarded call proceeds). Every flush failure is swallowed (after
 * `onFlushError`) rather than thrown, and a failed batch is never retried.
 */
export class StepObservationReporter {
  private buffer: StepObservationWire[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly options: Required<
    Omit<StepObservationReporterOptions, 'onFlushError'>
  > & {
    onFlushError: StepObservationReporterOptions['onFlushError'];
  };

  constructor(options: StepObservationReporterOptions) {
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

  record(step: StepObservationWire): void {
    this.buffer.push(step);
    if (this.buffer.length > this.options.maxBufferSize) {
      this.buffer.splice(0, this.buffer.length - this.options.maxBufferSize);
    }
    if (this.buffer.length >= this.options.maxBatchSize) {
      void this.flush();
    }
  }

  /** Starts the background flush timer. Idempotent. Unref'd so holding a
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
        `${this.options.controlPlaneUrl}/v1/detectors/observe`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.apiToken}`,
          },
          body: JSON.stringify({ scope: this.options.scope, steps: batch }),
        },
      );
      if (!res.ok) {
        this.options.onFlushError?.(
          new Error(`step observation report rejected with HTTP ${res.status}`),
        );
      }
    } catch (err) {
      this.options.onFlushError?.(err);
    }
  }
}
