# Fuse

Fuse is an OTel-native cost circuit breaker for AI agents, built for the
SigNoz Hackathon (Track 01, AI & Agent Observability). It reads the trace
shape of an agent's own execution — loop signatures, growing context, cost
velocity — and trips a breaker **before** the next expensive model call, not
after. See [`Fuse_Hackathon_Brief.md`](./Fuse_Hackathon_Brief.md) for the full
product pitch and [`task.md`](./task.md) for the live, evidence-backed build
tracker (the source of truth for what is actually done versus still open).

The non-negotiable path this repo is built around:

```
Preflight -> Sense -> Detect -> Enforce before the next call -> Diagnose -> Recommend -> Resume
```

The breaker's pre-call enforcement is the critical path. Preflight exists so
Fuse never claims protection it can't currently back with evidence — see
`packages/preflight` and task.md §6.

## The problem

An agent stuck in a loop, growing its own context unboundedly, or burning
tokens faster than any human is watching doesn't fail loudly — it just gets
expensive, quietly, until someone notices the bill. Rate limits and
per-request budgets don't catch this: a loop of _cheap_ calls, or a context
window growing one legitimate-looking turn at a time, can pass every
per-call check while still being a runaway. Fuse instead reads the _shape_
of an agent's own execution across calls — repetition, growth, velocity —
and answers one question before every model call: "given what this agent
has actually been doing, should this next call happen at all?" If the
answer is no, it blocks the call itself, not just alerts about it
afterward — and if Fuse's own telemetry isn't good enough to answer that
question honestly, it says so (`degraded`/`blind`) instead of silently
assuming protection held.

## Architecture

See [`docs/architecture.md`](./docs/architecture.md) for the full system
diagram, a step-by-step sequence of one real incident (telemetry in → alert
→ trip → blocked call → diagnosis → Slack → resume), and why enforcement
lives in a dedicated control plane rather than inside SigNoz itself.

### How SigNoz is used — one closed loop, not a side dashboard

Every SigNoz capability this hackathon track asks about is load-bearing,
not decorative:

- **Traces/metrics** — `packages/otel` emits `gen_ai.*` semantic-convention
  spans and Fuse's own metrics (`fuse.detector.score`, `fuse.detector.fired`,
  `fuse.breaker.permit.decisions`, `fuse.estimated_cost.usd.total`,
  `fuse.preflight.state`) into SigNoz via OTLP.
- **Alerts** — `infra/signoz/alerts/*.json` are real, provisioned alert
  rules that query those exact gauges on a fixed cadence and call back into
  the control plane's webhook when one crosses threshold — the _only_ path
  that trips a breaker from outside an operator action.
- **Dashboards** — `infra/signoz/dashboards/fuse-agent-cost-health.json`
  visualizes the same metrics an operator would otherwise have to query by
  hand: breaker state, Preflight health, detector activity, spend.
  Live-verified rendering, not just "the JSON is valid"
  (`docs/adr/008-signoz-dashboard-provisioning.md`).
- **MCP** — when a breaker trips, `packages/diagnosis` calls SigNoz's own
  MCP server to pull the real evidence spans behind the trip, before
  building a deterministic hypothesis and posting it to Slack
  (`docs/adr/007-signoz-mcp-diagnosis.md`).

## Repository layout

pnpm workspaces, one package/service per concern:

