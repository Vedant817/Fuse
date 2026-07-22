import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
} from '@opentelemetry/semantic-conventions/incubating';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATTR_FUSE_AGENT_ID,
  ATTR_FUSE_OUTCOME,
  ATTR_FUSE_STEP_INDEX,
} from './attributes.js';
import {
  withGenAiSpan,
  type GenAiSpanContext,
  type SpanTelemetryObservation,
} from './gen-ai-span.js';

const BASE_CTX: Omit<GenAiSpanContext, 'stepIndex'> = {
  operationName: 'chat',
  providerName: 'groq',
  requestModel: 'llama-3.1-8b-instant',
  tenant: 't1',
  environment: 'test',
  agentId: 'agent-1',
  sessionId: 'session-1',
  correlationId: 'corr-1',
};

describe('withGenAiSpan', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const contextManager = new AsyncHooksContextManager().enable();
    context.setGlobalContextManager(contextManager);
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    context.disable();
    trace.disable();
  });

  it('emits a CLIENT span named "{operation} {model}" with gen_ai.* and fuse.* attributes', async () => {
    await withGenAiSpan({ ...BASE_CTX, stepIndex: 0 }, async () => ({
      result: 'ok',
      outcome: {
        inputTokens: 100,
        outputTokens: 20,
        responseModel: 'llama-3.1-8b-instant-20260101',
        outcome: 'success',
      },
    }));
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe('chat llama-3.1-8b-instant');
    expect(span.attributes[ATTR_GEN_AI_OPERATION_NAME]).toBe('chat');
    expect(span.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe('groq');
    expect(span.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe('llama-3.1-8b-instant');
    expect(span.attributes[ATTR_GEN_AI_RESPONSE_MODEL]).toBe(
      'llama-3.1-8b-instant-20260101',
    );
    expect(span.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(100);
    expect(span.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(20);
    expect(span.attributes[ATTR_FUSE_AGENT_ID]).toBe('agent-1');
    expect(span.attributes[ATTR_FUSE_STEP_INDEX]).toBe(0);
    expect(span.attributes[ATTR_FUSE_OUTCOME]).toBe('success');
  });

  it('records estimated cost only when a matching entry has real per-token pricing', async () => {
    await withGenAiSpan({ ...BASE_CTX, stepIndex: 0 }, async () => ({
      result: 'ok',
      outcome: { inputTokens: 1_000_000, outputTokens: 1_000_000, outcome: 'success' },
    }));
    await withGenAiSpan(
      { ...BASE_CTX, stepIndex: 1, requestModel: 'some-unpriced-model' },
      async () => ({
        result: 'ok',
        outcome: { inputTokens: 100, outputTokens: 100, outcome: 'success' },
      }),
    );
    await withGenAiSpan(
      {
        ...BASE_CTX,
        stepIndex: 2,
        providerName: 'nvidia',
        requestModel: 'meta/llama-3.1-8b-instruct',
      },
      async () => ({
        result: 'ok',
        outcome: {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          outcome: 'success',
        },
      }),
    );
    await provider.forceFlush();

    const [priced, unknownModel, noPublishedPrice] = exporter.getFinishedSpans();
    expect(priced!.attributes['fuse.estimated_cost.usd']).toBeCloseTo(0.05 + 0.08, 5);
    expect(unknownModel!.attributes['fuse.estimated_cost.usd']).toBeUndefined();
    expect(noPublishedPrice!.attributes['fuse.estimated_cost.usd']).toBeUndefined();
  });

  it('nested spans (a second withGenAiSpan called inside the first) become a child, not an orphan', async () => {
    await withGenAiSpan({ ...BASE_CTX, stepIndex: 0 }, async (parentSpan) => {
      await withGenAiSpan({ ...BASE_CTX, stepIndex: 1 }, async (childSpan) => {
        expect(childSpan.spanContext().traceId).toBe(parentSpan.spanContext().traceId);
        return {
          result: 'inner',
          outcome: { inputTokens: 1, outputTokens: 1, outcome: 'success' },
        };
      });
      return {
        result: 'outer',
        outcome: { inputTokens: 1, outputTokens: 1, outcome: 'success' },
      };
    });
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const child = spans.find((s) => s.attributes[ATTR_FUSE_STEP_INDEX] === 1)!;
    const parent = spans.find((s) => s.attributes[ATTR_FUSE_STEP_INDEX] === 0)!;
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
  });

  it('records an exception and sets ERROR status when fn throws, and still ends the span', async () => {
    await expect(
      withGenAiSpan({ ...BASE_CTX, stepIndex: 0 }, async () => {
        throw new Error('provider exploded');
      }),
    ).rejects.toThrow('provider exploded');
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(spans[0]!.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('reports a healthy root-span telemetry observation on success', async () => {
    const observations: SpanTelemetryObservation[] = [];
    await withGenAiSpan(
      {
        ...BASE_CTX,
        stepIndex: -1,
        onTelemetryObserved: (obs) => observations.push(obs),
      },
      async () => ({
        result: 'ok',
        outcome: { inputTokens: 10, outputTokens: 5, outcome: 'success' },
      }),
    );
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      hasRequestModel: true,
      hasInputTokens: true,
      hasOutputTokens: true,
      hasScopedIdentity: true,
      hasValidTimestamps: true,
      isRootSpan: true,
      hasParent: false,
    });
    expect(observations[0]!.timestampMs).toBeGreaterThan(0);
  });

  it('reports hasParent/isRootSpan correctly for a nested (child) span', async () => {
    const observations: SpanTelemetryObservation[] = [];
    await withGenAiSpan(
      {
        ...BASE_CTX,
        stepIndex: -1,
        onTelemetryObserved: (obs) => observations.push(obs),
      },
      async () => {
        await withGenAiSpan(
          {
            ...BASE_CTX,
            stepIndex: 0,
            onTelemetryObserved: (obs) => observations.push(obs),
          },
          async () => ({
            result: 'inner',
            outcome: { inputTokens: 1, outputTokens: 1, outcome: 'success' },
          }),
        );
        return {
          result: 'outer',
          outcome: { inputTokens: 1, outputTokens: 1, outcome: 'success' },
        };
      },
    );
    expect(observations).toHaveLength(2);
    const [child, parent] = observations;
    expect(child).toMatchObject({ isRootSpan: false, hasParent: true });
    expect(parent).toMatchObject({ isRootSpan: true, hasParent: false });
  });

  it('reports missing token-count observations (not a thrown error) when fn throws', async () => {
    const observations: SpanTelemetryObservation[] = [];
    await expect(
      withGenAiSpan(
        {
          ...BASE_CTX,
          stepIndex: 0,
          onTelemetryObserved: (obs) => observations.push(obs),
        },
        async () => {
          throw new Error('provider exploded');
        },
      ),
    ).rejects.toThrow('provider exploded');
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      hasInputTokens: false,
      hasOutputTokens: false,
      hasRequestModel: true,
    });
  });
});
