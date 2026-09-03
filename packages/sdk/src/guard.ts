import { randomUUID } from 'node:crypto';
import {
  DetectorExecutionIdSchema,
  PermitResponseSchema,
  type DetectorProtectionStatus,
  type OutageMode,
  type PermitResponse,
  type Scope,
  type SpanTelemetrySampleWire,
  type StepObservationInputWire,
} from '@fuse/contracts';
import { withGenAiSpan, type GenAiOperationName } from '@fuse/otel';
import { BreakerTrippedError } from './errors.js';
import { PreflightReporter, type TraceExportResultWire } from './preflight-reporter.js';
import { StepObservationReporter } from './step-observation-reporter.js';
import { StepShapeCanonicalizer } from './step-shape-canonicalizer.js';

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
  /** Separate exact-scope credential used only by the supported OTel exporter
   * callback path. Without it, Preflight remains structural-only and cannot
   * report `protected`. */
  exporterEvidenceToken?: string;
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
  /** Hard deadline for detector reporting, including response parsing. */
  stepObservationTimeoutMs?: number;
  stepObservationMaxBatchSize?: number;
  /** Maximum execution-local detector windows retained by this guard. */
  stepObservationMaxExecutions?: number;
  /** Evicts inactive execution-local detector windows after this duration. */
  stepObservationExecutionIdleTtlMs?: number;
  /** Defaults to the guard's `outageMode`. Fail-closed is recommended:
   * detector observations are part of enforcement, not best-effort
   * observability. */
  stepObservationOutageMode?: OutageMode;
  onStepObservationReportError?: (err: unknown) => void;
}

export interface RunStepObservation {
  inputTokens: number;
  outputTokens: number;
  text: string;
  structure?: readonly string[];
  responseModel?: string;
  finishReasons?: string[];
}

export interface RunStepOptions<T> {
  /** Bounded session/run identity. Concurrent executions must use distinct IDs. */
  executionId: string;
  providerName: string;
  requestModel: string;
  kind: string;
  stepIndex: number;
  dispatch: () => Promise<T>;
  /** Extracts structural detector and OTel usage data from the provider result. */
  observe: (result: T) => RunStepObservation;
  operationName?: GenAiOperationName;
  correlationId?: string;
  taskId?: string;
  scenario?: string;
  conversationId?: string;
}

interface CanonicalizerState {
  canonicalizer: StepShapeCanonicalizer;
  lastTouchedAtMs: number;
}

const DEFAULT_TIMEOUT_MS = 300;

export class FuseGuard {
  private readonly options: Required<
    Omit<
      FuseGuardOptions,
      | 'onDecision'
      | 'onPreflightReportError'
      | 'onStepObservationReportError'
      | 'exporterEvidenceToken'
    >
  > & {
    onDecision: FuseGuardOptions['onDecision'];
    onPreflightReportError: FuseGuardOptions['onPreflightReportError'];
    onStepObservationReportError: FuseGuardOptions['onStepObservationReportError'];
    exporterEvidenceToken: string | undefined;
  };
  private preflightReporter: PreflightReporter | undefined;
  private stepObservationReporter: StepObservationReporter | undefined;
  private stepObservationProtectionFailure = false;
  private readonly canonicalizers = new Map<string, CanonicalizerState>();

