import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  ExporterHealthSpanExporter,
  type ScopeTraceExportResult,
  type TraceExportResultObserver,
} from './exporter-health.js';
import { buildFuseResource, type FuseResourceOptions } from './resource.js';

export interface BootstrapOtelOptions extends FuseResourceOptions {
  /**
   * Explicit OTLP base endpoint (e.g. the self-hosted SigNoz collector at
   * `http://localhost:4318`, per ADR-005/`infra/signoz-up.sh`, or any other
   * OTLP-compatible endpoint) — signal-specific paths (`/v1/traces`,
   * `/v1/metrics`, `/v1/logs`) are appended automatically. Omit to fall
   * back to the standard `OTEL_EXPORTER_OTLP_*` environment variables,
   * which is the production default and works identically regardless of
   * which OTLP-compatible backend they point at.
   */
  otlpEndpoint?: string;
  otlpHeaders?: Record<string, string>;
  metricExportIntervalMillis?: number;
  /** Receives bounded, per-scope structural evidence after the real OTLP
   * trace exporter reports success or failure. Route this to the matching
   * FuseGuard's `recordTraceExportResult` method. */
  onTraceExportResult?: TraceExportResultObserver;
  traceExportMaxSpansPerScope?: number;
  /** Override only for deterministic low-level tests; production instances
   * must use the generated per-bootstrap identity so sequence reset is safe. */
  traceExportSourceInstanceId?: string;
}

export interface FuseOtelHandle {
  sdk: NodeSDK;
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
}

function exporterConfig(
  otlpEndpoint: string | undefined,
  path: string,
  headers: Record<string, string> | undefined,
) {
  if (!otlpEndpoint) return headers ? { headers } : {};
  return {
    url: `${otlpEndpoint.replace(/\/+$/, '')}${path}`,
    ...(headers ? { headers } : {}),
  };
}

/**
 * Starts the OTel SDK (traces + metrics + logs) with Fuse's resource
 * attributes. Returns a handle whose `shutdown()` MUST be called before
 * process exit so buffered telemetry is flushed rather than dropped.
 */
export function bootstrapOtel(options: BootstrapOtelOptions): FuseOtelHandle {
  const resource = buildFuseResource(options);

  const otlpTraceExporter = new OTLPTraceExporter(
    exporterConfig(options.otlpEndpoint, '/v1/traces', options.otlpHeaders),
  );
  const traceExporter = options.onTraceExportResult
    ? new ExporterHealthSpanExporter(
        otlpTraceExporter,
        options.onTraceExportResult,
        options.traceExportMaxSpansPerScope,
        Date.now,
        options.traceExportSourceInstanceId,
      )
    : otlpTraceExporter;
  const metricExporter = new OTLPMetricExporter(
    exporterConfig(options.otlpEndpoint, '/v1/metrics', options.otlpHeaders),
  );
  const logExporter = new OTLPLogExporter(
    exporterConfig(options.otlpEndpoint, '/v1/logs', options.otlpHeaders),
  );
  const spanProcessor = new BatchSpanProcessor(traceExporter);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: options.metricExportIntervalMillis ?? 15_000,
  });
  const logProcessor = new BatchLogRecordProcessor({ exporter: logExporter });

  const sdk = new NodeSDK({
    resource,
    spanProcessors: [spanProcessor],
    metricReaders: [metricReader],
    logRecordProcessors: [logProcessor],
  });
  sdk.start();

  return {
    sdk,
    forceFlush: async () => {
      const traceFlush = async (): Promise<void> => {
        const processorResult = await Promise.allSettled([spanProcessor.forceFlush()]);
        const exporterResult = await Promise.allSettled([
          traceExporter.forceFlush?.() ?? Promise.resolve(),
        ]);
        const failure = [...processorResult, ...exporterResult].find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failure) throw failure.reason;
      };
      const results = await Promise.allSettled([
        traceFlush(),
        metricReader.forceFlush(),
        logProcessor.forceFlush(),
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failure) throw failure.reason;
    },
    shutdown: () => sdk.shutdown(),
  };
}

export type { ScopeTraceExportResult };
