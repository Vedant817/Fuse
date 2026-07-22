import { randomUUID } from 'node:crypto';
import {
  PermitResponseSchema,
  type OutageMode,
  type PermitResponse,
  type Scope,
  type SpanTelemetrySampleWire,
  type StepObservationWire,
} from '@fuse/contracts';
import { BreakerTrippedError } from './errors.js';
import { PreflightReporter } from './preflight-reporter.js';
import { StepObservationReporter } from './step-observation-reporter.js';

export interface PermitDecisionTelemetry {
  scope: Scope;
  correlationId: string;
  allowed: boolean;
  state: PermitResponse['state'];
  degraded: boolean;
  latencyMs: number;
  reason: string;
}

export interface FuseGuardOptions {
  scope: Scope;
  controlPlaneUrl: string;
  apiToken: string;
  /** Deadline for the permit check itself, not for the wrapped call. */
  timeoutMs?: number;
  /** Behavior when the control plane cannot be reached at all (network
   * error, timeout, non-2xx, malformed response) within `timeoutMs`. This
   * is the SDK-side fallback and is distinct from the control plane's own
   * `storeOutageMode`, which governs what happens when the control plane
   * itself can reach the SDK but not its store. */
  outageMode?: OutageMode;
  fetchImpl?: typeof fetch;
  onDecision?: (event: PermitDecisionTelemetry) => void;
  /** Whether span telemetry passed to `recordSpanTelemetry` is reported to
   * Preflight. Defaults to true; set false to opt out entirely (e.g. a
   * caller that manages its own reporting path). */
  reportPreflightTelemetry?: boolean;
  preflightFlushIntervalMs?: number;
  preflightMaxBatchSize?: number;
  onPreflightReportError?: (err: unknown) => void;
  /** Whether step observations passed to `recordStepObservation` are
   * reported for detector evaluation (task.md §4). Defaults to true. */
  reportStepObservations?: boolean;
  stepObservationFlushIntervalMs?: number;
  stepObservationMaxBatchSize?: number;
  onStepObservationReportError?: (err: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 300;

export class FuseGuard {
  private readonly options: Required<
    Omit<
      FuseGuardOptions,
      'onDecision' | 'onPreflightReportError' | 'onStepObservationReportError'
    >
  > & {
    onDecision: FuseGuardOptions['onDecision'];
    onPreflightReportError: FuseGuardOptions['onPreflightReportError'];
    onStepObservationReportError: FuseGuardOptions['onStepObservationReportError'];
  };
  private preflightReporter: PreflightReporter | undefined;
  private stepObservationReporter: StepObservationReporter | undefined;

  constructor(options: FuseGuardOptions) {
    this.options = {
      scope: options.scope,
      controlPlaneUrl: options.controlPlaneUrl.replace(/\/+$/, ''),
      apiToken: options.apiToken,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      outageMode: options.outageMode ?? 'fail-closed',
      fetchImpl: options.fetchImpl ?? fetch,
      onDecision: options.onDecision,
      reportPreflightTelemetry: options.reportPreflightTelemetry ?? true,
      preflightFlushIntervalMs: options.preflightFlushIntervalMs ?? 5_000,
      preflightMaxBatchSize: options.preflightMaxBatchSize ?? 200,
      onPreflightReportError: options.onPreflightReportError,
      reportStepObservations: options.reportStepObservations ?? true,
      stepObservationFlushIntervalMs: options.stepObservationFlushIntervalMs ?? 5_000,
      stepObservationMaxBatchSize: options.stepObservationMaxBatchSize ?? 200,
      onStepObservationReportError: options.onStepObservationReportError,
    };
  }

  /** The scope this guard was constructed with — useful for callers (e.g.
   * OTel instrumentation) that need to tag telemetry with the same
   * tenant/environment/agentId without duplicating it in their own config. */
  get scope(): Scope {
    return this.options.scope;
  }

  /**
   * Feeds one span's telemetry observation into this guard's Preflight
   * reporter — the live-wiring path for task.md §6.2, so a scope's
   * Preflight state reflects the same real telemetry the breaker itself
   * would see, without extra integration work by the caller. No-ops if
   * `reportPreflightTelemetry` was set to false. The reporter is created
   * lazily (on first call) so a `FuseGuard` that never records telemetry
   * never starts a background timer.
   */
  recordSpanTelemetry(sample: SpanTelemetrySampleWire): void {
    if (!this.options.reportPreflightTelemetry) return;
    if (!this.preflightReporter) {
      this.preflightReporter = new PreflightReporter({
        scope: this.options.scope,
        controlPlaneUrl: this.options.controlPlaneUrl,
        apiToken: this.options.apiToken,
        fetchImpl: this.options.fetchImpl,
        flushIntervalMs: this.options.preflightFlushIntervalMs,
        maxBatchSize: this.options.preflightMaxBatchSize,
        onFlushError: this.options.onPreflightReportError,
      });
      this.preflightReporter.start();
    }
    this.preflightReporter.record(sample);
  }

  /** Forces an immediate flush of any buffered telemetry — useful at
   * graceful shutdown or in tests, where waiting for the background
   * timer isn't desirable. No-ops if nothing has been recorded yet. */
  async flushPreflightTelemetry(): Promise<void> {
    await this.preflightReporter?.flush();
  }

  /** Stops the background flush timer. Safe to call even if telemetry
   * reporting was never started. */
  stopPreflightReporting(): void {
    this.preflightReporter?.stop();
  }

  /**
   * Feeds one step observation into this guard's detector reporter
   * (task.md §4), so real telemetry — not just synthetic fixtures — drives
   * the `fuse.detector.score` gauge a SigNoz alert rule thresholds on.
   * No-ops if `reportStepObservations` was set to false. Lazily created,
   * same as `recordSpanTelemetry`.
   */
  recordStepObservation(step: StepObservationWire): void {
    if (!this.options.reportStepObservations) return;
    if (!this.stepObservationReporter) {
      this.stepObservationReporter = new StepObservationReporter({
        scope: this.options.scope,
        controlPlaneUrl: this.options.controlPlaneUrl,
        apiToken: this.options.apiToken,
        fetchImpl: this.options.fetchImpl,
        flushIntervalMs: this.options.stepObservationFlushIntervalMs,
        maxBatchSize: this.options.stepObservationMaxBatchSize,
        onFlushError: this.options.onStepObservationReportError,
      });
      this.stepObservationReporter.start();
    }
    this.stepObservationReporter.record(step);
  }

  /** Forces an immediate flush of any buffered step observations. */
  async flushStepObservations(): Promise<void> {
    await this.stepObservationReporter?.flush();
  }

  /** Stops the background flush timer. Safe to call even if step
   * observation reporting was never started. */
  stopStepObservationReporting(): void {
    this.stepObservationReporter?.stop();
  }

  /**
   * Checks a permit immediately before invoking `dispatch`. If the permit
   * is denied, `dispatch` is never called and a `BreakerTrippedError` is
   * thrown instead. There is no local caching or pre-check optimization
   * that could let a call skip this step — every guarded call performs a
   * fresh permit check against the control plane.
   */
  async guard<T>(
    dispatch: () => Promise<T>,
    correlationId: string = randomUUID(),
  ): Promise<T> {
    const start = performance.now();
    const decision = await this.checkPermit(correlationId);
    const latencyMs = performance.now() - start;
    this.options.onDecision?.({
      scope: this.options.scope,
      correlationId,
      allowed: decision.allowed,
      state: decision.state,
      degraded: decision.degraded,
      latencyMs,
      reason: decision.reason,
    });
    if (!decision.allowed) {
      throw new BreakerTrippedError(decision, this.options.scope);
    }
    return dispatch();
  }

  private async checkPermit(correlationId: string): Promise<PermitResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const res = await this.options.fetchImpl(
        `${this.options.controlPlaneUrl}/v1/permit`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.apiToken}`,
          },
          body: JSON.stringify({ scope: this.options.scope, correlationId }),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        return this.degradedDecision(
          correlationId,
          `control plane returned HTTP ${res.status}`,
        );
      }
      const parsed = PermitResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        return this.degradedDecision(
          correlationId,
          'control plane returned a malformed permit response',
        );
      }
      return parsed.data;
    } catch (err) {
      return this.degradedDecision(
        correlationId,
        `control plane unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private degradedDecision(correlationId: string, reason: string): PermitResponse {
    return {
      allowed: this.options.outageMode === 'fail-open',
      state: 'unknown',
      reason: `${reason}; applying configured SDK outage mode (${this.options.outageMode})`,
      epoch: -1,
      degraded: true,
      correlationId,
    };
  }
}