  constructor(options: FuseGuardOptions) {
    if (
      options.stepObservationMaxExecutions !== undefined &&
      (!Number.isInteger(options.stepObservationMaxExecutions) ||
        options.stepObservationMaxExecutions <= 0)
    ) {
      throw new RangeError('stepObservationMaxExecutions must be a positive integer');
    }
    if (
      options.stepObservationExecutionIdleTtlMs !== undefined &&
      (!Number.isInteger(options.stepObservationExecutionIdleTtlMs) ||
        options.stepObservationExecutionIdleTtlMs <= 0)
    ) {
      throw new RangeError(
        'stepObservationExecutionIdleTtlMs must be a positive integer',
      );
    }
    this.options = {
      scope: options.scope,
      controlPlaneUrl: options.controlPlaneUrl.replace(/\/+$/, ''),
      apiToken: options.apiToken,
      exporterEvidenceToken: options.exporterEvidenceToken,
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
      stepObservationTimeoutMs: options.stepObservationTimeoutMs ?? 2_000,
      stepObservationMaxBatchSize: options.stepObservationMaxBatchSize ?? 200,
      stepObservationMaxExecutions: options.stepObservationMaxExecutions ?? 100,
      stepObservationExecutionIdleTtlMs:
        options.stepObservationExecutionIdleTtlMs ?? 60 * 60_000,
      stepObservationOutageMode:
        options.stepObservationOutageMode ?? options.outageMode ?? 'fail-closed',
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
    this.ensurePreflightReporter().record(sample);
  }

  /** Receives the matching per-scope callback from `bootstrapOtel`'s
   * `onTraceExportResult`. Local span callbacks alone cannot establish
   * protected status; only this real exporter result can. */
  recordTraceExportResult(result: TraceExportResultWire): Promise<void> {
    if (!this.options.reportPreflightTelemetry) return Promise.resolve();
    if (
      result.scope.tenant !== this.options.scope.tenant ||
      result.scope.environment !== this.options.scope.environment ||
      result.scope.agentId !== this.options.scope.agentId
    ) {
      return Promise.resolve();
    }
    return this.ensurePreflightReporter().recordTraceExportResult(result);
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

  /** Stops and drains Preflight reporting for graceful runtime shutdown. */
  async shutdownPreflightReporting(): Promise<void> {
    await this.preflightReporter?.drain();
  }

  private ensurePreflightReporter(): PreflightReporter {
    if (!this.preflightReporter) {
      this.preflightReporter = new PreflightReporter({
        scope: this.options.scope,
        controlPlaneUrl: this.options.controlPlaneUrl,
        apiToken: this.options.apiToken,
        ...(this.options.exporterEvidenceToken === undefined
          ? {}
          : { exporterEvidenceToken: this.options.exporterEvidenceToken }),
        fetchImpl: this.options.fetchImpl,
        flushIntervalMs: this.options.preflightFlushIntervalMs,
        maxBatchSize: this.options.preflightMaxBatchSize,
        onFlushError: this.options.onPreflightReportError,
      });
      this.preflightReporter.start();
    }
    return this.preflightReporter;
  }

  /**
   * Feeds one step observation into this guard's detector reporter
   * (task.md §4), so real telemetry — not just synthetic fixtures — drives
   * the `fuse.detector.score` gauge a SigNoz alert rule thresholds on.
   * No-ops if `reportStepObservations` was set to false. A fail-closed report
   * failure is latched for the next `guard` call rather than thrown after the
   * provider has already returned. Lazily created, same as
   * `recordSpanTelemetry`.
   */
  async recordStepObservation(step: StepObservationInputWire): Promise<void> {
    if (!this.options.reportStepObservations) return;
    try {
      await this.ensureStepObservationReporter().recordAndFlush(step);
    } catch {
      // This observation follows an already-paid provider result. Never turn
      // that success into a provider error: latch fail-closed protection and
      // enforce it at the next pre-dispatch boundary instead.
      if (this.options.stepObservationOutageMode === 'fail-closed') {
        this.stepObservationProtectionFailure = true;
      }
    }
  }

  /** Forces an immediate flush of any buffered step observations. */
  async flushStepObservations(): Promise<void> {
    await this.stepObservationReporter?.flush();
  }

  /** Returns truthful direct-detector coverage for one execution. */
  getDetectorProtection(executionId: string): DetectorProtectionStatus[] {
    return (
      this.stepObservationReporter?.getDetectorProtection(executionId) ??
      (['loop-signature', 'context-bloat', 'cost-velocity'] as const).map((detector) => ({
        detector,
        status: 'degraded' as const,
        reasonCode: 'no-observations' as const,
        reason: 'no completed step observations are retained for this execution',
      }))
    );
  }

  /** Drops retained evidence and canonicalization clusters for a fresh retry. */
  resetExecution(executionId: string): void {
    this.parseExecutionId(executionId);
    this.stepObservationReporter?.clearHistory(executionId);
    this.canonicalizers.delete(executionId);
  }

  /** Flushes pending evidence, then releases all execution-local state. */
  async endExecution(executionId: string): Promise<void> {
    this.parseExecutionId(executionId);
    let flushed = true;
    try {
      await this.stepObservationReporter?.flush(executionId);
    } catch {
      flushed = false;
      if (this.options.stepObservationOutageMode === 'fail-closed') {
        this.stepObservationProtectionFailure = true;
      }
    }
    // Retain failed evidence for the next-call recovery barrier. Deleting it
    // here would let the latch "recover" without ever delivering the paid
    // call that caused the failure.
    if (flushed) {
      this.stepObservationReporter?.endExecution(executionId);
      this.canonicalizers.delete(executionId);
    }
  }

  /** Stops the background flush timer. Safe to call even if step
   * observation reporting was never started. */
  stopStepObservationReporting(): void {
    this.stepObservationReporter?.stop();
  }

  /**
   * Supported direct-detection integration: permit -> provider dispatch ->
   * local canonicalization -> synchronous detector report. Reporting happens
   * after the paid provider result and therefore cannot rewrite that result as
   * a provider failure; fail-closed errors latch and deny the next call.
   */
  async runStep<T>(options: RunStepOptions<T>): Promise<T> {
    const executionId = this.parseExecutionId(options.executionId);
    const correlationId = options.correlationId ?? randomUUID();
    return this.guard(
      () =>
        withGenAiSpan(
          {
            operationName: options.operationName ?? 'chat',
            providerName: options.providerName,
            requestModel: options.requestModel,
            tenant: this.options.scope.tenant,
            environment: this.options.scope.environment,
            agentId: this.options.scope.agentId,
            sessionId: executionId,
            stepIndex: options.stepIndex,
            correlationId,
            ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
            ...(options.scenario !== undefined ? { scenario: options.scenario } : {}),
            conversationId: options.conversationId ?? executionId,
            onTelemetryObserved: (observation) => this.recordSpanTelemetry(observation),
            onStepObserved: (step) => this.recordStepObservation(step),
          },
          async () => {
            const result = await options.dispatch();
            const observation = options.observe(result);
            const canonicalShape = this.canonicalizerFor(executionId).canonicalize({
              kind: options.kind,
              text: observation.text,
              ...(observation.structure === undefined
                ? {}
                : { structure: observation.structure }),
            });
            return {
              result,
              outcome: {
                inputTokens: observation.inputTokens,
                outputTokens: observation.outputTokens,
                outcome: 'success' as const,
                canonicalShape,
                ...(observation.responseModel !== undefined
                  ? { responseModel: observation.responseModel }
                  : {}),
                ...(observation.finishReasons !== undefined
                  ? { finishReasons: observation.finishReasons }
                  : {}),
              },
            };
          },
        ),
      correlationId,
    );
  }

  private ensureStepObservationReporter(): StepObservationReporter {
    if (!this.stepObservationReporter) {
      this.stepObservationReporter = new StepObservationReporter({
        scope: this.options.scope,
        controlPlaneUrl: this.options.controlPlaneUrl,
        apiToken: this.options.apiToken,
        fetchImpl: this.options.fetchImpl,
        flushIntervalMs: this.options.stepObservationFlushIntervalMs,
        timeoutMs: this.options.stepObservationTimeoutMs,
        maxBatchSize: this.options.stepObservationMaxBatchSize,
        maxExecutions: this.options.stepObservationMaxExecutions,
        executionIdleTtlMs: this.options.stepObservationExecutionIdleTtlMs,
        outageMode: this.options.stepObservationOutageMode,
        onFlushError: this.options.onStepObservationReportError,
      });
    }
    return this.stepObservationReporter;
  }

  private canonicalizerFor(executionId: string): StepShapeCanonicalizer {
    const now = Date.now();
    const cutoff = now - this.options.stepObservationExecutionIdleTtlMs;
    for (const [id, state] of this.canonicalizers) {
      if (state.lastTouchedAtMs < cutoff) this.canonicalizers.delete(id);
    }
    const existing = this.canonicalizers.get(executionId);
    if (existing) {
      existing.lastTouchedAtMs = now;
      return existing.canonicalizer;
    }
    while (this.canonicalizers.size >= this.options.stepObservationMaxExecutions) {
      let oldestId: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, state] of this.canonicalizers) {
        if (state.lastTouchedAtMs < oldestAt) {
          oldestId = id;
          oldestAt = state.lastTouchedAtMs;
        }
      }
      if (oldestId === undefined) break;
      this.canonicalizers.delete(oldestId);
    }
    const canonicalizer = new StepShapeCanonicalizer();
    this.canonicalizers.set(executionId, { canonicalizer, lastTouchedAtMs: now });
    return canonicalizer;
  }

