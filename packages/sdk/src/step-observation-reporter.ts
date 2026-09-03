import {
  MAX_STEP_OBSERVATIONS_PER_REQUEST,
  ObserveStepsResponseSchema,
  StepObservationSchema,
  type DetectorProtectionStatus,
  type OutageMode,
  type Scope,
  type StepObservationInputWire,
} from '@fuse/contracts';

export interface StepObservationReporterOptions {
  scope: Scope;
  controlPlaneUrl: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  flushIntervalMs?: number;
  timeoutMs?: number;
  maxBatchSize?: number;
  /** Per-execution trailing-window cap. */
  maxBufferSize?: number;
  /** Total execution histories retained by one reporter. */
  maxExecutions?: number;
  /** Inactive execution histories older than this are evicted. */
  executionIdleTtlMs?: number;
  outageMode?: OutageMode;
  onFlushError?: ((err: unknown) => void) | undefined;
}

interface HistoryEntry {
  sequence: number;
  step: StepObservationInputWire;
}

interface ExecutionHistory {
  entries: HistoryEntry[];
  sequence: number;
  lastSentSequence: number;
  lastTouchedAtMs: number;
  reportingUnavailable: boolean;
  flushChain: Promise<void>;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_BATCH_SIZE = 200;
const DEFAULT_MAX_BUFFER_SIZE = MAX_STEP_OBSERVATIONS_PER_REQUEST;
const DEFAULT_MAX_EXECUTIONS = 100;
const DEFAULT_EXECUTION_IDLE_TTL_MS = 60 * 60_000;

/**
 * Carries one bounded trailing window per execution to
 * `POST /v1/detectors/observe`. Windows are never merged across execution IDs,
 * even when calls from multiple sessions complete concurrently.
 */
export class StepObservationReporter {
  private readonly histories = new Map<string, ExecutionHistory>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly options: Required<
    Omit<StepObservationReporterOptions, 'onFlushError'>
  > & {
    onFlushError: StepObservationReporterOptions['onFlushError'];
  };

  constructor(options: StepObservationReporterOptions) {
    const maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxExecutions = options.maxExecutions ?? DEFAULT_MAX_EXECUTIONS;
    const executionIdleTtlMs =
      options.executionIdleTtlMs ?? DEFAULT_EXECUTION_IDLE_TTL_MS;
    if (
      !Number.isInteger(maxBufferSize) ||
      maxBufferSize <= 0 ||
      maxBufferSize > MAX_STEP_OBSERVATIONS_PER_REQUEST
    ) {
      throw new RangeError(
        `maxBufferSize must be an integer from 1 to ${MAX_STEP_OBSERVATIONS_PER_REQUEST}`,
      );
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be a positive integer');
    }
    if (!Number.isInteger(maxExecutions) || maxExecutions <= 0) {
      throw new RangeError('maxExecutions must be a positive integer');
    }
    if (!Number.isInteger(executionIdleTtlMs) || executionIdleTtlMs <= 0) {
      throw new RangeError('executionIdleTtlMs must be a positive integer');
    }
    this.options = {
      scope: options.scope,
      controlPlaneUrl: options.controlPlaneUrl.replace(/\/+$/, ''),
      apiToken: options.apiToken,
      fetchImpl: options.fetchImpl ?? fetch,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      timeoutMs,
      maxBatchSize: options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      maxBufferSize,
      maxExecutions,
      executionIdleTtlMs,
      outageMode: options.outageMode ?? 'fail-closed',
      onFlushError: options.onFlushError,
    };
  }

  record(step: StepObservationInputWire): void {
    const history = this.append(step);
    if (history.sequence - history.lastSentSequence >= this.options.maxBatchSize) {
      void this.flush(step.executionId).catch(() => undefined);
    }
  }

  private append(input: StepObservationInputWire): ExecutionHistory {
    const step = StepObservationSchema.parse(input);
    const history = this.historyFor(step.executionId);
    history.sequence += 1;
    history.lastTouchedAtMs = Date.now();
    history.entries.push({ sequence: history.sequence, step });
    if (history.entries.length > this.options.maxBufferSize) {
      history.entries.splice(0, history.entries.length - this.options.maxBufferSize);
    }
    return history;
  }

  async recordAndFlush(step: StepObservationInputWire): Promise<void> {
    this.append(step);
    await this.flush(step.executionId);
  }

  /** Resets one execution, or every execution when omitted. */
  clearHistory(executionId?: string): void {
    if (executionId !== undefined) {
      const history = this.histories.get(executionId);
      if (!history) return;
      history.entries = [];
      history.lastSentSequence = history.sequence;
      history.reportingUnavailable = false;
      history.lastTouchedAtMs = Date.now();
      return;
    }
    this.histories.clear();
  }

  /** Ends an execution and releases all retained detector context. */
  endExecution(executionId: string): void {
    this.histories.delete(executionId);
  }

