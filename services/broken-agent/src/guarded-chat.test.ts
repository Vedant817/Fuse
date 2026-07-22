import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { FuseGuard } from '@fuse/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGuardedInstrumentedChat } from './guarded-chat.js';

describe('runGuardedInstrumentedChat', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    context.setGlobalContextManager(new AsyncHooksContextManager().enable());
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    context.disable();
    trace.disable();
  });

  it('checks a permit, emits a provider span, and reports its telemetry', async () => {
    const permitFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          allowed: true,
          state: 'armed',
          reason: 'armed',
          epoch: 0,
          degraded: false,
          correlationId: 'real-call-1',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const guard = new FuseGuard({
      scope: { tenant: 't1', environment: 'test', agentId: 'real-agent' },
      controlPlaneUrl: 'http://cp.internal',
      apiToken: 'token',
      fetchImpl: permitFetch,
      reportPreflightTelemetry: false,
    });
    const recordTelemetry = vi.spyOn(guard, 'recordSpanTelemetry');
    const dispatch = vi.fn().mockResolvedValue({
      id: 'completion-1',
      model: 'llama-3.1-8b-instant',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'pong' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    });

    await runGuardedInstrumentedChat({
      guard,
      providerName: 'groq',
      requestModel: 'llama-3.1-8b-instant',
      correlationId: 'real-call-1',
      sessionId: 'session-1',
      dispatch,
    });
    await provider.forceFlush();

    expect(permitFetch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(recordTelemetry).toHaveBeenCalledOnce();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('chat llama-3.1-8b-instant');
    expect(spans[0]!.attributes).toMatchObject({
      'gen_ai.provider.name': 'groq',
      'gen_ai.request.model': 'llama-3.1-8b-instant',
      'gen_ai.usage.input_tokens': 11,
      'gen_ai.usage.output_tokens': 3,
      'fuse.tenant': 't1',
      'fuse.agent_id': 'real-agent',
    });
  });
});