| Path                     | What it is                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`     | Zod schemas — the single source of truth for every versioned wire contract                                                      |
| `packages/breaker-core`  | Pure, side-effect-free breaker state machine (trip/resume/disable/enable/permit)                                                |
| `packages/breaker-store` | Postgres-backed breaker state + audit store, epoch-CAS transitions, migrations                                                  |
| `packages/preflight`     | Pure telemetry-health evaluator (protected/degraded/blind/disabled), with hysteresis                                            |
| `packages/detectors`     | Pure detector functions: loop signature, context bloat, cost velocity                                                           |
| `packages/otel`          | OTel bootstrap + `gen_ai` semantic-convention span/metric instrumentation                                                       |
| `packages/sdk`           | `FuseGuard` middleware agents wrap provider calls in, plus Groq/NVIDIA Build adapters                                           |
| `services/control-plane` | Fastify HTTP API: scope/policy operations, direct detector enforcement, breaker/Preflight APIs, SigNoz/Slack webhooks           |
| `services/broken-agent`  | A generic, invented Analyzer↔Verifier agent fixture used to exercise every detector/breaker/Preflight path in integration tests |
| `docs/adr/`              | Accepted architecture decision records                                                                                          |
| `infra/`                 | Local Postgres via Docker Compose, a deterministic reset script, and a self-hosted SigNoz stack (Foundry)                       |

## Prerequisites

- Node.js >= 24 and pnpm >= 11 (see `package.json` `engines`)
- Docker (for local Postgres and for the testcontainers-based integration
  test suite — every integration test in this repo runs against a real,
  ephemeral Postgres container, not a mock)
- Bash and `curl` for the SigNoz launch/provisioning scripts; `jq` and
  Python 3 are additionally required by `infra/signoz-alerts-up.sh` and
  `infra/signoz-dashboard-up.sh`. Shell scripts are pinned to LF checkout
  endings via `.gitattributes` so they remain runnable from WSL/Git Bash on
  Windows.

## Getting started

```bash
pnpm install
cp .env.example .env   # then fill in real values — see comments in the file
# The CLIs intentionally do not parse dotenv files themselves. Export the
# file in every terminal that will run a Fuse process (bash/zsh):
set -a
source .env
set +a
```

Start local Postgres and apply migrations:

```bash
docker compose -f infra/docker-compose.yml up -d postgres
pnpm --filter @fuse/breaker-store run migrate
```

Run the control plane in watch mode (pick real random tokens, not these
examples, if this will be reachable by anyone but you):

```bash
pnpm --filter @fuse/control-plane run dev
```

Every agent scope must be registered once by an operator before permit,
Preflight, detector, or webhook traffic can use it. The demo scripts do this
automatically. Other integrations call `POST /v1/scopes/register`; inspect
the loaded thresholds afterward with operator-only
`GET /v1/policies/effective?tenant=...&environment=...&agentId=...`.
Request/response details are in `docs/openapi.yaml`.

`infra/reset.sh` deterministically drops and recreates the local schema —
useful before a fresh demo run. Stop and remove the local Postgres container
with:

```bash
docker compose -f infra/docker-compose.yml down
```

### Live demo

With the control plane running (above), in another terminal:

```bash
pnpm --filter @fuse/broken-agent run demo
```

Narrates, against the real running control plane (no mocks): a normal run
terminating cleanly, a pathological loop capped by the fixture's own hard
ceiling, an external trip via the real `/v1/breaker/trip` API stopping
dispatch mid-run with an exact before/after call count, an operator resume,
and the resulting Preflight status. Set `GROQ_API_KEY` or `NVIDIA_API_KEY`
to add a real (non-mocked) provider call at the end, guarded exactly like
any other call. Fails fast with setup instructions if the control plane
isn't reachable; if SigNoz (below) isn't running either, it says so and
carries on rather than treating that as an error.

With SigNoz and its alert rules also provisioned (below,
`infra/signoz-alerts-up.sh`), run the real detector-to-trip proof instead —
**no manual trip call anywhere in this script**, only a real SigNoz alert
rule evaluating real telemetry:

```bash
pnpm --filter @fuse/broken-agent run demo:real-detect
```

This takes a few minutes (SigNoz evaluates alert rules on a fixed cadence,
plus notification delivery — measured at 231s/331s in two real runs, see
[`docs/adr/006-signoz-alert-rule-provisioning.md`](./docs/adr/006-signoz-alert-rule-provisioning.md)
and [`docs/demo-script.md`](./docs/demo-script.md) for a full rehearsed
transcript with exact timings) — it polls the breaker's real status until a
real alert fires and trips it, or times out with troubleshooting hints.

### Real LLM providers (optional)

`packages/sdk` ships adapters for Groq and NVIDIA Build (ADR-003). Everything
in this repo defaults to a mock/fake-provider path and works with no API keys
at all. Set `GROQ_API_KEY`/`NVIDIA_API_KEY` in `.env` to additionally run the
live-optional provider tests (`pnpm --filter @fuse/sdk run test:live`), which
self-skip when the corresponding key is absent.

### SigNoz (self-hosted)

Fuse runs against a **self-hosted** SigNoz instance (ADR-005 — reversed
from an earlier SigNoz Cloud decision specifically so no external
account/ingestion key is needed). Bring it up with:

```bash
infra/signoz-up.sh
```

This installs [Foundry](https://github.com/SigNoz/foundry) (`foundryctl`)
if it isn't already on your `PATH`, deploys the stack described by
`infra/signoz/casting.yaml` (SigNoz backend+UI, ClickHouse, the SigNoz OTel
Collector), and completes SigNoz's one-time first-run admin/org setup
non-interactively. Idempotent — safe to re-run. Once it's up:

- UI: <http://localhost:8080> (login: `SIGNOZ_ADMIN_EMAIL`/
  `SIGNOZ_ADMIN_PASSWORD` from `.env.example` — local dev credentials only,
  never expose this deployment beyond localhost)
- OTLP endpoint: `http://localhost:4318` — already the `.env.example`
  default for `OTEL_EXPORTER_OTLP_ENDPOINT`, which `packages/otel`'s
  `bootstrapOtel` picks up automatically with zero code changes

