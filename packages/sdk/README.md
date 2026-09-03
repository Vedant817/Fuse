# `@fuse/sdk`

Fuse's provider-neutral, pre-call circuit-breaker SDK for Node.js agents. A
fresh permit is checked immediately before every guarded provider dispatch.
After a trip commits, subsequent guarded permit checks are denied; calls already
past their permit check and unguarded dispatches are outside that guarantee.

## Quickstart

```ts
import { BreakerTrippedError, FuseGuard } from '@fuse/sdk';

const guard = new FuseGuard({
  scope: {
    tenant: 'acme',
    environment: 'production',
    agentId: 'support-agent',
  },
  controlPlaneUrl: process.env.FUSE_CONTROL_PLANE_URL!,
  apiToken: process.env.FUSE_AGENT_TOKEN!,
  exporterEvidenceToken: process.env.FUSE_PREFLIGHT_EXPORTER_TOKEN!,
  // Fail-closed is the default. Opt into fail-open only as an explicit policy.
  outageMode: 'fail-closed',
});

const executionId = crypto.randomUUID();
try {
  const completion = await guard.runStep({
    executionId,
    providerName: 'groq',
    requestModel: 'llama-3.1-8b-instant',
    kind: 'summarizer',
    stepIndex: 0,
    dispatch: () => model.generate({ prompt: 'Summarize the incident.' }),
    observe: (result) => ({
      text: result.text,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      structure: ['incident-summary'],
    }),
  });
  console.log(completion);
} catch (error) {
  if (error instanceof BreakerTrippedError) {
    console.error(error.code, error.action, error.correlationId);
  } else {
    throw error;
  }
} finally {
  await guard.endExecution(executionId);
}
```

`runStep` is the supported direct-detection path: it checks a permit immediately
before the provider callback, instruments the call, canonicalizes the completed
step locally, and reports its execution-scoped detector window before returning.
Perform local preparation first, then put only the operation that can send
provider bytes in `dispatch`.

All public detector observations require `executionId` and an explicit
`pricingStatus`. `runStep` supplies both from its required execution identity and
the price table result. Low-level `recordStepObservation` callers must provide
the same strict shape; unscoped legacy observations are not accepted.

Each execution retains an independent bounded history. Call `resetExecution`
before intentionally restarting one execution, or `endExecution` when it is
finished. Unknown model pricing is reported as unavailable, not `$0`;
`getDetectorProtection(executionId)` then reports loop/context as protected and
cost velocity as degraded. A post-paid report failure never replaces a provider
success, but the default fail-closed latch denies the next guarded dispatch.

For privacy-minimized loop telemetry, `StepShapeCanonicalizer` turns raw local
step text into a bounded keyed fingerprint while normalizing volatile values
and grouping modest wording changes. Supply structural progress labels to avoid
merging semantically different work; see [`API.md`](./API.md) for privacy,
collision, and false-positive tradeoffs.

For OTel exporter-health routing and orderly shutdown, use `@fuse/sdk/otel`:

```ts
import { bootstrapFuseOtel } from '@fuse/sdk/otel';

const runtime = bootstrapFuseOtel({
  serviceName: 'support-agent',
  serviceVersion: '1.0.0',
  deploymentEnvironment: 'production',
});
runtime.registerGuard(guard);

process.once('SIGTERM', () => void runtime.shutdown());
```

The guard sends structural observations with `apiToken` and exporter results to
`/v1/preflight/exporter-evidence` with `exporterEvidenceToken`. It never falls
back to the agent token. Omitting the exporter credential is supported for
local/test structural-only reporting, but Preflight cannot become `protected`.
In production the control plane requires a separate exact-scope exporter
credential. Because the supported runtime is in-process, a fully compromised
agent that can read that credential can still forge exporter evidence; use an
isolated exporter process and secret boundary when that attacker is in scope.

See [`API.md`](./API.md) for the supported exports and framework integration
boundary. This package is ESM-only and requires Node.js 24 or newer. It is
licensed under Apache-2.0.
