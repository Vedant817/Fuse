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
- **No repository-provided PostgreSQL backup or audit-log retention job.**
  The Kubernetes base includes an expired-`idempotency_keys` cleanup CronJob,
  but `breaker_audit_log` intentionally has no default deletion window and
  the repository cannot define the operator's legal retention policy.
  Production still requires a managed PostgreSQL backup/PITR policy and a
  rehearsed restore; "restore from backup" assumes those external controls
  were provisioned.
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
- **The checked-in two-replica topology is not a multi-region guarantee.**
  Detector requests carry their complete bounded window, and PostgreSQL
  serializes registration and breaker transitions, so either replica can
  handle a request. The repository has not run a sustained multi-zone soak,
  regional failover, or disaster-recovery exercise. The earlier local load
  test remains a capacity input, not a universal sizing promise.
- **One logical scope needs one authoritative observation stream.** The SDK
  carries at most 200 trailing observations per detector request. Two
  independent agent processes reusing the same
  `tenant/environment/agentId` do not merge their client-side windows;
  allocate distinct `agentId` values or detect the aggregate in SigNoz.
- **Scope onboarding is bounded but has no deletion workflow.** Every
  operational path now rejects unknown scopes, and operator-only
  `/v1/scopes/register` enforces a race-safe per-tenant cap (10,000 by
  default). Registered scopes are durable and there is no deregistration
  endpoint yet; capacity reclamation is an operator/database procedure.
- **Diagnosis and Slack delivery are best-effort after the durable trip.**
  A breaker trip commits before diagnosis starts, so Slack/MCP failure can
  never weaken enforcement. There is no durable notification outbox:
  terminating a process in the small interval after commit can lose that
  incident's Slack notification. The audit row remains authoritative and
  queryable for reconciliation.
- **Container scanning is a release-environment gate, not a checked-in CI
  job.** CI performs dependency audit, SBOM generation, container build,
  hardening checks, and a live container smoke test. A registry scanner must
  still approve the immutable image digest before promotion.
- **The CI workflow exists but has not run on GitHub yet.** The local
  equivalents pass, but `.github/workflows/ci.yml` cannot provide remote
  evidence until the local commits are pushed to the verified personal
  repository and GitHub executes it.

## Where to look for more detail

- `docs/threat-model.md` — the full trust-boundary/risk-register analysis
  these limitations summarize.
- `docs/adr/*.md` — the specific investigation and evidence behind each
  design decision cited above.
- `task.md` — the section-by-section status of what's built vs. explicitly
  scoped out, including deadline-driven deferrals.
