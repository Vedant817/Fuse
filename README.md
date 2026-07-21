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
| `services/control-plane` | Fastify HTTP API: breaker operations, Preflight report/status, SigNoz alert webhook                                             |
| `services/broken-agent`  | A generic, invented Analyzer↔Verifier agent fixture used to exercise every detector/breaker/Preflight path in integration tests |
| `docs/adr/`              | Accepted architecture decision records                                                                                          |
| `infra/`                 | Local Postgres via Docker Compose, plus a deterministic reset script                                                            |

## Prerequisites

- Node.js >= 24 and pnpm >= 11 (see `package.json` `engines`)
- Docker (for local Postgres and for the testcontainers-based integration
  test suite — every integration test in this repo runs against a real,
  ephemeral Postgres container, not a mock)

## Getting started

```bash
pnpm install
cp .env.example .env   # then fill in real values — see comments in the file
```

Start local Postgres and apply migrations:

```bash
docker compose -f infra/docker-compose.yml up -d postgres
pnpm --filter @fuse/breaker-store run migrate
```

Run the control plane in watch mode:

```bash
pnpm --filter @fuse/control-plane run dev
```

`infra/reset.sh` deterministically drops and recreates the local schema —
useful before a fresh demo run. Stop and remove the local Postgres container
with:

```bash
docker compose -f infra/docker-compose.yml down
```

### Real LLM providers (optional)

`packages/sdk` ships adapters for Groq and NVIDIA Build (ADR-003). Everything
in this repo defaults to a mock/fake-provider path and works with no API keys
at all. Set `GROQ_API_KEY`/`NVIDIA_API_KEY` in `.env` to additionally run the
live-optional provider tests (`pnpm --filter @fuse/sdk run test:live`), which
self-skip when the corresponding key is absent.

### SigNoz

Fuse is built to run against SigNoz Cloud for real telemetry ingestion and
alerting. As of this writing that live-ingestion path is not yet verified end
to end (no SigNoz Cloud credentials have been supplied to this build) — see
task.md for the exact, current status of that gap. Every detector, the
breaker, and Preflight are fully built and tested against real Postgres and
real HTTP without requiring SigNoz itself to be running.

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
- [`docs/adr/`](./docs/adr) — accepted architecture decisions (language/
  runtime choice, system boundaries and state store, provider adapters).
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how changes are made in this repo.

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).
