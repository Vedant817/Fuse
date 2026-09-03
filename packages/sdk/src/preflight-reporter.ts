import { Buffer } from 'node:buffer';
import type {
  ExporterDeliverySignal,
  Scope,
  SpanTelemetrySampleWire,
} from '@fuse/contracts';
import { compareExporterDeliverySignals } from '@fuse/contracts';

export interface TraceExportResultWire {
  scope: Scope;
  exporterDelivery: ExporterDeliverySignal;
  spans: SpanTelemetrySampleWire[];
}

export interface PreflightReporterOptions {
  scope: Scope;
  controlPlaneUrl: string;
  /** Ordinary exact-scope agent credential. This credential is used only for
   * structural reports and cannot submit exporter delivery evidence. */
  apiToken: string;
  /** Separate exact-scope exporter-evidence credential. When omitted, exporter
   * callbacks are downgraded to structural observations and can never establish
   * `protected`; the agent credential is never used as a fallback. */
  exporterEvidenceToken?: string;
  fetchImpl?: typeof fetch;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxBufferSize?: number;
  /** Maximum UTF-8 request body size, including scope and exporter metadata. */
  maxRequestBytes?: number;
  /** Hard deadline for one HTTP attempt. */
  requestTimeoutMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryJitterRatio?: number;
  /** Upper bound for graceful drain, including an AbortSignal-ignoring fetch. */
  shutdownTimeoutMs?: number;
  /** Test hook for deterministic retry jitter. */
  random?: () => number;
  onFlushError?: ((err: unknown) => void) | undefined;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BATCH_SIZE = 200;
const DEFAULT_MAX_BUFFER_SIZE = 2_000;
const DEFAULT_MAX_REQUEST_BYTES = 60 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 10_000;
const DEFAULT_RETRY_JITTER_RATIO = 0.2;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;

type SendOutcome = 'success' | 'transient-failure' | 'permanent-failure' | 'hung';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Reports bounded structural Preflight evidence off the guarded-call path.
 * At most one exporter result is pending and one request is in flight. Newer
 * same-source evidence replaces older unacknowledged evidence, so transient
 * outages cannot create an unbounded operation queue.
 */
export class PreflightReporter {
  private buffer: SpanTelemetrySampleWire[] = [];
  private pendingExporter: TraceExportResultWire | undefined;
  private acknowledgedExporter: ExporterDeliverySignal | undefined;
  private worker: Promise<void> | undefined;
  private hungFetch: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempt = 0;
  private draining = false;
  private closed = false;
  private readonly options: Required<
    Omit<PreflightReporterOptions, 'onFlushError' | 'exporterEvidenceToken'>
  > & {
    onFlushError: PreflightReporterOptions['onFlushError'];
    exporterEvidenceToken: string | undefined;
  };

  constructor(options: PreflightReporterOptions) {
    this.options = {
      scope: options.scope,
      controlPlaneUrl: options.controlPlaneUrl.replace(/\/+$/, ''),
      apiToken: options.apiToken,
      exporterEvidenceToken: options.exporterEvidenceToken,
      fetchImpl: options.fetchImpl ?? fetch,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      maxBatchSize: options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      maxBufferSize: options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE,
      maxRequestBytes: options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
      retryJitterRatio: options.retryJitterRatio ?? DEFAULT_RETRY_JITTER_RATIO,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      random: options.random ?? Math.random,
      onFlushError: options.onFlushError,
    };
    this.validateOptions();
  }

  record(sample: SpanTelemetrySampleWire): void {
    if (this.closed) return;
    this.buffer.push(sample);
    if (this.buffer.length > this.options.maxBufferSize) {
      this.buffer.splice(0, this.buffer.length - this.options.maxBufferSize);
    }
    if (this.buffer.length >= this.options.maxBatchSize) void this.kick(true);
  }

