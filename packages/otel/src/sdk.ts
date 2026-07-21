import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
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
}

export interface FuseOtelHandle {
  sdk: NodeSDK;
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

  const traceExporter = new OTLPTraceExporter(
    exporterConfig(options.otlpEndpoint, '/v1/traces', options.otlpHeaders),
  );
  const metricExporter = new OTLPMetricExporter(
    exporterConfig(options.otlpEndpoint, '/v1/metrics', options.otlpHeaders),
  );
  const logExporter = new OTLPLogExporter(
    exporterConfig(options.otlpEndpoint, '/v1/logs', options.otlpHeaders),
  );

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: options.metricExportIntervalMillis ?? 15_000,
      }),
    ],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: logExporter })],
  });
  sdk.start();

  return {
    sdk,
    shutdown: () => sdk.shutdown(),
  };
}
