import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { FuseGuard } from '@fuse/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalyzerVerifier } from './analyzer-verifier.js';

function allowingGuard(): FuseGuard {
  const fetchImpl = vi.fn().mockImplementation(
    () =>
      new Response(
        JSON.stringify({
          allowed: true,
          state: 'armed',
          reason: 'armed',
          epoch: 0,
          degraded: false,
          correlationId: 'c1',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  return new FuseGuard({
    scope: { tenant: 't1', environment: 'test', agentId: 'broken-agent' },
    controlPlaneUrl: 'http://cp.internal',
    apiToken: 'tok',
    fetchImpl,
  });
}

describe('runAnalyzerVerifier OTel span tree', () => {
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

  it('emits one root invoke_agent span and one chat child span per round, all in the same trace with no orphans', async () => {
    const result = await runAnalyzerVerifier({
      scenario: 'normal',
      seed: 1,
      guard: allowingGuard(),
    });
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name.startsWith('invoke_agent'));
    const rounds = spans.filter((s) => s.name.startsWith('chat'));

    expect(root).toBeDefined();
    expect(rounds).toHaveLength(result.totalCalls);

    const traceId = root!.spanContext().traceId;
    for (const roundSpan of rounds) {
      expect(roundSpan.spanContext().traceId).toBe(traceId); // same trace
      expect(roundSpan.parentSpanContext?.spanId).toBe(root!.spanContext().spanId); // no orphans
    }
    // Every span produced by this run is accounted for as either the root
    // or a properly-parented round — nothing floats free.
    expect(spans).toHaveLength(1 + rounds.length);
  });

  it('the root span still ends and is recorded even when the run stops via breaker-tripped', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            allowed: true,
            state: 'armed',
            reason: 'armed',
            epoch: 0,
            degraded: false,
            correlationId: 'c1',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            allowed: false,
            state: 'tripped',
            reason: 'loop',
            epoch: 1,
            degraded: false,
            correlationId: 'c2',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const guard = new FuseGuard({
      scope: { tenant: 't1', environment: 'test', agentId: 'broken-agent' },
      controlPlaneUrl: 'http://cp.internal',
      apiToken: 'tok',
      fetchImpl,
    });

    await runAnalyzerVerifier({ scenario: 'loop', seed: 1, guard, maxCalls: 20 });
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name.startsWith('invoke_agent'));
    expect(root).toBeDefined();
    expect(root!.attributes['fuse.outcome']).toBe('denied');
    // Exactly one chat span (the allowed first call) — the denied second
    // permit check never reached the point of starting a gen_ai span.
    expect(spans.filter((s) => s.name.startsWith('chat'))).toHaveLength(1);
  });
});
