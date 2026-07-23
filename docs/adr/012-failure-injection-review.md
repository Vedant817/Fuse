# ADR-012: Failure-injection review (task.md §9.2)

- Status: accepted
- Date: 2026-07-23
- Deciders: Vedant817 (explicit choice, via delegated senior-engineer agent)

## Context

task.md §9.2 asks for failure-injection tests — Postgres outages, webhook
replay, control-plane unreachability, dependency (Slack/SigNoz MCP) outages,
clock skew, and concurrent-request races. Before writing anything new, the
existing test suite was surveyed directly (not assumed from memory) for what
already exercises these scenarios, to avoid duplicating coverage built in
earlier sessions.

## Survey: already covered, verified by reading the actual test files

- **Postgres/store outage**: `packages/breaker-store/src/pool.test.ts`,
  `guard.test.ts`'s outage-mode tests (fail-open/fail-closed/timeout/
  malformed response), `app.integration.test.ts`.
- **Webhook replay/idempotency**: `webhook.integration.test.ts`'s "duplicate
  delivery of the same alert (same fingerprint+startsAt) is idempotent",
  plus stale-alert and clock-skew rejection tests in the same file.
- **Concurrency/races**: `store.integration.test.ts`'s "survives concurrent
  trip requests for the same scope: exactly one real transition", "N truly
  concurrent requests sharing the SAME idempotency key produce exactly one
  audit row", and a dedicated regression test for per-caller
  actor/reason/correlationId attribution under concurrent trips.
  `guard.integration.test.ts`'s "concurrent calls racing the trip" and
  "in-flight exposure" tests cover the SDK side of the same race.
- **SigNoz MCP / evidence-fetch failures**: `evidence.test.ts`'s "degrades to
  available:false" on MCP call failure, tool error, and malformed JSON;
  `mcp-client.test.ts`'s "throws (does not hang) when the server is
  unreachable, within the configured timeout".
- **Slack failures**: `slack-client.test.ts`'s API-level error, non-2xx, and
  network-error cases for both `postIncidentCard` and `openResumeModal`;
  `diagnosis-worker.test.ts`'s "never throws even if evidence fetch rejects
  unexpectedly" and "logs (but does not throw) when the Slack post is not
  delivered".
- **Slack replay protection**: `slack-interactive.test.ts`'s missing/invalid
  signature and stale-timestamp-with-valid-signature tests.
- **Shutdown races**: `shutdown.test.ts`'s duplicate-signal and
  partial-cleanup-failure tests.

This is already substantially more thorough than a typical hackathon
timeline produces — confirmed by actually running it (not just reading it):
`webhook.integration.test.ts`, `auth.test.ts`, and `app.integration.test.ts`
(54 tests, real Postgres via testcontainers) all pass.

## The one real, new gap found: unbounded scope cardinality in `DetectorRunner`

`services/control-plane/src/detector-runner.ts` already bounded each
individual scope's step buffer (`MAX_BUFFER_SIZE = 500`,
`MAX_BUFFER_AGE_MS`, both tested) but had **no bound on the number of
distinct scopes tracked at all**. `scopeKey` is built from
`tenant`/`environment`/`agentId` — three caller-controlled strings in the
body of `POST /v1/detectors/observe`, reachable by any valid agent-tier
token (`app.ts`'s preHandler). Nothing pruned an abandoned scope's Map entry
either — pruning was on-write for a scope's own buffer, never a background
sweep, so a scope that stops sending steps keeps its last buffer forever.
A caller sending many distinct `agentId`s (malicious or just a buggy
high-cardinality integration) could grow the `buffers` Map without limit —
a real memory-exhaustion vector distinct from, and not caught by, the
existing per-scope buffer bound or its test.

**Fixed**: added `MAX_TRACKED_SCOPES` (10,000) with LRU eviction — the
`Map`'s insertion order is used as the recency ordering (delete-then-set on
every touch moves a scope to the end; the oldest-remaining key is evicted
when the cap is exceeded). Two new tests
(`services/control-plane/src/detector-runner.test.ts`) prove: (1) a 4th
scope past a test-configured cap of 3 evicts exactly the least-recently-
touched one, not an arbitrary one; (2) re-touching a scope moves it out of
eviction order, so activity — not insertion time — determines what survives.
Both use a new constructor parameter (`maxTrackedScopes`, defaults to the
real 10,000 in production) and two new test-only introspection methods
(`trackedScopeCount`, `hasScope`) rather than inferring eviction indirectly
from detector-firing side effects, which would have been ambiguous (a
single fresh step never fires any detector regardless of eviction).

## Consequences

- `DetectorRunner`'s constructor signature changed
  (`constructor(maxTrackedScopes: number = MAX_TRACKED_SCOPES)`) — every
  existing call site (`app.ts`, `server.ts`, all prior tests) uses the
  no-arg form and is unaffected; verified via `pnpm run typecheck` and the
  full test suite (287 tests across the workspace, all passing) rather than
  assumed compatible.
- The eviction is a defense-in-depth ceiling (10,000 scopes × up to 500
  steps each is still a bounded, sized-for-purpose amount of memory), not
  expected to bind in normal operation — real agents reuse a small, stable
  set of `agentId`s.
- Not built: a metric/log line when eviction actually fires (would help an
  operator notice unexpected cardinality growth) — a reasonable follow-up,
  not implemented here to keep this slice scoped to the concrete
  correctness/DoS fix task.md §9.2 asked for.
