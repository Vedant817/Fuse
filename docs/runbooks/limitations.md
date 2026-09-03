# Fuse Limitations and Non-Guarantees

Read this before production evaluation. Fuse is pre-1.0 and has no published
SLA, customer outcome study, or production-scale longitudinal evidence.

## What Is Enforced

After a breaker trip commits, a subsequent `FuseGuard` permit check for that
exact scope is denied before its provider callback. This behavior is covered by
sequential, concurrent, and real-PostgreSQL integration tests.

That statement has important boundaries:

- A provider call that bypasses `FuseGuard` is not protected.
- A call already past permit when the trip commits may complete.
- A process can choose fail-open for control-plane or store outages.
- Preflight `blind` or `degraded` is a telemetry warning, not an automatic
  trip.
- A logically shared scope needs one authoritative SDK observation stream;
  separate processes do not merge their client-side windows.

## Detection

- Detector defaults are engineering hypotheses, not validated optimal
  thresholds. Useful repetitive or long-running work can produce false
  positives; novel runaway shapes can produce false negatives.
- No precision, recall, false-positive rate, or avoided-cost benchmark has yet
  been measured on customer workloads.
- The SDK carries at most 200 trailing observations. Behavior outside that
  window is not available to direct evaluation.
- Cost velocity uses a local model-pricing table and token counts. It is an
  estimate, not invoice reconciliation.
- Canonical step fingerprints reduce content exposure but can collide or merge
  semantically different work. Progress labels and policy tuning remain the
  integrator's responsibility.

## Telemetry and SigNoz

- `protected` requires success reported through the separate exact-scope
  exporter-evidence capability and fresh structural evidence. It does not prove
  SigNoz retention, query correctness, dashboard availability, or alert
  delivery end to end.
- The exporter bearer token is not cryptographic attestation. The supported
  in-process runtime lets a fully compromised agent read that credential and
  forge success. Isolate the exporter process and secret to exclude that actor.
- SigNoz fallback is asynchronous. Evaluation and notification cadence can be
  materially slower than direct enforcement and must be measured per
  deployment.
- An alert without a valid source breaker epoch is non-enforcing. A delayed
  alert for an old epoch cannot re-trip a resumed scope.
- SigNoz webhook payloads are bearer-authenticated but not HMAC-signed by
  SigNoz. A holder of a valid webhook token can create a fresh trip attempt for
  an authorized registered scope. The token cannot resume or disable.
- The supplied dashboard does not provide true histogram p95/p99 calculations
  for all panels.

## Availability and Scale

- Fail-closed protects cost but can turn a PostgreSQL, Redis, network, or
  control-plane outage into an agent availability incident.
- The checked-in two-replica topology has not completed multi-zone soak,
  regional failover, disaster-recovery, or formal capacity certification.
- Production requires shared Redis. Local in-memory rate limiting is not safe
  across replicas.
- The global token-keyed rate limit is shared across routes; a noisy caller can
  consume permit capacity unless credentials and limits are sized correctly.
- Registered scopes have a configurable per-tenant cap but no public deletion
  workflow.

## Delivery and Operations

- Diagnosis delivery is durable and at-least-once, not exactly-once. Leases,
  deterministic Slack message IDs, retries, and replay reduce duplicates but
  cannot prove an external provider will never duplicate a side effect.
- MCP, filesystem, or Slack failure can exhaust retries and dead-letter a job.
  Enforcement remains committed, but an operator must inspect and replay.
- Local incident snapshots in the hardened container use ephemeral `/tmp`.
- Migrations are forward-only. There are no repository-provided down
  migrations.
- Migration checksums detect drift only after the one-time upgrade from the
  legacy ID-only ledger. That backfill necessarily trusts the migration files
  in the upgrade image because no earlier checksum exists to compare.
- The repository does not provision production PostgreSQL backup/PITR, audit
  retention, Redis HA, SigNoz HA, TLS certificates, or secret rotation.
- Bearer tokens have no online revocation or expiry. Rotation requires a
  configuration rollout.
- `/healthz` proves only process liveness and deliberately ignores Redis and
  PostgreSQL. `/readyz` proves a bounded rate-limit Redis `PING`, PostgreSQL,
  and schema readiness, not SigNoz, Slack, MCP, or provider health.

## Security and Privacy

- Production agent and exporter-evidence credentials are exact-scope, separate,
  and non-reusable. Operator and webhook credentials can be tenant-bound or
  explicit wildcards. A wildcard increases blast radius.
- Static bearer tokens must be protected by TLS and a secret manager.
- Supplied OTel instrumentation excludes raw prompts, completions, and tool
  arguments. Integrators can still attach sensitive attributes through other
  instrumentation; Fuse cannot redact data it does not own.
- Audit reasons are persisted free text. Do not put secrets, prompts, or
  personal data in them.
- Dependency audits and SBOMs are point-in-time evidence, not proof of no
  vulnerabilities.

## Commercial Evidence Still Required

- Three or more real design partners with signed telemetry/privacy terms.
- Baseline versus Fuse measurements for incidents, spend, and operator time.
- Detector quality segmented by agent/workload type.
- Production reliability, latency, recovery, and support evidence.
- Willingness-to-pay and buyer validation.

See the [pilot plan](../design-partner-pilot.md),
[threat model](../threat-model.md), and
[incident response runbook](./incident-response.md).