  /** Keeps only the newest unacknowledged exporter result. Different source
   * identities are intentionally not clock-ordered; a change replaces the
   * reporter's prior identity as a process restart/rebootstrap boundary. */
  recordTraceExportResult(result: TraceExportResultWire): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.options.exporterEvidenceToken) {
      for (const span of result.spans) this.record(span);
      this.reportError(
        new Error(
          'exporter evidence was not submitted because exporterEvidenceToken is not configured',
        ),
      );
      return this.kick(true);
    }
    const newest = this.pendingExporter?.exporterDelivery ?? this.acknowledgedExporter;
    if (
      newest &&
      newest.sourceInstanceId === result.exporterDelivery.sourceInstanceId &&
      compareExporterDeliverySignals(result.exporterDelivery, newest) <= 0
    ) {
      return this.worker ?? Promise.resolve();
    }
    this.pendingExporter = {
      ...result,
      spans: result.spans.slice(-this.options.maxBufferSize),
    };
    this.retryAttempt = 0;
    return this.kick(true);
  }

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.kick(true), this.options.flushIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  flush(_revalidateExporterEvidence = false): Promise<void> {
    return this.kick(true);
  }

  /** Stops periodic work and makes one final bounded delivery attempt. */
  async drain(): Promise<void> {
    if (this.closed || this.draining) {
      await this.worker;
      return;
    }
    this.draining = true;
    this.stop();
    this.clearRetryTimer();
    const finalAttempt = this.kick(true);
    await Promise.race([finalAttempt, delay(this.options.shutdownTimeoutMs)]);
    this.closed = true;
    this.clearRetryTimer();
  }

  private validateOptions(): void {
    const positiveIntegers: Array<[string, number]> = [
      ['flushIntervalMs', this.options.flushIntervalMs],
      ['maxBatchSize', this.options.maxBatchSize],
      ['maxBufferSize', this.options.maxBufferSize],
      ['maxRequestBytes', this.options.maxRequestBytes],
      ['requestTimeoutMs', this.options.requestTimeoutMs],
      ['retryBaseDelayMs', this.options.retryBaseDelayMs],
      ['retryMaxDelayMs', this.options.retryMaxDelayMs],
      ['shutdownTimeoutMs', this.options.shutdownTimeoutMs],
    ];
    for (const [name, value] of positiveIntegers) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
    if (this.options.retryBaseDelayMs > this.options.retryMaxDelayMs) {
      throw new RangeError('retryBaseDelayMs must not exceed retryMaxDelayMs');
    }
    if (this.options.maxBufferSize > DEFAULT_MAX_BUFFER_SIZE) {
      throw new RangeError(`maxBufferSize must not exceed ${DEFAULT_MAX_BUFFER_SIZE}`);
    }
    if (this.options.maxRequestBytes > DEFAULT_MAX_REQUEST_BYTES) {
      throw new RangeError(
        `maxRequestBytes must not exceed ${DEFAULT_MAX_REQUEST_BYTES}`,
      );
    }
    if (
      this.options.retryJitterRatio < 0 ||
      this.options.retryJitterRatio > 1 ||
      !Number.isFinite(this.options.retryJitterRatio)
    ) {
      throw new RangeError('retryJitterRatio must be between 0 and 1');
    }
  }

  private kick(force: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (force) this.clearRetryTimer();
    if (this.worker) return this.worker;
    if (this.hungFetch) return Promise.resolve();
    if (!this.pendingExporter && this.buffer.length === 0) return Promise.resolve();

    this.worker = this.runOneAttempt().finally(() => {
      this.worker = undefined;
      if (
        !this.closed &&
        !this.hungFetch &&
        !this.retryTimer &&
        (this.pendingExporter || this.buffer.length > 0)
      ) {
        void this.kick(false);
      }
    });
    return this.worker;
  }

  private async runOneAttempt(): Promise<void> {
    const exporter = this.pendingExporter;
    const localBatch = exporter
      ? undefined
      : this.buffer.splice(0, Math.min(this.buffer.length, this.options.maxBatchSize));
    const spans = exporter?.spans ?? localBatch ?? [];
    const body = this.buildBoundedBody(spans, exporter?.exporterDelivery);
    if (!body) {
      if (exporter === this.pendingExporter) this.pendingExporter = undefined;
      return;
    }

    const outcome = await this.send(body, exporter !== undefined);
    if (outcome === 'success') {
      if (exporter && exporter === this.pendingExporter) {
        this.acknowledgedExporter = exporter.exporterDelivery;
        this.pendingExporter = undefined;
      }
      this.retryAttempt = 0;
      return;
    }
    if (!exporter) return;
    if (outcome === 'permanent-failure') {
      if (exporter === this.pendingExporter) this.pendingExporter = undefined;
      this.retryAttempt = 0;
      return;
    }

    if (exporter !== this.pendingExporter) this.retryAttempt = 0;
    this.retryAttempt += 1;
    this.scheduleRetry();
  }

  private buildBoundedBody(
    spans: readonly SpanTelemetrySampleWire[],
    exporterDelivery: ExporterDeliverySignal | undefined,
  ): string | undefined {
    const serialize = (count: number): string =>
      JSON.stringify({
        scope: this.options.scope,
        spans: spans.slice(spans.length - count),
        ...(exporterDelivery ? { exporterDelivery } : {}),
      });

    const empty = serialize(0);
    if (Buffer.byteLength(empty, 'utf8') > this.options.maxRequestBytes) {
      this.reportError(new Error('preflight report metadata exceeds maxRequestBytes'));
      return undefined;
    }
    let low = 0;
    let high = spans.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(serialize(middle), 'utf8') <= this.options.maxRequestBytes) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return serialize(low);
  }

  private async send(body: string, exporterEvidence: boolean): Promise<SendOutcome> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const fetchPromise = Promise.resolve()
      .then(() =>
        this.options.fetchImpl(
          `${this.options.controlPlaneUrl}${
            exporterEvidence ? '/v1/preflight/exporter-evidence' : '/v1/preflight/report'
          }`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${
                exporterEvidence
                  ? this.options.exporterEvidenceToken!
                  : this.options.apiToken
              }`,
            },
            body,
            signal: controller.signal,
          },
        ),
      )
      .finally(() => {
        settled = true;
      });
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, this.options.requestTimeoutMs);
      timeout.unref?.();
    });

    try {
      const response = await Promise.race([fetchPromise, timeoutPromise]);
      if (response === 'timeout') {
        const error = new Error(
          `preflight report timed out after ${this.options.requestTimeoutMs}ms`,
        );
        this.reportError(error);
        if (!settled) {
          const hung = fetchPromise
            .then(
              () => undefined,
              () => undefined,
            )
            .finally(() => {
              if (this.hungFetch === hung) this.hungFetch = undefined;
              if (!this.closed) void this.kick(false);
            });
          this.hungFetch = hung;
          return 'hung';
        }
        return 'transient-failure';
      }
      if (response.ok) return 'success';
      const error = new Error(`preflight report rejected with HTTP ${response.status}`);
      this.reportError(error);
      return response.status === 408 || response.status === 429 || response.status >= 500
        ? 'transient-failure'
        : 'permanent-failure';
    } catch (err) {
      this.reportError(err);
      return 'transient-failure';
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.closed || this.draining) return;
    const exponential = Math.min(
      this.options.retryMaxDelayMs,
      this.options.retryBaseDelayMs * 2 ** Math.min(this.retryAttempt - 1, 30),
    );
    const jitter =
      exponential * this.options.retryJitterRatio * (this.options.random() * 2 - 1);
    const waitMs = Math.max(1, Math.round(exponential + jitter));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.kick(false);
    }, waitMs);
    this.retryTimer.unref?.();
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private reportError(error: unknown): void {
    try {
      this.options.onFlushError?.(error);
    } catch {
      // An observability callback must not escape into guarded application code.
    }
  }
}
