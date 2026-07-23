import {
  MAX_STEP_OBSERVATIONS_PER_REQUEST,
  type OutageMode,
  type Scope,
  type StepObservationWire,
} from '@fuse/contracts';

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
  /** Detector telemetry is enforcement-critical. The production default is
   * fail-closed: if Fuse cannot durably evaluate this completed call, the
   * caller receives an error and cannot silently begin its next call. */
  outageMode?: OutageMode;
  onFlushError?: ((err: unknown) => void) | undefined;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BATCH_SIZE = 200;
// Must remain equal to ObserveStepsRequestSchema's max(200). Keeping more
// observations would make the SDK emit a request that the control plane
// rejects, after which every subsequent fail-closed report would also fail.
const MAX_WIRE_STEPS = MAX_STEP_OBSERVATIONS_PER_REQUEST;
const DEFAULT_MAX_BUFFER_SIZE = MAX_WIRE_STEPS;

/**
 * Carries a bounded trailing window to `POST /v1/detectors/observe`. Sending
 * the complete window makes detector evaluation independent of which
 * control-plane replica receives a request. `recordAndFlush` is the
 * enforcement-critical API and defaults fail-closed; the older buffered
 * `record`/timer API remains for explicitly asynchronous integrations.
 */
export class StepObservationReporter {
  private history: StepObservationWire[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private sequence = 0;
  private lastSentSequence = 0;
  private flushChain: Promise<void> = Promise.resolve();
  private readonly options: Required<
    Omit<StepObservationReporterOptions, 'onFlushError'>
  > & {
    onFlushError: StepObservationReporterOptions['onFlushError'];
  };

  constructor(options: StepObservationReporterOptions) {
    const maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    if (
      !Number.isInteger(maxBufferSize) ||
      maxBufferSize <= 0 ||
      maxBufferSize > MAX_WIRE_STEPS
    ) {
      throw new RangeError(
        `maxBufferSize must be an integer from 1 to ${MAX_WIRE_STEPS}`,
      );
    }
    this.options = {
      scope: options.scope,
      controlPlaneUrl: options.controlPlaneUrl.replace(/\/+$/, ''),
      apiToken: options.apiToken,
      fetchImpl: options.fetchImpl ?? fetch,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      maxBatchSize: options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      maxBufferSize,
      outageMode: options.outageMode ?? 'fail-closed',
      onFlushError: options.onFlushError,
    };
  }

  record(step: StepObservationWire): void {
    this.history.push(step);
    this.sequence += 1;
    if (this.history.length > this.options.maxBufferSize) {
      this.history.splice(0, this.history.length - this.options.maxBufferSize);
    }
    if (this.sequence - this.lastSentSequence >= this.options.maxBatchSize) {
      // `record` is the explicitly asynchronous compatibility API, so it
      // cannot propagate a fail-closed rejection to its caller. Consume the
      // rejection after `sendWindow` reports it through `onFlushError`;
      // `recordAndFlush` separately awaits its own serialized flush.
      void this.flush().catch(() => undefined);
    }
  }

  /** Records and synchronously evaluates a completed call before control is
   * returned to the agent. A sequential agent that awaits this method can
   * therefore not dispatch its next guarded call before a detector-triggered
   * trip has committed. */
  async recordAndFlush(step: StepObservationWire): Promise<void> {
    this.record(step);
    await this.flush();
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
    const requestedSequence = this.sequence;
    if (requestedSequence <= this.lastSentSequence) return;
    const run = this.flushChain.then(async () => {
      if (requestedSequence <= this.lastSentSequence) return;
      await this.sendWindow(requestedSequence);
    });
    // Keep the internal chain usable after a fail-closed rejection while
    // returning the original rejection to the caller that must stop.
    this.flushChain = run.catch(() => undefined);
    return run;
  }

  private async sendWindow(requestedSequence: number): Promise<void> {
    const window = [...this.history];
    try {
      const res = await this.options.fetchImpl(
        `${this.options.controlPlaneUrl}/v1/detectors/observe`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.apiToken}`,
          },
          body: JSON.stringify({ scope: this.options.scope, steps: window }),
        },
      );
      if (!res.ok) {
        throw new Error(`step observation report rejected with HTTP ${res.status}`);
      }
      this.lastSentSequence = Math.max(this.lastSentSequence, requestedSequence);
    } catch (err) {
      this.options.onFlushError?.(err);
      if (this.options.outageMode === 'fail-closed') throw err;
      // In fail-open mode this observation is intentionally allowed to be
      // skipped. A later observation still carries the complete retained
      // window, so the detector can catch up when service recovers.
      this.lastSentSequence = Math.max(this.lastSentSequence, requestedSequence);
    }
  }
}
