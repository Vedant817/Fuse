import { context, SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import {
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOKEN_TYPE,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
} from '@opentelemetry/semantic-conventions/incubating';
import {
  ATTR_FUSE_AGENT_ID,
  ATTR_FUSE_CORRELATION_ID,
  ATTR_FUSE_ENVIRONMENT,
  ATTR_FUSE_ESTIMATED_COST_USD,
  ATTR_FUSE_OUTCOME,
  ATTR_FUSE_SCENARIO,
  ATTR_FUSE_SESSION_ID,
  ATTR_FUSE_STEP_INDEX,
  ATTR_FUSE_TASK_ID,
  ATTR_FUSE_TENANT,
} from './attributes.js';
import {
  getEstimatedCostCounter,
  getOperationDurationHistogram,
  getTokenUsageHistogram,
} from './metrics.js';
import { estimateCostUsd } from './pricing.js';

const TRACER_NAME = 'fuse.gen_ai';
const TRACER_VERSION = '1.0.0';

export type GenAiOperationName =
  'chat' | 'text_completion' | 'generate_content' | 'invoke_agent';

export interface GenAiSpanContext {
  operationName: GenAiOperationName;
  providerName: string;
  requestModel: string;
  tenant: string;
  environment: string;
  agentId: string;
  sessionId: string;
  taskId?: string;
  stepIndex: number;
  scenario?: string;
  conversationId?: string;
  correlationId: string;
  /** Fired once, after the span ends (success or error), with a
   * structural observation of what this span actually recorded — the
   * live-wiring path Preflight reporting hangs off of (task.md §6.2). */
  onTelemetryObserved?: (observation: SpanTelemetryObservation) => void;
  /** Fired once, after a successful call whose `outcome.canonicalShape` is
   * set, with the numeric data the loop-signature/context-bloat/cost-
   * velocity detectors need (task.md §4). */
  onStepObserved?: (step: StepObservation) => void;
}

export interface GenAiSpanOutcome {
  responseModel?: string;
  inputTokens: number;
  outputTokens: number;
  finishReasons?: string[];
  outcome: 'success' | 'denied' | 'error';
  /** A caller-computed, already-canonicalized label for this step's
   * "shape" — e.g. a hash of the model output, excluding volatile IDs/
   * timestamps/token counts (see `packages/detectors/src/types.ts`'s
   * `StepRecord.canonicalShape` doc comment; this is the same contract).
   * Only the caller knows what makes two steps "the same shape" for its
   * own agent loop, so this package never invents one — and only the
   * caller's `fn` knows it, since it depends on the call's own result, not
   * anything known before dispatch. Leave undefined for calls that aren't a
   * detectable "step" (e.g. the root `invoke_agent` span's own outcome) —
   * `onStepObserved` only fires when this is set. */
  canonicalShape?: string;
}

/**
 * A structural observation of one completed span's telemetry health,
 * shaped to match `@fuse/contracts`' `SpanTelemetrySampleWire` field for
 * field. Kept as a locally-owned type (not imported from `@fuse/contracts`)
 * so this package stays free of a dependency on the wire-contract layer —
 * callers that DO depend on contracts (e.g. `@fuse/sdk`) can pass this
 * straight through to the Preflight report request body.
 */
export interface SpanTelemetryObservation {
  timestampMs: number;
  hasRequestModel: boolean;
  hasInputTokens: boolean;
  hasOutputTokens: boolean;
  hasScopedIdentity: boolean;
  hasValidTimestamps: boolean;
  isRootSpan: boolean;
  hasParent: boolean;
}

/**
 * The numeric shape `@fuse/detectors`' `StepRecord` needs, field for field
 * (kept as a locally-owned type for the same reason `SpanTelemetryObservation`
 * is — this package stays free of a dependency on the wire-contract layer).
 */
export interface StepObservation {
  timestampMs: number;
  canonicalShape: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

/**
 * Wraps one gen_ai client operation in a CLIENT-kind span carrying the
 * standard `gen_ai.*` attributes plus Fuse's `fuse.*` namespaced
 * extensions, and records the token-usage/duration metrics for it.
 * `fn` receives the active span (already the current context — a nested
 * call inside `fn` automatically becomes its child, which is how parent-
 * chain propagation across steps is preserved without any extra plumbing)
 * and must return both its own result and the `GenAiSpanOutcome` needed to
 * fill in post-call attributes.
 */
export async function withGenAiSpan<T>(
  ctx: GenAiSpanContext,
  fn: (span: Span) => Promise<{ result: T; outcome: GenAiSpanOutcome }>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
  // Captured before `startActiveSpan` enters its own context — inside the
  // callback, `context.active()` refers to the new span itself, not its
  // parent, so the parent check must happen out here.
  const hasParent = trace.getSpan(context.active()) !== undefined;
  return tracer.startActiveSpan(
    `${ctx.operationName} ${ctx.requestModel}`,
    { kind: SpanKind.CLIENT },
    async (span) => {
      const startMillis = performance.now();
      const observedAtMs = Date.now();
      let observedOutcome: GenAiSpanOutcome | undefined;
      span.setAttributes({
        [ATTR_GEN_AI_OPERATION_NAME]: ctx.operationName,
        [ATTR_GEN_AI_PROVIDER_NAME]: ctx.providerName,
        [ATTR_GEN_AI_REQUEST_MODEL]: ctx.requestModel,
        [ATTR_FUSE_TENANT]: ctx.tenant,
        [ATTR_FUSE_ENVIRONMENT]: ctx.environment,
        [ATTR_FUSE_AGENT_ID]: ctx.agentId,
        [ATTR_FUSE_SESSION_ID]: ctx.sessionId,
        [ATTR_FUSE_STEP_INDEX]: ctx.stepIndex,
        [ATTR_FUSE_CORRELATION_ID]: ctx.correlationId,
        ...(ctx.taskId !== undefined ? { [ATTR_FUSE_TASK_ID]: ctx.taskId } : {}),
        ...(ctx.scenario !== undefined ? { [ATTR_FUSE_SCENARIO]: ctx.scenario } : {}),
        ...(ctx.conversationId !== undefined
          ? { [ATTR_GEN_AI_CONVERSATION_ID]: ctx.conversationId }
          : {}),
      });

      try {
        const { result, outcome } = await fn(span);
        observedOutcome = outcome;
        const durationSeconds = (performance.now() - startMillis) / 1000;

        span.setAttributes({
          [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: outcome.inputTokens,
          [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: outcome.outputTokens,
          [ATTR_FUSE_OUTCOME]: outcome.outcome,
          ...(outcome.responseModel !== undefined
            ? { [ATTR_GEN_AI_RESPONSE_MODEL]: outcome.responseModel }
            : {}),
          ...(outcome.finishReasons !== undefined
            ? { [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: outcome.finishReasons }
            : {}),
        });

        const cost = estimateCostUsd(
          ctx.providerName,
          ctx.requestModel,
          outcome.inputTokens,
          outcome.outputTokens,
        );
        if (cost.priced) {
          span.setAttribute(ATTR_FUSE_ESTIMATED_COST_USD, cost.costUsd);
          getEstimatedCostCounter().add(cost.costUsd, {
            [ATTR_FUSE_TENANT]: ctx.tenant,
            [ATTR_FUSE_ENVIRONMENT]: ctx.environment,
            [ATTR_FUSE_AGENT_ID]: ctx.agentId,
            [ATTR_GEN_AI_PROVIDER_NAME]: ctx.providerName,
            [ATTR_GEN_AI_REQUEST_MODEL]: ctx.requestModel,
          });
        }

        const metricAttributes = {
          [ATTR_GEN_AI_OPERATION_NAME]: ctx.operationName,
          [ATTR_GEN_AI_PROVIDER_NAME]: ctx.providerName,
          [ATTR_GEN_AI_REQUEST_MODEL]: ctx.requestModel,
        };
        getTokenUsageHistogram().record(outcome.inputTokens, {
          ...metricAttributes,
          [ATTR_GEN_AI_TOKEN_TYPE]: 'input',
        });
        getTokenUsageHistogram().record(outcome.outputTokens, {
          ...metricAttributes,
          [ATTR_GEN_AI_TOKEN_TYPE]: 'output',
        });
        getOperationDurationHistogram().record(durationSeconds, metricAttributes);

        if (outcome.canonicalShape !== undefined && outcome.outcome === 'success') {
          ctx.onStepObserved?.({
            timestampMs: observedAtMs,
            canonicalShape: outcome.canonicalShape,
            inputTokens: outcome.inputTokens,
            outputTokens: outcome.outputTokens,
            estimatedCostUsd: cost.priced ? cost.costUsd : 0,
          });
        }

        if (outcome.outcome === 'error') {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        const durationMs = performance.now() - startMillis;
        ctx.onTelemetryObserved?.({
          timestampMs: observedAtMs,
          hasRequestModel: ctx.requestModel.length > 0,
          hasInputTokens:
            typeof observedOutcome?.inputTokens === 'number' &&
            Number.isFinite(observedOutcome.inputTokens),
          hasOutputTokens:
            typeof observedOutcome?.outputTokens === 'number' &&
            Number.isFinite(observedOutcome.outputTokens),
          hasScopedIdentity:
            ctx.tenant.length > 0 && ctx.environment.length > 0 && ctx.agentId.length > 0,
          hasValidTimestamps: Number.isFinite(durationMs) && durationMs >= 0,
          isRootSpan: !hasParent,
          hasParent,
        });
        span.end();
      }
    },
  );
}
