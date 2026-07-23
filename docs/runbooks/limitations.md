# Fuse limitations and non-guarantees

Status: living document, first written 2026-07-23 (task.md §9.3). This is
the single place a new operator or judge should read to know what Fuse does
**not** promise — every item below is either a documented design tradeoff
(cited to its ADR) or a real gap found during this project's own testing
(cited to its evidence), not speculation.

## What Fuse does guarantee

- **Zero provider calls after a committed trip.** This is the one
  guarantee that holds independent of everything else on this page —
  proven under both sequential and concurrent load
  (`packages/sdk/src/guard.integration.test.ts`), including the
  in-flight-exposure edge case (a call already past its permit check when
  the trip commits may still complete — measured and documented, not
  hidden).
- **Honest reporting when telemetry can't be trusted.** Preflight reports
  `blind`/`degraded` rather than silently assuming `protected` when
  coverage/freshness/orphan-rate thresholds are crossed — this is the
  project's core differentiator per `AGENTS.md`/task.md, and it is a
  reporting guarantee, not an enforcement one (see below).

## What Fuse does NOT guarantee

- **A `blind` Preflight state does not itself stop enforcement.** The
  breaker's own armed/tripped/disabled state is independent of Preflight's
  protected/degraded/blind/disabled state by design — see
  `docs/runbooks/incident-response.md`'s telemetry-outage entry. A scope
  can be genuinely blind (no reliable signal) while its breaker sits
  `armed`, providing no real detector-driven protection during that window.
  Treat a `blind` report as an incident requiring investigation, not as
  Fuse having "handled it."
- **A fresh, forged webhook alert from a valid webhook token is not
  detected.** SigNoz has no payload-signing option (verified against its
  docs, not assumed) — the staleness/clock-skew guard
  (`CONTROL_PLANE_WEBHOOK_MAX_ALERT_AGE_MS`) stops a _replayed_ old alert,
  not a _new_ one an attacker with a valid webhook token chooses to send.
  Impact is fail-safe only (a forged alert can only cause a trip, never a
  resume/disable/enable) — `docs/threat-model.md` §3/§9 risk #2b.
- **Tokens are flat roles, not per-tenant credentials, unless you opt in.**
  A plain (unscoped) token is valid for every tenant on the deployment — the
  `tenant:token` form (`docs/adr/004-tenant-scoped-tokens.md`) must be
  explicitly configured per tenant to change this. A leaked wildcard token
  affects every tenant sharing that deployment.
- **No online key rotation or per-token expiry.** Rotating any token
  requires an env-var change and a process restart
  (`docs/runbooks/operations.md` §5); a leaked token stays valid until an
  operator notices and rotates it.
- **No automated backup/retention job for the state store.** Neither
  `breaker_audit_log` nor `idempotency_keys` is ever automatically pruned
  (`docs/runbooks/operations.md` §6) — both grow unbounded until an
  operator sets up a retention job. There is also no automated Postgres
  backup — "restore from backup" in the rollback runbook assumes you built
  one yourself.
- **No scripted schema rollback.** Migrations are forward-only
  (`docs/runbooks/operations.md` §4) — reverting a bad schema change means
  a manual reverse migration or a backup restore, not a one-command
  rollback.
- **Estimated cost, not reconciled billing.** `fuse.estimated_cost.usd.total`
  (the dashboard's spend panel, `packages/otel/src/pricing.ts`) is computed
  from a local pricing table against reported token counts — it is not
  reconciled against your actual provider invoice, and will drift from
  real billing if the pricing table goes stale or a provider changes its
  rates.
- **No true latency percentiles for `gen_ai` histograms on the dashboard.**
  `docs/adr/008-signoz-dashboard-provisioning.md` documents that SigNoz
  stores histogram sub-metrics (`.sum`/`.count`/`.bucket`) separately; the
  shipped dashboard queries `.sum` (a total), not a computed p95/p99 from
  `.bucket` — an honest simplification, not a hidden gap.
- **Single-process, single-Postgres-instance capacity, not a production
  scaling story.** `docs/adr/011-permit-load-test.md`'s load test measured
  one control-plane process against one local Postgres instance on
  developer hardware (~6.5–7k permit checks/s, DB pool as the bottleneck at
  higher concurrency, zero errors observed). No multi-instance horizontal
  scaling, sustained-hours soak testing, or real network-topology
  (reverse-proxy, TLS termination, multi-region) testing has been done.
- **Detector telemetry buffers are in-memory and per-process.**
  `DetectorRunner`'s trailing-window state (task.md §4) is lost on a
  control-plane restart — the next few reported steps rebuild it, which is
  an accepted characteristic, not a durability guarantee. It is bounded
  (per-scope: 500 steps / 1 hour; total distinct scopes: 10,000 with LRU
  eviction, `docs/adr/012-failure-injection-review.md`) but not persisted.
- **No SAST/container-image scanning has been run.** `docs/adr/009-supply-
chain-scan.md` covers dependency vulnerabilities, licenses, secrets, and
  an SBOM — but no static-analysis security scan and no container-image
  scan (this project builds no image of its own; only third-party images
  referenced in `infra/docker-compose.yml` are used, pinned by tag).
- **No CI pipeline exists.** Every check in this project (`pnpm run check`,
  the load test, the security scans) was run manually and evidenced in
  `docs/adr/*.md` — none of it is automated to run on every change yet.

## Where to look for more detail

- `docs/threat-model.md` — the full trust-boundary/risk-register analysis
  these limitations summarize.
- `docs/adr/*.md` — the specific investigation and evidence behind each
  design decision cited above.
- `task.md` — the section-by-section status of what's built vs. explicitly
  scoped out, including deadline-driven deferrals.
