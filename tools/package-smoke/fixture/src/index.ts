import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ObserveStepsRequestSchema,
  PreflightExporterEvidenceRequestSchema,
  ScopeSchema,
  StepObservationSchema,
  type StepObservationInputWire,
} from '@fuse/contracts';
import {
  BreakerTrippedError,
  FuseGuard,
  type FuseGuardOptions,
  type RunStepOptions,
} from '@fuse/sdk';
import { bootstrapFuseOtel, type FuseOtelRuntimeOptions } from '@fuse/sdk/otel';
import {
  OpenAiCompatibleProvider,
  type OpenAiCompatibleProviderOptions,
} from '@fuse/sdk/providers';
import { estimateCostUsd, type CostEstimate } from '@fuse/otel';

const AGENT_TOKEN = 'fixture-agent-token-not-a-credential';
const EXPORTER_TOKEN = 'fixture-exporter-token-not-a-credential';
const EXECUTION_ID = 'external-consumer-execution';
const MODEL = 'llama-3.1-8b-instant';
const scope = ScopeSchema.parse({
  tenant: 'external-consumer',
  environment: 'smoke',
  agentId: 'minimal-agent',
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function verifyPublicObservationDeclarations(): void {
  const valid: StepObservationInputWire = {
    executionId: EXECUTION_ID,
    timestampMs: 1,
    canonicalShape: 'shape',
    inputTokens: 1,
    outputTokens: 1,
    pricingStatus: 'available',
    estimatedCostUsd: 0.001,
  };
  void valid;

  // @ts-expect-error Public declarations require executionId.
  const missingExecution: StepObservationInputWire = {
    timestampMs: 1,
    canonicalShape: 'shape',
    inputTokens: 1,
    outputTokens: 1,
    pricingStatus: 'available',
    estimatedCostUsd: 0.001,
  };
  // @ts-expect-error Public declarations require explicit pricingStatus.
  const missingPricing: StepObservationInputWire = {
    executionId: EXECUTION_ID,
    timestampMs: 1,
    canonicalShape: 'shape',
    inputTokens: 1,
    outputTokens: 1,
    estimatedCostUsd: 0.001,
  };
  void missingExecution;
  void missingPricing;
}

verifyPublicObservationDeclarations();

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function json(response: import('node:http').ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function listeningServer(
  handler: (request: IncomingMessage, body: Buffer) => Promise<unknown>,
): Server {
  return createServer((request, response) => {
    void readBody(request)
      .then((body) => handler(request, body))
      .then((value) => json(response, value))
      .catch((error: unknown) => {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(error instanceof Error ? error.message : String(error));
      });
  });
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

let tripped = false;
let permitChecks = 0;
let detectorAcknowledgements = 0;
let exporterEvidenceReports = 0;
let structuralPreflightReports = 0;
let traceExports = 0;
let traceContainedFuseSpan = false;

const controlPlane = listeningServer(async (request, body) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const authorization = request.headers.authorization;
  if (path === '/v1/permit') {
    assert(authorization === `Bearer ${AGENT_TOKEN}`, 'permit used the wrong token');
    permitChecks += 1;
    return {
      allowed: !tripped,
      state: tripped ? 'tripped' : 'armed',
      reason: tripped ? 'package smoke detector fired' : 'package smoke permit',
      epoch: tripped ? 1 : 0,
      degraded: false,
      correlationId: `package-smoke-permit-${permitChecks}`,
    };
  }
  if (path === '/v1/detectors/observe') {
    assert(authorization === `Bearer ${AGENT_TOKEN}`, 'detector report used wrong token');
    const report = ObserveStepsRequestSchema.parse(JSON.parse(body.toString('utf8')));
    assert(report.steps.length === 1, 'runStep did not report exactly one observation');
    const step = report.steps[0]!;
    assert(step.executionId === EXECUTION_ID, 'detector observation lost executionId');
    assert(step.pricingStatus === 'available', 'detector observation lost pricingStatus');
    assert(step.estimatedCostUsd > 0, 'detector observation did not contain priced cost');
    tripped = true;
    detectorAcknowledgements += 1;
    const observedAt = new Date(step.timestampMs).toISOString();
    return {
      results: [
        {
          detector: 'loop-signature',
          detectorVersion: 'package-smoke-v1',
          scope,
          fired: true,
          score: 1,
          threshold: 1,
          windowStart: observedAt,
          windowEnd: observedAt,
          evidence: ['packed SDK reported an execution-scoped step'],
          dedupeKey: 'package-smoke-loop-signature',
        },
      ],
      enforcement: [{ detector: 'loop-signature', outcome: 'tripped' }],
    };
  }
  if (path === '/v1/preflight/exporter-evidence') {
    assert(
      authorization === `Bearer ${EXPORTER_TOKEN}`,
      'exporter evidence did not use exporterEvidenceToken',
    );
    const report = PreflightExporterEvidenceRequestSchema.parse(
      JSON.parse(body.toString('utf8')),
    );
    assert(
      report.exporterDelivery.status === 'success',
      'OTLP export was not successful',
    );
    assert(report.spans.length > 0, 'exporter evidence did not include a span sample');
    exporterEvidenceReports += 1;
    return { accepted: true };
  }
  if (path === '/v1/preflight/report') {
    assert(
      authorization === `Bearer ${AGENT_TOKEN}`,
      'structural Preflight report used the wrong token',
    );
    structuralPreflightReports += 1;
    return { accepted: true };
  }
  throw new Error(`unexpected fake control-plane route ${path}`);
});

const otlpReceiver = listeningServer(async (request, body) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const contentType = request.headers['content-type'];
  assert(
    contentType?.startsWith('application/x-protobuf') ||
      contentType?.startsWith('application/json'),
    `OTLP request ${path} used unsupported content type ${String(contentType)}`,
  );
  assert(body.length > 0, `OTLP request ${path} had an empty body`);
  if (path === '/v1/traces') {
    traceExports += 1;
    traceContainedFuseSpan ||= body.includes(Buffer.from(`chat ${MODEL}`));
  } else {
    assert(
      path === '/v1/metrics' || path === '/v1/logs',
      `unexpected OTLP route ${path}`,
    );
  }
  return {};
});

let runtime: ReturnType<typeof bootstrapFuseOtel> | undefined;
try {
  const [controlPlaneUrl, otlpEndpoint] = await Promise.all([
    listen(controlPlane),
    listen(otlpReceiver),
  ]);

  const guardOptions = {
    scope,
    controlPlaneUrl,
    apiToken: AGENT_TOKEN,
    exporterEvidenceToken: EXPORTER_TOKEN,
    outageMode: 'fail-closed',
  } satisfies FuseGuardOptions;
  const guard = new FuseGuard(guardOptions);
  const otelOptions = {
    serviceName: 'fuse-external-consumer-smoke',
    serviceVersion: '0.0.0',
    deploymentEnvironment: 'test',
    otlpEndpoint,
  } satisfies FuseOtelRuntimeOptions;
  runtime = bootstrapFuseOtel(otelOptions);
  runtime.registerGuard(guard);

  const providerOptions = {
    baseUrl: controlPlaneUrl,
    apiKey: 'unused-provider-token',
  } satisfies OpenAiCompatibleProviderOptions;
  const providerDeclaration = new OpenAiCompatibleProvider(providerOptions);
  assert(
    providerDeclaration instanceof OpenAiCompatibleProvider,
    '@fuse/sdk/providers did not load',
  );
  const estimate: CostEstimate = estimateCostUsd('groq', MODEL, 200, 50);
  assert(estimate.priced, '@fuse/otel pricing export did not load');

  assert(
    !StepObservationSchema.safeParse({
      timestampMs: 1,
      canonicalShape: 'legacy-shape',
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: 0,
    }).success,
    'packed contracts accepted a legacy detector observation',
  );

  let providerCallbacks = 0;
  const firstStep = {
    executionId: EXECUTION_ID,
    providerName: 'groq',
    requestModel: MODEL,
    kind: 'package-smoke',
    stepIndex: 0,
    dispatch: async () => {
      providerCallbacks += 1;
      return { text: 'repeat this bounded package smoke shape' };
    },
    observe: (result: { text: string }) => ({
      text: result.text,
      inputTokens: 200,
      outputTokens: 50,
      structure: ['package-smoke'],
    }),
  } satisfies RunStepOptions<{ text: string }>;
  const first = await guard.runStep(firstStep);
  assert(first.text.length > 0, 'first packed runStep result was empty');
  assert(detectorAcknowledgements === 1, 'firing detector was not acknowledged');
  assert(providerCallbacks === 1, 'first provider callback count was not one');

  let denied: unknown;
  try {
    await guard.runStep({
      ...firstStep,
      stepIndex: 1,
      dispatch: async () => {
        providerCallbacks += 1;
        return { text: 'must not execute' };
      },
    });
  } catch (error) {
    denied = error;
  }
  assert(denied instanceof BreakerTrippedError, 'next runStep was not breaker-denied');
  assert(
    providerCallbacks === 1,
    'next provider callback was invoked after detector trip',
  );
  assert(permitChecks === 2, 'runStep did not perform a fresh permit check per call');

  await runtime.forceFlush();
  assert(traceExports > 0, 'packed @fuse/sdk/otel did not export a trace');
  assert(traceContainedFuseSpan, 'OTLP receiver did not observe the real gen_ai span');
  assert(
    exporterEvidenceReports > 0,
    'exporter evidence endpoint was not called after OTLP success',
  );
  assert(
    structuralPreflightReports > 0,
    'default structural Preflight reporting did not run',
  );
  await guard.endExecution(EXECUTION_ID);
} finally {
  await runtime?.shutdown();
  await Promise.all([close(controlPlane), close(otlpReceiver)]);
}

console.log(
  'Packed declarations, runStep detector enforcement, OTLP trace export, and exporter evidence passed.',
);
