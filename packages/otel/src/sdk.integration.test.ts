import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { context, metrics, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapOtel, type FuseOtelHandle } from './sdk.js';
import { getTokenUsageHistogram } from './metrics.js';

interface CapturedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  bodyBytes: number;
}

async function startCapturingServer(): Promise<{
  url: string;
  requests: CapturedRequest[];
  setStatus: (status: number) => void;
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  let responseStatus = 200;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({
        path: req.url ?? '',
        headers: req.headers,
        bodyBytes: Buffer.byteLength(body),
      });
      res.writeHead(responseStatus, { 'content-type': 'application/x-protobuf' });
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('mock receiver failed to bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setStatus: (status) => {
      responseStatus = status;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/**
 * Proves real network delivery: a real HTTP server (not a mock function)
 * receives non-empty OTLP export requests at the expected signal-specific
 * paths, with the configured header attached. Attribute-level correctness
 * is covered by gen-ai-span.test.ts's in-memory exporter assertions —
 * this test is specifically the "does telemetry actually leave the
 * process over the wire" proof, kept lightweight (no Docker/SigNoz
 * required) so it runs in every workspace test pass. Real end-to-end
 * ingestion against an actual self-hosted SigNoz backend (ADR-005) is
 * verified separately, ClickHouse-query-confirmed — see
 * docs/adr/005-self-hosted-signoz.md and task.md §3.3.
 */
describe('bootstrapOtel: real OTLP HTTP delivery to a local receiver', () => {
  let receiver: Awaited<ReturnType<typeof startCapturingServer>>;
  let handle: FuseOtelHandle | undefined;

  beforeEach(async () => {
    receiver = await startCapturingServer();
  });

  afterEach(async () => {
    if (handle) {
      await handle.shutdown();
      handle = undefined;
    }
    await receiver.close();
    // NodeSDK.start() registers global tracer/meter providers that
    // .shutdown() does not unregister; without this, the next test's
    // fresh bootstrapOtel() registration is silently ignored and its
    // telemetry routes to the previous (already-shutdown) providers.
    trace.disable();
    metrics.disable();
    context.disable();
  });

  it('exports a real span to /v1/traces with a non-empty body and the configured header', async () => {
    const exportResults: Array<{
      exporterDelivery: { status: string };
      spans: Array<{ hasInputTokens: boolean; hasOutputTokens: boolean }>;
    }> = [];
    handle = bootstrapOtel({
      serviceName: 'fuse-otel-test',
      serviceVersion: '0.0.0-test',
      deploymentEnvironment: 'test',
      otlpEndpoint: receiver.url,
      otlpHeaders: { 'x-fuse-test': 'yes' },
      metricExportIntervalMillis: 100_000, // don't let a metrics tick interleave with this test
      traceExportMaxSpansPerScope: 2,
      onTraceExportResult: (result) => {
        exportResults.push(result);
      },
    });

    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('test-span');
    span.setAttributes({
      'fuse.tenant': 't1',
      'fuse.environment': 'test',
      'fuse.agent_id': 'agent-1',
      'gen_ai.request.model': 'test-model',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 2,
    });
    span.end();
    for (let index = 0; index < 2; index++) {
      const extra = tracer.startSpan(`test-span-${index}`);
      extra.setAttributes({
        'fuse.tenant': 't1',
        'fuse.environment': 'test',
        'fuse.agent_id': 'agent-1',
        'gen_ai.request.model': 'test-model',
        'gen_ai.usage.input_tokens': 10,
        'gen_ai.usage.output_tokens': 2,
      });
      extra.end();
    }
    await handle.shutdown(); // flush + close before inspecting captured requests
    handle = undefined;

    const traceRequests = receiver.requests.filter((r) => r.path === '/v1/traces');
    expect(traceRequests.length).toBeGreaterThan(0);
    expect(traceRequests[0]!.bodyBytes).toBeGreaterThan(0);
    expect(traceRequests[0]!.headers['x-fuse-test']).toBe('yes');
    expect(exportResults).toHaveLength(1);
    expect(exportResults[0]!.exporterDelivery.status).toBe('success');
    expect(exportResults[0]!.exporterDelivery).toMatchObject({
      sourceInstanceId: expect.any(String),
      sequence: 1,
    });
    expect(exportResults[0]!.spans).toHaveLength(2);
    expect(exportResults[0]!.spans[0]).toMatchObject({
      hasInputTokens: true,
      hasOutputTokens: true,
    });
  });

  it('reports a scoped exporter failure and never turns it into successful delivery evidence', async () => {
    // 400 is deliberately non-retryable so this test exercises the failure
    // callback without waiting through the exporter's production retry budget.
    receiver.setStatus(400);
    const exportResults: Array<{ exporterDelivery: { status: string } }> = [];
    handle = bootstrapOtel({
      serviceName: 'fuse-otel-test',
      serviceVersion: '0.0.0-test',
      deploymentEnvironment: 'test',
      otlpEndpoint: receiver.url,
      metricExportIntervalMillis: 100_000,
      onTraceExportResult: (result) => {
        exportResults.push(result);
      },
    });
    const span = trace.getTracer('test').startSpan('failed-export');
    span.setAttributes({
      'fuse.tenant': 't1',
      'fuse.environment': 'test',
      'fuse.agent_id': 'agent-1',
      'gen_ai.request.model': 'test-model',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 2,
    });
    span.end();

    await handle.shutdown().catch(() => {});
    handle = undefined;

    expect(exportResults).toHaveLength(1);
    expect(exportResults[0]!.exporterDelivery.status).toBe('failure');
  });

  it('drains an asynchronous failure observer before forceFlush preserves the batch error', async () => {
    receiver.setStatus(400);
    let observerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      observerStarted = resolve;
    });
    let releaseObserver!: () => void;
    const observerBarrier = new Promise<void>((resolve) => {
      releaseObserver = resolve;
    });
    let observedStatus: string | undefined;
    handle = bootstrapOtel({
      serviceName: 'fuse-otel-test',
      serviceVersion: '0.0.0-test',
      deploymentEnvironment: 'test',
      otlpEndpoint: receiver.url,
      metricExportIntervalMillis: 100_000,
      onTraceExportResult: async (result) => {
        observedStatus = result.exporterDelivery.status;
        observerStarted();
        await observerBarrier;
      },
    });
    const span = trace.getTracer('test').startSpan('failed-export-with-slow-observer');
    span.setAttributes({
      'fuse.tenant': 't1',
      'fuse.environment': 'test',
      'fuse.agent_id': 'agent-1',
    });
    span.end();

    let settled = false;
    let flushError: unknown;
    const flush = handle
      .forceFlush()
      .catch((error: unknown) => {
        flushError = error;
      })
      .finally(() => {
        settled = true;
      });
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeObserver = settled;
    releaseObserver();
    await flush;

    expect(observedStatus).toBe('failure');
    expect(settledBeforeObserver).toBe(false);
    expect(flushError).toBeInstanceOf(Error);
    receiver.setStatus(200);
  });

  it('exports metrics to /v1/metrics with a non-empty body', async () => {
    handle = bootstrapOtel({
      serviceName: 'fuse-otel-test',
      serviceVersion: '0.0.0-test',
      deploymentEnvironment: 'test',
      otlpEndpoint: receiver.url,
      otlpHeaders: { 'x-fuse-test': 'yes' },
      metricExportIntervalMillis: 100_000,
    });
    getTokenUsageHistogram().record(42, {
      'gen_ai.request.model': 'test-model',
      'gen_ai.token.type': 'input',
    });
    await handle.shutdown(); // shutdown forces a final metrics flush
    handle = undefined;

    const metricRequests = receiver.requests.filter((r) => r.path === '/v1/metrics');
    expect(metricRequests.length).toBeGreaterThan(0);
    expect(metricRequests[0]!.bodyBytes).toBeGreaterThan(0);
  });
});
