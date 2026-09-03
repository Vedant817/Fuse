# `@fuse/otel`

Fuse's Node.js OpenTelemetry instrumentation: `gen_ai` spans, bounded metrics,
resource attributes, illustrative cost estimation, and an OTLP traces/metrics/
logs runtime.

```ts
import { bootstrapOtel, withGenAiSpan } from '@fuse/otel';

const otel = bootstrapOtel({
  serviceName: 'support-agent',
  serviceVersion: '1.0.0',
  deploymentEnvironment: 'production',
});

try {
  await withGenAiSpan(/* operation metadata and callback */);
} finally {
  await otel.shutdown();
}
```

Configure export with the standard `OTEL_EXPORTER_OTLP_*` environment
variables or the explicit `otlpEndpoint` option. Always call `shutdown()` so
buffered signals are flushed. The upstream `gen_ai` semantic conventions used
by Fuse are incubating and may evolve.

Agents using `FuseGuard` should normally bootstrap through `@fuse/sdk/otel`.
That subpath wraps this runtime, routes successful or failed real trace-export
callbacks to the matching guard, and drains exporter evidence before shutdown.
Exporter evidence requires the guard's separate `exporterEvidenceToken`; it is
not inferred from span creation and never falls back to the ordinary agent token.

This package is ESM-only and requires Node.js 24 or newer. It is licensed under
Apache-2.0.