  getDetectorProtection(executionId: string): DetectorProtectionStatus[] {
    const history = this.histories.get(executionId);
    if (!history || history.entries.length === 0) {
      return protectionStatuses('degraded', 'no-observations');
    }
    if (history.reportingUnavailable) {
      return protectionStatuses('degraded', 'reporting-unavailable');
    }
    const pricingUnavailable = history.entries.some(
      ({ step }) => step.pricingStatus === 'unavailable',
    );
    return [
      protectedStatus('loop-signature'),
      protectedStatus('context-bloat'),
      pricingUnavailable
        ? {
            detector: 'cost-velocity',
            status: 'degraded',
            reasonCode: 'pricing-unavailable',
            reason:
              'one or more calls have no defensible price; cost velocity is unavailable for this execution',
          }
        : protectedStatus('cost-velocity'),
    ];
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch(() => undefined);
    }, this.options.flushIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Flushes one execution, or all active executions when omitted. */
  async flush(executionId?: string): Promise<void> {
    this.evictIdleHistories();
    if (executionId !== undefined) {
      const history = this.histories.get(executionId);
      if (history) await this.flushHistory(executionId, history);
      return;
    }
    await Promise.all(
      [...this.histories.entries()].map(([id, history]) =>
        this.flushHistory(id, history),
      ),
    );
  }

  private async flushHistory(
    executionId: string,
    history: ExecutionHistory,
  ): Promise<void> {
    const requestedSequence = history.sequence;
    if (requestedSequence <= history.lastSentSequence) return;
    const run = history.flushChain.then(async () => {
      if (requestedSequence <= history.lastSentSequence) return;
      await this.sendWindow(executionId, history, requestedSequence);
    });
    history.flushChain = run.catch(() => undefined);
    return run;
  }

  private async sendWindow(
    executionId: string,
    history: ExecutionHistory,
    requestedSequence: number,
  ): Promise<void> {
    const window = history.entries
      .filter((entry) => entry.sequence <= requestedSequence)
      .map((entry) => entry.step);
    if (window.length === 0) {
      history.lastSentSequence = Math.max(history.lastSentSequence, requestedSequence);
      return;
    }
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = (async () => {
        const res = await this.options.fetchImpl(
          `${this.options.controlPlaneUrl}/v1/detectors/observe`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${this.options.apiToken}`,
            },
            body: JSON.stringify({ scope: this.options.scope, steps: window }),
            signal: controller.signal,
          },
        );
        if (!res.ok) {
          throw new Error(`step observation report rejected with HTTP ${res.status}`);
        }
        const parsed = ObserveStepsResponseSchema.safeParse(await res.json());
        if (!parsed.success) {
          throw new Error('control plane returned a malformed detector response');
        }
        return parsed.data;
      })();
      const response = await Promise.race([
        request,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(
              new Error(
                `step observation report timed out after ${this.options.timeoutMs}ms`,
              ),
            );
          }, this.options.timeoutMs);
        }),
      ]);
      history.lastSentSequence = Math.max(history.lastSentSequence, requestedSequence);
      history.reportingUnavailable = false;
      history.lastTouchedAtMs = Date.now();
      if (
        response.enforcement.some(
          ({ outcome }) => outcome === 'tripped' || outcome === 'already-tripped',
        )
      ) {
        history.entries = history.entries.filter(
          (entry) => entry.sequence > requestedSequence,
        );
      }
    } catch (err) {
      history.reportingUnavailable = true;
      try {
        this.options.onFlushError?.(err);
      } catch {
        // Error observers never replace the original reporting outcome.
      }
      if (this.options.outageMode === 'fail-closed') throw err;
      history.lastSentSequence = Math.max(history.lastSentSequence, requestedSequence);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private historyFor(executionId: string): ExecutionHistory {
    this.evictIdleHistories();
    const existing = this.histories.get(executionId);
    if (existing) return existing;
    while (this.histories.size >= this.options.maxExecutions) {
      let oldestId: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, history] of this.histories) {
        if (history.lastTouchedAtMs < oldestAt) {
          oldestId = id;
          oldestAt = history.lastTouchedAtMs;
        }
      }
      if (oldestId === undefined) break;
      this.histories.delete(oldestId);
    }
    const history: ExecutionHistory = {
      entries: [],
      sequence: 0,
      lastSentSequence: 0,
      lastTouchedAtMs: Date.now(),
      reportingUnavailable: false,
      flushChain: Promise.resolve(),
    };
    this.histories.set(executionId, history);
    return history;
  }

  private evictIdleHistories(): void {
    const cutoff = Date.now() - this.options.executionIdleTtlMs;
    for (const [executionId, history] of this.histories) {
      if (history.lastTouchedAtMs < cutoff) this.histories.delete(executionId);
    }
  }
}

function protectedStatus(
  detector: DetectorProtectionStatus['detector'],
): DetectorProtectionStatus {
  return {
    detector,
    status: 'protected',
    reasonCode: 'healthy',
    reason: 'required direct-detector evidence is available for this execution',
  };
}

function protectionStatuses(
  status: 'degraded',
  reasonCode: 'no-observations' | 'reporting-unavailable',
): DetectorProtectionStatus[] {
  const reason =
    reasonCode === 'no-observations'
      ? 'no completed step observations are retained for this execution'
      : 'direct detector reporting is unavailable for this execution';
  return (['loop-signature', 'context-bloat', 'cost-velocity'] as const).map(
    (detector) => ({ detector, status, reasonCode, reason }),
  );
}
