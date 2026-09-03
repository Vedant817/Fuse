# Fuse SDK API

## Public entry points

- `@fuse/sdk`: `FuseGuard`, `BreakerTrippedError`, `PreflightReporter`,
  `StepObservationReporter`, and `StepShapeCanonicalizer`.
- `@fuse/sdk/otel`: `bootstrapFuseOtel` and `FuseOtelRuntime`.
- `@fuse/sdk/providers`: the optional OpenAI-compatible client plus Groq and
  NVIDIA Build factories.

Testing helpers, deterministic demo triggers, provider mocks, tests, and live
test fixtures are intentionally not part of the published package.

## `FuseGuard`

`new FuseGuard(options)` binds one guard to one tenant/environment/agent scope.
`guard(dispatch, correlationId?)` performs a fresh control-plane permit check
and invokes `dispatch` only when allowed. Its default SDK outage policy is
fail-closed. A call already dispatched before a breaker trip cannot be
cancelled by Fuse.

`recordSpanTelemetry` uses the ordinary `apiToken` for structural observations.
`recordTraceExportResult` uses the separate `exporterEvidenceToken` and exporter-
only route. It never falls back to `apiToken`; without the exporter credential,
the callback contributes structural samples only and cannot establish
`protected`.
`recordStepObservation` feeds detector evaluation. Its public observation
requires a bounded `executionId` and an explicit pricing discriminant:
`pricingStatus: 'available'` requires a numeric `estimatedCostUsd`, while
`pricingStatus: 'unavailable'` requires `estimatedCostUsd: null`. Missing fields
are rejected; there is no legacy unscoped payload. Drain the corresponding
reporters during graceful shutdown when not using `FuseOtelRuntime`.

`runStep(options)` is the supported high-level direct-detection integration. It
performs a fresh permit check, invokes `dispatch`, emits the `gen_ai` span,
canonicalizes `observe(result).text` locally, and synchronously reports the
completed observation. `executionId` is required, bounded to 128 safe
characters, and scopes all three detector windows. Concurrent execution IDs
never share history.

`getDetectorProtection(executionId)` reports each detector independently.
Unknown/unpriced models degrade `cost-velocity` while leaving `loop-signature`
and `context-bloat` protected. `resetExecution(id)` drops stale evidence and
clusters; `endExecution(id)` flushes and releases the execution. Histories are
also bounded by count, per-execution step count, and idle eviction.

Reporting occurs after provider payment. A detector endpoint failure cannot
rewrite a successful provider result as a provider error; in default
fail-closed mode it latches `detector_reporting_unavailable`, and the next
pre-call boundary is denied as a recovery barrier.

The package-consumer gate installs packed tarballs offline outside the workspace,
strictly compiles declarations from `@fuse/sdk`, `@fuse/sdk/otel`, and
`@fuse/sdk/providers`, then uses localhost receivers to prove the firing
acknowledgment, next-call denial, OTLP trace export, and exporter-evidence
callback. It does not disable OTel or either reporting path.

## `StepShapeCanonicalizer`

`runStep` manages one canonicalizer per execution. Low-level integrations may
create one canonicalizer per local execution/detector window, then call
`canonicalize({ kind, text, structure })` for completed steps. It normalizes
timestamps, numeric values, UUID/ULID/long opaque identifiers, folds case and
punctuation, and clusters near-identical token sets using a configurable
Jaccard threshold. `kind` and optional `structure` labels are hard cluster
boundaries, so callers should use them to distinguish real progress states.

Only a fixed-size keyed fingerprint is returned. The default key is random and
process-local; raw text and raw tokens are not retained or exported. A supplied
`key` makes replay tests deterministic but also makes fingerprints linkable.
Fingerprints remain correlation metadata, not anonymized data: low-entropy text
can still collide after volatile-value removal, and anyone holding a fixed key
can attempt dictionary guesses. Keep the key and helper local, never attach raw
input to telemetry, and tune the similarity threshold against representative
normal traffic. Higher thresholds increase false negatives for paraphrases;
lower thresholds increase false positives. Clusters are bounded and oldest-
first eviction means fuzzy grouping is intentionally local, not a durable or
globally consistent content identity. Input processing is capped at 32 KiB and
512 normalized tokens per shape; differences only beyond those caps are not
visible to clustering.

## Framework Integration Boundary

The core package deliberately has no LangChain, Vercel AI SDK, provider SDK, or
other framework dependency. A framework adapter should live in its own package,
own the framework peer dependency, and translate exactly one operation: the
framework's final model-dispatch hook into `FuseGuard.guard()`.

```ts
import type { FuseGuard } from '@fuse/sdk';

interface FrameworkModel<Input, Output> {
  invoke(input: Input): Promise<Output>;
}

export function guardedModel<Input, Output>(
  guard: FuseGuard,
  model: FrameworkModel<Input, Output>,
): FrameworkModel<Input, Output> {
  return {
    invoke: (input) => guard.guard(() => model.invoke(input)),
  };
}
```

The adapter must route every model-call path through that boundary, preserve
the framework's cancellation/error semantics, and prove with a request counter
that denial causes zero provider requests. Do not wrap prompt construction,
retrieval, parsing, or an entire agent loop if doing so leaves an alternate
provider dispatch path unguarded.
