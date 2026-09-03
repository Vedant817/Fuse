# Fuse

Fuse is an OpenTelemetry-native circuit breaker that detects runaway AI-agent
behavior and blocks the next guarded model call before provider dispatch.

It watches behavior across calls, not just one request: repeated step shapes,
unbounded context growth, and abnormal estimated-cost velocity. When a detector
fires, Fuse commits an auditable, scope-specific breaker trip before accepting
the observation. `FuseGuard` then denies the next provider callback.

```text
Preflight -> Sense -> Detect -> Trip -> Block next guarded call -> Diagnose -> Resume
```

> **Project status:** pre-1.0 open-source infrastructure. The repository has
> unit, real-PostgreSQL integration, failure-injection, packaging, and local
> container evidence. It does not yet have published customer outcomes,
> production SLA evidence, or validated detector precision/recall. See
> [limitations](./docs/runbooks/limitations.md) and
> [funding diligence](./docs/funding-diligence.md).

## Why Fuse

Per-request limits miss failures that emerge over a sequence of individually
valid calls. Observability can explain the spend after it happens, but an alert
alone does not prove that the next request was prevented. Fuse puts an explicit
permit check at the provider boundary and keeps the decision state in
PostgreSQL.

The primary path is synchronous and short:

1. The SDK checks `/v1/permit` immediately before provider dispatch.
2. After a completed agent step, it sends a bounded trailing window to
   `/v1/detectors/observe`.
3. The control plane evaluates all three detectors and atomically trips the
   exact `tenant/environment/agentId` scope when one fires.
4. A later guarded call receives `allowed: false`; its provider callback is not
   invoked.
5. A durable job retrieves SigNoz evidence, writes an incident snapshot, and
   optionally posts to Slack.
6. Resume requires an authorized, reasoned, epoch-bound operator action.

SigNoz remains important, but asynchronous: it stores and visualizes OTel data,
corroborates detector results, can trip as an epoch-bound fallback, and supplies
MCP evidence for diagnosis. It is not credited with the direct path's latency.

## Quick Start

Requirements: Node.js 24+, pnpm 11+, Docker, Bash, `curl`, and `openssl`.

```bash
pnpm install
cp .env.example .env

OPERATOR_TOKEN="$(openssl rand -hex 32)"
AGENT_TOKEN="$(openssl rand -hex 32)"
EXPORTER_TOKEN="$(openssl rand -hex 32)"
WEBHOOK_TOKEN="$(openssl rand -hex 32)"
sed -i.bak \
  -e "s|^CONTROL_PLANE_API_TOKENS=.*|CONTROL_PLANE_API_TOKENS=$OPERATOR_TOKEN|" \
  -e "s|^CONTROL_PLANE_AGENT_API_TOKENS=.*|CONTROL_PLANE_AGENT_API_TOKENS=*:*:*:$AGENT_TOKEN|" \
  -e "s|^CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS=.*|CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS=*:*:*:$EXPORTER_TOKEN|" \
  -e "s|^FUSE_PREFLIGHT_EXPORTER_TOKEN=.*|FUSE_PREFLIGHT_EXPORTER_TOKEN=$EXPORTER_TOKEN|" \
  -e "s|^CONTROL_PLANE_WEBHOOK_TOKENS=.*|CONTROL_PLANE_WEBHOOK_TOKENS=$WEBHOOK_TOKEN|" \
  .env

set -a; source .env; set +a
docker compose -f infra/docker-compose.yml up -d postgres
pnpm --filter @fuse/breaker-store run migrate
pnpm --filter @fuse/control-plane run dev
```

In a second terminal:

```bash
set -a; source .env; set +a
pnpm --filter @fuse/broken-agent run demo:real-detect loop
```

Expected proof: a direct detector actor commits a trip, then the script attempts
another guarded call and reports `0 provider calls`. The demo uses a fake
provider by default, so no LLM key or SigNoz instance is required.

Use `context-bloat` or `cost-velocity` instead of `loop` to exercise the other
detectors. See the [90-second demo](./docs/demo-script.md) for the narration and
the separate SigNoz fallback proof.

## SDK Integration

```ts
import { BreakerTrippedError, FuseGuard } from '@fuse/sdk';

const guard = new FuseGuard({
  scope: { tenant: 'acme', environment: 'production', agentId: 'support-agent' },
  controlPlaneUrl: process.env.FUSE_CONTROL_PLANE_URL!,
  apiToken: process.env.FUSE_AGENT_TOKEN!,
  exporterEvidenceToken: process.env.FUSE_PREFLIGHT_EXPORTER_TOKEN!,
  outageMode: 'fail-closed',
});

const executionId = crypto.randomUUID();
try {
  const result = await guard.runStep({
    executionId,
    providerName: 'groq',
    requestModel: 'llama-3.1-8b-instant',
    kind: 'support-response',
    stepIndex: 0,
    dispatch: () => model.generate(request), // provider bytes can start here
    observe: (completion) => ({
      text: completion.text,
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
      structure: ['answer'],
    }),
  });
} catch (error) {
  if (!(error instanceof BreakerTrippedError)) throw error;
} finally {
  await guard.endExecution(executionId);
}
```

