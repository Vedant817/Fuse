import { SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
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
import { getOperationDurationHistogram, getTokenUsageHistogram } from './metrics.js';
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
}

export interface GenAiSpanOutcome {
  responseModel?: string;
  inputTokens: number;
  outputTokens: number;
  finishReasons?: string[];
  outcome: 'success' | 'denied' | 'error';
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
  return tracer.startActiveSpan(
    `${ctx.operationName} ${ctx.requestModel}`,
    { kind: SpanKind.CLIENT },
    async (span) => {
      const startMillis = performance.now();
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

        if (outcome.outcome === 'error') {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