Verified end-to-end (not just "containers are up"): a real span emitted by
`@fuse/otel` was confirmed present in this stack's own ClickHouse store by
direct query — see `docs/adr/005-self-hosted-signoz.md` for the exact
verification steps and a real deployment bug (a missing first-run
org/admin bootstrap) found and fixed along the way. Every detector, the
breaker, and Preflight are also fully built and tested against real
Postgres and real HTTP without requiring SigNoz to be running at all.

Tear the stack down with `docker compose -f infra/signoz/pours/deployment/compose.yaml down -v`.

## Policy: detector formulas and thresholds

Three pure, independently-testable detector functions
(`packages/detectors`), each evaluated against a scope's trailing window of
reported step telemetry — never raw prompt/tool content, only structural
shape (token counts, a canonicalized step signature, cost):

| Detector         | Fires when                                                                                                                          | Default threshold                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `loop-signature` | The same cycle of canonicalized step shapes repeats                                                                                 | 3 repetitions of a cycle (`packages/detectors/src/loop-signature.ts`)                                                      |
| `context-bloat`  | Input tokens hit an absolute ceiling, OR (after a minimum meaningful context size) grow for enough consecutive steps / past a ratio | 100,000 tokens absolute; growth signals require at least 8,000 input tokens, then 5 consecutive growing steps or 3x growth |
| `cost-velocity`  | Estimated spend in the trailing window crosses a threshold                                                                          | See `DEFAULT_COST_VELOCITY_CONFIG`                                                                                         |