Every provider path that should be protected must execute through `runStep()`
(or the lower-level `guard()` plus explicit canonicalization/reporting).
`runStep()` is the recommended path because it activates direct detection, not
only pre-call enforcement. Histories are bounded and isolated by `executionId`;
unknown pricing degrades only cost-velocity protection and is never reported as
semantic `$0`.
Register the scope first through operator-only `POST /v1/scopes/register`, and
use a production agent credential bound to that exact scope. The complete SDK
surface is in [`packages/sdk/API.md`](./packages/sdk/API.md).

For exporter-reported Preflight evidence, use the supported OTel runtime and a
separate exact-scope exporter credential:

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

`protected` requires a successful callback from the real OTLP trace exporter,
submitted through the exporter-only credential, plus fresh structural span
evidence. App-side span creation and an ordinary agent credential are not
enough. The bearer credential authenticates the reporting capability; it does
not cryptographically attest the callback. A process that can read the exporter
credential can forge evidence, including a fully compromised in-process agent.
Isolate the exporter and credential in a separately protected process when that
threat is in scope. Exporter failure, missing fields, orphaning, or stale
evidence produces an explicit `degraded` or `blind` state.

## Protection Contract

- **Enforcement boundary:** only model calls wrapped by `FuseGuard`.
- **After a committed trip:** the next permit for that scope is denied and the
  guarded provider callback is not invoked.
- **Concurrent calls:** calls already past their permit check may complete.
- **Outages:** SDK and control-plane permit handling default to fail-closed;
  deployments may explicitly choose fail-open.
- **Telemetry loss:** Preflight reports loss of confidence, but does not itself
  trip the breaker.
- **Scope isolation:** production agent tokens must bind exact tenant,
  environment, and agent ID values.
- **Exporter evidence:** production uses a separate exact-scope credential that
  cannot call permit, detector, or operator routes.
- **Fallback alerts:** SigNoz alerts must carry the source breaker epoch; stale
  or legacy unbound alerts cannot mutate current breaker state.

## Architecture

| Component                | Responsibility                                             |
| ------------------------ | ---------------------------------------------------------- |
| `packages/sdk`           | Pre-call guard, step reporting, OTel/Preflight integration |
| `packages/detectors`     | Pure loop, context-bloat, and cost-velocity evaluation     |
| `packages/breaker-core`  | Deterministic breaker transitions                          |
| `packages/breaker-store` | PostgreSQL state, audit, idempotency, diagnosis queue      |
| `packages/preflight`     | Telemetry protection-state evaluation and hysteresis       |
| `packages/otel`          | `gen_ai` spans, Fuse metrics, exporter delivery evidence   |
| `packages/diagnosis`     | SigNoz MCP evidence, deterministic diagnosis, Slack cards  |
| `services/control-plane` | Authenticated APIs, policies, enforcement, workers         |
| `services/broken-agent`  | Reproducible normal and runaway fixtures                   |

The database has seven forward-only migrations, from `0001_init.sql` through
`0007_diagnosis_job_replays.sql`. Diagnosis delivery uses leased, retryable jobs
with dead-letter listing and operator-attributed replay. See the
[architecture document](./docs/architecture.md) and
[ADR-014](./docs/adr/014-authoritative-direct-enforcement.md).

## Production Boundaries

Production startup refuses:

- wildcard or partial-scope agent credentials;
- missing or invalid detector policy configuration;
- missing or unreachable shared rate-limit Redis;
- placeholder tokens;
- stale database schema at `/readyz`.

The checked-in Kubernetes base runs two replicas and uses PostgreSQL for shared
state and Redis for shared rate-limit counters. Operate PostgreSQL, Redis,
SigNoz, TLS, secrets, backups, and image scanning as external production
dependencies. Start with the [deployment runbook](./docs/runbooks/deployment.md)
and [operations runbook](./docs/runbooks/operations.md).

## SigNoz and Slack

Run `infra/signoz-up.sh`, `infra/signoz-alerts-up.sh`, and
`infra/signoz-dashboard-up.sh` to provision the local stack. SigNoz receives
standard `gen_ai` attributes and bounded `fuse.*` metrics for dashboards,
fallback alerts, and MCP evidence. Slack resume appears only with request
signing, actor/workspace authorization, a tenant-appropriate operator
credential, and the trip epoch.

## Packages and Quality Gates

`@fuse/contracts`, `@fuse/otel`, and `@fuse/sdk` are configured as publishable
ESM packages. Validate their tarballs in an isolated consumer with:

```bash
pnpm run test:package-consumer
```

The gate installs with registry access disabled outside the workspace, compiles
the installed declarations and all supported SDK subpaths, then permits only
localhost execution. It proves default `runStep` detector reporting receives a
firing acknowledgment, the next provider callback remains at zero, a real span
reaches a local OTLP HTTP receiver, and the separate exporter-evidence endpoint
is called. OTel and reporting remain enabled throughout.

Common repository checks:

```bash
pnpm run check              # format, lint, build, typecheck, unit tests
pnpm run test:integration   # real PostgreSQL/Redis integration tests
pnpm run check:full
```

## Documentation

- [Architecture](./docs/architecture.md)
- [OpenAPI](./docs/openapi.yaml)
- [Threat model](./docs/threat-model.md)
- [Runbooks and limitations](./docs/runbooks/)
- [Product strategy and pilot](./docs/product-strategy.md)
- [Funding diligence](./docs/funding-diligence.md)
- [Historical evidence and original brief](./task.md)

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