  private parseExecutionId(executionId: string): string {
    const parsed = DetectorExecutionIdSchema.safeParse(executionId);
    if (!parsed.success) {
      throw new RangeError(
        'executionId must be 1-128 characters using only letters, numbers, dot, underscore, colon, or hyphen',
      );
    }
    return parsed.data;
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
    if (this.stepObservationProtectionFailure) {
      let recovered = false;
      try {
        await this.stepObservationReporter?.flush();
        recovered = true;
        this.stepObservationProtectionFailure = false;
      } catch {
        // Keep the latch and retained evidence so a later guarded attempt can
        // retry recovery. No provider dispatch is possible on this path.
      }
      const decision: PermitResponse = {
        allowed: false,
        state: 'unknown',
        reason: recovered
          ? 'detector reporting recovered; this call was denied as the fail-closed recovery barrier, so retry it'
          : 'detector reporting remains unavailable; restore the detector endpoint and retry the guarded call',
        epoch: -1,
        degraded: true,
        correlationId,
      };
      this.reportDecision(decision, performance.now() - start);
      if (recovered) {
        this.stepObservationReporter?.clearHistory();
        this.canonicalizers.clear();
      }
      throw new BreakerTrippedError(
        decision,
        this.options.scope,
        'detector_reporting_unavailable',
      );
    }
    const decision = await this.checkPermit(correlationId);
    const latencyMs = performance.now() - start;
    this.reportDecision(decision, latencyMs);
    if (!decision.allowed) {
      this.stepObservationReporter?.clearHistory();
      this.canonicalizers.clear();
      throw new BreakerTrippedError(decision, this.options.scope);
    }
    return dispatch();
  }

  private reportDecision(decision: PermitResponse, latencyMs: number): void {
    this.options.onDecision?.({
      scope: this.options.scope,
      correlationId: decision.correlationId,
      allowed: decision.allowed,
      state: decision.state,
      degraded: decision.degraded,
      latencyMs,
      reason: decision.reason,
    });
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