Every default is a real, versioned zod schema
(`packages/contracts/src/policy.ts`'s `DetectorsConfigSchema`) with its own
drift-guard test (`packages/detectors/src/policy-defaults.test.ts`). The
control plane loads an immutable policy file at startup when
`CONTROL_PLANE_DETECTOR_POLICY_FILE` is set, resolves exact-scope policies
ahead of wildcard selectors, and refuses to start in `production` without
one. The checked-in Kubernetes deployment mounts the explicit
`fuse-production-v1` policy.

**False-positive tradeoffs**: every threshold above is a real design
tradeoff, not a proven-optimal constant — a legitimately long analysis task
can look like context-bloat; a legitimately repetitive but useful pattern
(e.g. polling) can look like a loop. `docs/runbooks/incident-response.md`'s
false-positive entry is the operational answer (resume with a documented
reason, then tune the threshold if it recurs), not a claim these thresholds
never misfire.

**Cost-estimation caveat**: `fuse.estimated_cost.usd.total`
(`packages/otel/src/pricing.ts`) is computed from a local pricing table
against reported token counts — it is an estimate for detection purposes,
not reconciled against your actual provider invoice, and will drift if the
pricing table goes stale or a provider changes rates.

## The guarantee, in plain language

- **What Fuse guarantees**: once a trip commits, the very next `/v1/permit`
  check for that scope returns `allowed: false` — proven under both
  sequential and concurrent load (`packages/sdk/src/guard.integration.test.ts`).
  A call that was already past its own permit check when the trip commits
  may still complete (an accepted, measured in-flight-exposure window, not
  hidden) — the guarantee is about the _next_ call, not a mid-flight abort.
- **Outage behavior**: if the control plane or its Postgres store is
  unreachable, both the SDK and the control plane default to **fail-closed**
  (deny) — a deliberate tradeoff that a store outage also pauses guarded
  calls, favoring cost protection over availability. Configurable per
  deployment (`CONTROL_PLANE_STORE_OUTAGE_MODE`/`FUSE_SDK_OUTAGE_MODE`), but
  fail-closed is the shipped default for a reason.
- **Preflight's actual scope**: a `blind`/`degraded` Preflight state is an
  honest signal that telemetry coverage is too thin to trust a detector's
  silence — it does **not** itself pause enforcement (the breaker's own
  state is independent). Treat a `blind` report as its own incident, not as
  something Fuse has already handled for you. Full detail:
  [`docs/runbooks/limitations.md`](./docs/runbooks/limitations.md).

## Security

Bearer-token auth with three least-privilege roles (operator/agent/webhook),
constant-time token comparison, tenant scoping (opt-in), webhook replay/
staleness rejection, and a real dependency/license/secret scan — see
[`docs/threat-model.md`](./docs/threat-model.md) for the full trust-boundary
analysis and [`docs/adr/009-supply-chain-scan.md`](./docs/adr/009-supply-chain-scan.md)/
[`docs/adr/010-secure-defaults-audit.md`](./docs/adr/010-secure-defaults-audit.md)
for this session's audit evidence. One open, accepted-risk dependency
finding and several deliberately-open tradeoffs (flat rate limiting, no
online key rotation) are recorded there, not silently fixed or hidden.

## Limitations

Read [`docs/runbooks/limitations.md`](./docs/runbooks/limitations.md) before
relying on this in anything beyond a demo — it distinguishes what Fuse
actually guarantees from documented tradeoffs and real, found-during-testing
gaps (no online key rotation, no repository-provided database backup or
schema rollback, best-effort notification delivery, and more), each cited to
its proving test or ADR. The immutable image, Kubernetes base, migration,
rollback, and promotion gates are documented in
[`docs/runbooks/deployment.md`](./docs/runbooks/deployment.md).

## Troubleshooting

| Symptom                                                               | Likely cause                                                                                                                                                                                                               | Fix                                                                                                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `demo`/`demo:real-detect` exits with "Cannot reach the control plane" | Control plane not running, or `.env` not sourced into this shell                                                                                                                                                           | `pnpm --filter @fuse/control-plane run dev` in another terminal; re-`source .env` here                                 |
| Control plane fails to start: "breaker_state table is missing"        | Migrations not applied                                                                                                                                                                                                     | `pnpm --filter @fuse/breaker-store run migrate`                                                                        |
| Control plane fails to start: "invalid control-plane configuration"   | `DATABASE_URL`/`CONTROL_PLANE_API_TOKENS` left completely empty (they have no default and fail closed) — leaving the shipped `.env.example` placeholder text in place does **not** trigger this                            | Fill in real values in `.env`, `source` it again                                                                       |
| Control plane fails to start: "still contains a placeholder value"    | A token still literally starts with `changeme` (the exact `.env.example` placeholder, which is otherwise long enough to pass validation and would silently work as an insecure, publicly-known credential — task.md §11.3) | Generate a real random token (e.g. `openssl rand -hex 32`) for every `CONTROL_PLANE_*_TOKENS` var                      |
| `demo:real-detect` never sees the breaker trip within 8 minutes       | SigNoz alert rules not provisioned, or the OTel collector isn't receiving `fuse.detector.fired`                                                                                                                            | Run `infra/signoz-alerts-up.sh`; confirm `infra/signoz-up.sh` succeeded and `OTEL_EXPORTER_OTLP_ENDPOINT` points at it |
| A load test / rapid demo re-run returns `429`                         | The shared rate limit (`CONTROL_PLANE_RATE_LIMIT_MAX`, default 120/min/token) is exhausted, not a bug                                                                                                                      | Raise it for a test run, or use distinct tokens (`docs/adr/011-permit-load-test.md`)                                   |
| Slack incident card never posts                                       | `SLACK_BOT_TOKEN` unset — this is the documented, graceful degrade                                                                                                                                                         | Check `FUSE_INCIDENT_SNAPSHOT_DIR` for the local HTML snapshot, always written regardless                              |

## Common commands

Run from the repo root unless noted:

```bash
pnpm run build              # build every package/service
pnpm run typecheck          # tsc --noEmit across the workspace
pnpm run lint               # eslint .
pnpm run format             # prettier --check . (use format:fix to apply)
pnpm run test               # unit tests only (no Docker required)
pnpm run test:integration   # integration tests (spins up real Postgres via testcontainers)
pnpm run check              # format + lint + build + typecheck + test
pnpm run check:full         # check + test:integration — run this before every commit
```

Scope any of these to one package with pnpm's `--filter`, e.g.
`pnpm --filter @fuse/breaker-store run test:integration`.

## Documentation map

- [`AGENTS.md`](./AGENTS.md) — the operating manual: engineering boundaries,
  required work cycle, git/commit conventions, definition of done. Read this
  before changing anything.
- [`Fuse_Hackathon_Brief.md`](./Fuse_Hackathon_Brief.md) — product intent and
  the demo narrative this build serves.
- [`task.md`](./task.md) — the live execution tracker. Every checkbox is
  backed by a command or test that was actually run; deferred work is recorded
  honestly rather than silently dropped.
- [`docs/architecture.md`](./docs/architecture.md) — system diagram, the
  closed SigNoz loop, and a full incident's data-flow sequence.
- [`docs/openapi.yaml`](./docs/openapi.yaml) — every control-plane route,
  request/response schema, and status code, hand-verified against the
  actual route code.
- [`docs/adr/`](./docs/adr) — accepted architecture decisions (language/
  runtime choice, system boundaries and state store, provider adapters,
  tenant-scoped tokens, self-hosted SigNoz, alert-rule/dashboard/MCP
  provisioning, supply-chain and secure-defaults audits, the real permit
  load test, the failure-injection review).
- [`docs/runbooks/`](./docs/runbooks) — operations (install/configure/
  upgrade/rollback/key-rotation/retention), incident response (false
  positive, missed trip, stuck breaker, blind telemetry, store outage,
  leaked token, Slack/MCP failure), and a single limitations/non-guarantees
  page.
- [`docs/threat-model.md`](./docs/threat-model.md) — assets, actors, webhook
  auth/replay analysis, and an honest risk register (what's mitigated, what
  isn't yet).
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how changes are made in this repo.

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).
