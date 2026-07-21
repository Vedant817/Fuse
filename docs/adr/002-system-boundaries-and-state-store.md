# ADR-002: System boundaries and breaker state store

- Status: accepted
- Date: 2026-07-21
- Deciders: Vedant817 (via delegated senior-engineer agent)

## Context

The breaker guarantee ("the next model-provider request is not dispatched
after a committed trip") depends on where state lives, how transitions are
made atomic, and how the system behaves under restarts, duplicate/
out-of-order alerts, and store outages. We need a single, durable source of
truth for breaker state and its audit trail, scoped by
tenant/environment/agent, before any middleware or webhook code is written
against it.

## Decision: component boundaries

Monorepo packages/services (pnpm workspaces):

- `packages/contracts` — versioned zod schemas + inferred TS types for the
  policy file, alert webhook input (raw + normalized), breaker API
  requests/responses, audit events, Preflight results, and diagnosis output.
  No runtime dependencies on any other package. Every external boundary
  parses through this package.
- `packages/breaker-core` — pure, side-effect-free domain logic: breaker
  state model, valid transition table, policy evaluation, cooldown
  arithmetic. No I/O, no clock reads except via an injected clock, fully
  unit/property testable in isolation.
- `packages/breaker-store` — Postgres-backed persistence adapter implementing
  atomic transitions (`trip`/`permit`/`resume`/`disable`) on top of
  `breaker-core`'s pure functions, plus the append-only audit log and
  idempotency-key table.
- `packages/sdk` — provider-neutral pre-call middleware. Wraps an arbitrary
  async "dispatch" function; calls the control plane's permit endpoint
  immediately before invoking it; provider SDK types never leak into
  `breaker-core`.
- `services/control-plane` — Fastify HTTP service: alert webhook, permit
  endpoint, and the authenticated operational API (health, readiness, status,
  force-trip, resume, disable/enable, policy inspection). Only this service
  talks to `breaker-store` directly.
- `services/broken-agent` (later slice) — the deliberately broken
  Analyzer/Verifier demo fixture, instrumented with OTel `gen_ai` conventions,
  consuming `packages/sdk`.
- `infra/` — Docker Compose for Postgres (and later SigNoz), SQL migrations,
  reset scripts.
- `docs/adr/` — this record and future ADRs.

Trust boundary: only `services/control-plane` has network/credential access
to the state store. Every other component reaches breaker state exclusively
through the control plane's authenticated HTTP API — including the SDK. This
keeps exactly one place responsible for atomicity, auditing, and tenant
isolation, and lets the SDK be embedded in any process (including a
different-language agent later) without distributing database credentials.

## Decision: state store

Use **PostgreSQL** as the single durable store for breaker state and its
audit trail (not Redis, not an in-memory store, not a second store alongside
Postgres).

Schema (initial):

- `breaker_state(tenant, environment, agent_id, state, epoch, reason,
  policy_version, cooldown_until, updated_at, updated_by)` — one row per
  scoped breaker; primary key `(tenant, environment, agent_id)`.
- `breaker_audit_log(id, tenant, environment, agent_id, from_state, to_state,
  epoch_before, epoch_after, actor, reason, correlation_id, policy_version,
  created_at)` — append-only, one row per committed transition.
- `idempotency_keys(key, tenant, environment, agent_id, request_hash,
  response_snapshot, created_at, expires_at)` — dedupes retried/duplicate
  webhook and API calls so retries return the original outcome rather than
  re-executing a transition.

Atomicity mechanism: **epoch-based compare-and-swap**. Every transition reads
the current `epoch`, computes the next state via `breaker-core`'s pure
transition function, then commits with
`UPDATE breaker_state SET state=$1, epoch=$2, ... WHERE tenant=$t AND
environment=$e AND agent_id=$a AND epoch=$expected`. A `0`-row update means a
concurrent writer already moved the epoch forward; the caller re-reads and
retries (or, for idempotent requests, resolves via the idempotency-key table
instead of a blind retry). This gives lock-free atomicity from a single SQL
statement's MVCC guarantees, without holding row locks across application
logic or introducing a distributed lock service.

Restart recovery: state and audit log survive process restarts because they
are only ever durable in Postgres (WAL + normal durability settings); no
in-memory breaker state is treated as authoritative anywhere.

## Alternatives considered

- **Redis** (with `WATCH`/`MULTI` or Lua for atomicity): faster round-trip,
  but weaker fit for the audit trail requirement (who/what/why/when for every
  transition) which is naturally relational and query-friendly, and adds a
  second stateful dependency to operate/back up/restore for marginal latency
  benefit — the permit check runs once per LLM call, which is already a
  network round trip an order of magnitude slower than a local Postgres
  query. Rejected for v1; may be reconsidered later purely as a read-through
  cache in front of Postgres if permit-check latency becomes a measured
  bottleneck (P2, not required by any current acceptance criterion).
- **In-memory/single-process state**: fails the restart-recovery and
  multi-instance requirements outright. Rejected.
- **Row-level locking (`SELECT ... FOR UPDATE`) instead of epoch CAS**:
  works, but serializes all transitions for a given breaker behind a
  held connection/lock for the duration of application logic between read and
  write, which is worse under concurrent trip/permit/resume races than a
  single atomic `UPDATE ... WHERE epoch = $expected`. Epoch CAS also gives a
  natural, inspectable "stale epoch" concept for rejecting out-of-order alert
  processing.
- **Two stores (Postgres for audit, Redis for hot state)**: rejected for v1
  as unnecessary operational complexity; revisit only if load testing (task
  9.2) shows Postgres cannot meet the permit-latency budget.

## Consequences

- The control plane is a single point of failure for enforcement by design;
  its fail-open/fail-closed behavior on store outage must be explicit,
  configurable, and visible (tracked in task.md §1.1/§2.2) — this ADR does
  not resolve that policy choice, only where state lives.
- Every transition is attributable and replay-safe by construction (epoch +
  idempotency key), which directly satisfies the §2 acceptance criteria for
  atomic, idempotent, auditable breaker transitions.
- Local development requires Postgres via `infra/docker-compose.yml`; the
  reset script must be able to drop and re-migrate the schema deterministically
  for demo reruns.
