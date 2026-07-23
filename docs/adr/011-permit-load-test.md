# ADR-011: /v1/permit load test (task.md §9.2)

- Status: accepted
- Date: 2026-07-23
- Deciders: Vedant817 (explicit choice, via delegated senior-engineer agent)

## Context

task.md §9.2 asks for real load testing of the hot path — `/v1/permit`, the
route every guarded LLM call blocks on before making a request. No load-test
tool was preinstalled; `npx autocannon` was used instead (fetched on demand,
no persistent dependency added). The test ran against a real control-plane
process (`tsx src/server.ts`, not a mock) talking to the actual local
Postgres (`fuse-postgres`, already running from earlier sessions,
migrations already applied) — not an in-memory fake.

## Method

A second control-plane instance was started on port 8091 (the normal
8090 dev instance was not touched) with test-only tokens and a raised
`CONTROL_PLANE_RATE_LIMIT_MAX` (see Finding 1 for why). Two `autocannon`
runs hit `POST /v1/permit` with a real `Scope`/`correlationId` body:

- 50 concurrent connections, 10s, one fixed scope.
- 200 concurrent connections, 15s, a different fixed scope.

Test data (`tenant='loadtest'` rows) was deleted from `breaker_state` after
the run; the temporary server was killed; the normal dev instance and its
data were untouched throughout.

## Findings

### 1. The default rate limit (120 req/60s/token) makes a naive load test measure the limiter, not the route

The first attempt (concurrency 50, default config) returned **0 successful
responses out of 536,653** — all `429 Too Many Requests` after the first
~120 requests exhausted the per-token budget
(`x-ratelimit-limit: 120`, keyed by the `Authorization` header — see
`app.ts`'s rate-limit `keyGenerator`). This is the rate limiter working
exactly as designed, not a defect — but it means load-testing the route
itself requires either many distinct tokens or a raised limit for the test.
Chose the latter (`CONTROL_PLANE_RATE_LIMIT_MAX=1000000`) since it isolates
the variable actually under test (the route's own throughput), and
`config.ts` already documents this exact default as "retained for backward
compatibility... production agents can raise it based on measured permit
throughput" — this test result is that measurement.

### 2. Real throughput/latency at moderate concurrency (50)

| Metric                            | Value              |
| --------------------------------- | ------------------ |
| Requests                          | 65,371 in 10.02s   |
| Throughput                        | 6,538 req/s avg    |
| Latency p50                       | 6 ms               |
| Latency p97.5                     | 17 ms              |
| Latency p99                       | 23 ms              |
| Latency max                       | 109 ms             |
| 2xx / non-2xx / errors / timeouts | 65,371 / 0 / 0 / 0 |

### 3. Higher concurrency (200) shows the real bottleneck: the DB pool, not the route logic — and it degrades gracefully

| Metric          | c=50        | c=200       |
| --------------- | ----------- | ----------- |
| Throughput      | 6,538 req/s | 6,999 req/s |
| Latency p50     | 6 ms        | 25 ms       |
| Latency p97.5   | 17 ms       | 55 ms       |
| Latency p99     | 23 ms       | 85 ms       |
| Latency max     | 109 ms      | 262 ms      |
| Errors/timeouts | 0           | 0           |

Throughput barely improves from c=50 to c=200 (6,538 → 6,999 req/s) while
latency roughly quadruples at every percentile — the signature of
saturating a fixed resource, not CPU-bound route logic. The fixed resource
is almost certainly `dbPoolMax` (default 10,
`services/control-plane/src/config.ts`): 200 concurrent HTTP requests each
needing one Postgres connection for `BreakerStore.permit()` queue behind
only 10 available connections. Critically, **it degrades by queueing, not
failing** — zero errors and zero timeouts at either concurrency level, and
no pool-error warnings in the server log (`pool.on('error', ...)`'s safety
net, `@fuse/breaker-store`'s `createPool`, never fired). A real deployment
expecting more than ~10 concurrent in-flight permit checks per instance
should raise `CONTROL_PLANE_DB_POOL_MAX` accordingly — an operator-tunable
env var already, not a code change this ADR needed to make.

## Consequences

- No code changed as a result of this test — the finding is a tuning
  recommendation (`CONTROL_PLANE_DB_POOL_MAX`,
  `CONTROL_PLANE_RATE_LIMIT_MAX`), not a defect. Both are already
  operator-configurable via env (`config.ts`).
- This is a single-process, single-instance measurement on developer
  hardware, not a production capacity plan — real headroom depends on the
  deployment's actual Postgres instance size and network topology. Recorded
  as a load-bearing caveat in the runbook (task.md §9.3), not silently
  generalized into a capacity guarantee.
- Not tested: sustained load over minutes/hours (memory-leak/connection-leak
  detection), multi-instance horizontal scaling, or a mixed
  permit+trip+resume workload — real, scoped-out gaps for a hackathon
  timeline, tracked in task.md §9.2, not silently assumed covered.
