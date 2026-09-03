# Changelog

All notable changes to Fuse are documented here. The project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Immutable, non-root control-plane image and a two-replica Kubernetes base
  with TLS ingress, probes, PDB, NetworkPolicy, migration Job, and expired
  idempotency-key cleanup.
- Read-only CI permissions with clean install, format/lint/build/typecheck,
  unit/integration/coverage gates, production dependency audit, CycloneDX
  SBOM, and hardened container smoke testing.
- Operator-only scope registration with a race-safe configurable per-tenant
  ceiling; all operational paths now reject unknown scope tuples.
- Startup-validated detector policy loading, exact/wildcard specificity,
  per-scope outage behavior, supported notification-route validation, and
  operator-only effective-policy inspection.
- Direct SDK detector enforcement: the SDK carries a bounded complete window,
  the control plane commits a trip before acknowledging a firing observation,
  and the next guarded provider call is denied.
- Exporter-confirmed Preflight evidence with ordered source-instance sequences;
  span creation alone can no longer produce a `protected` result.
- Epoch-bound SigNoz detector metrics and webhook fallback. Delayed alerts from
  an earlier breaker episode are rejected after resume.
- Durable PostgreSQL diagnosis delivery with leasing, renewal, bounded retry and
  jitter, dead-letter status, operator listing, and audited idempotent replay.
- Slack resume authorization by request freshness/signature, user allowlist,
  optional workspace, tenant-appropriate operator token, and trip epoch.
- Publishable `@fuse/contracts`, `@fuse/otel`, and `@fuse/sdk` tarballs plus an
  isolated external-consumer packaging test.
- A manual release workflow that verifies the full suite and publishes
  immutable `linux/amd64` and `linux/arm64` images to GHCR, plus an OCI
  Always Free personal-deployment Compose definition and runbook.
- Manual-only, protected-environment release promotion from `main`: both
  architectures are smoke-tested and vulnerability-scanned, assembled under
  run-specific staging tags, covered by validated workspace/image SBOMs and
  digest-bound attestations, then promoted to version, commit, and stable
  `latest` aliases as the final operation. Exact-digest reruns are idempotent;
  conflicting immutable aliases fail closed.

### Fixed

- Removed the unsupported unscoped detector-observation compatibility payload;
  public observations now require `executionId` and explicit `pricingStatus`.
- Expanded the isolated tarball consumer gate to prove default `runStep`
  detection/enforcement, real localhost OTLP export, exporter evidence, public
  declarations, and supported SDK subpath exports without disabling reporting.
- Prevented low-token normal conversations from triggering context-growth
  detection solely because a tiny starting value increased by a large ratio.
- Prevented duplicate Slack incident cards when two replicas receive the same
  idempotent detector trip concurrently.
- Enforced tenant binding for grouped SigNoz webhooks; tenant-scoped tokens
  reject missing, mixed, or cross-tenant batches.
- Updated an existing SigNoz webhook channel during provisioning so token/URL
  rotation actually takes effect.
- Removed fabricated `score=1/threshold=1` wording from webhook-driven
  diagnosis when SigNoz did not supply the original detector measurement.
- Serialized concurrent migration runners and remediated all currently known
  production dependency advisories.
- Wired the already-implemented Slack Resume action into real diagnosis
  messages. The button is emitted only when Slack request signing and a
  tenant-matching operator credential make the complete action usable.
- Fixed migrations silently never running in any deployed container: the
  CLI-entry check compared an unresolved invocation path against a
  symlink-resolved `import.meta.url`, which `pnpm deploy`'s production
  `node_modules/.pnpm/...` layout always mismatches. The migrate script now
  exits `0` with real applied migrations, not a silent no-op.
- Updated Fastify's transitive `find-my-way` router from 9.6.0 to 9.7.0 to
  remediate GHSA-c96f-x56v-gq3h (HTTP/2 denial of service).
- Remediated 12 production advisories reported by `pnpm audit --prod`:
  Fastify to 5.12.1 (GHSA-w2qp-rph6-63g4, GHSA-3m5p-2c4r-xxw2), `fast-uri`
  to 3.1.6/4.1.3 via workspace overrides (GHSA-5jgf-p345-68v8,
  GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp), and `qs`
  to 6.16.0 via workspace override (GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g).
- Hardened integration-test teardown: suite-level Postgres pools now record
  mid-test idle-client errors (still failing the suite) while ignoring the
  teardown window where container SIGTERM (57P01) after `pool.end()` is
  benign, fixing CI unhandled-error failures with all tests passing.
- Corrected `demo:real-detect` to attribute the low-latency stop to the direct
  detector trip, prove zero provider dispatches on the next guarded call, and
  describe SigNoz as asynchronous corroboration/fallback.

### Operational notes

- Production requires externally managed PostgreSQL backups/PITR, real
  hostname/TLS and secret-manager values, an immutable registry digest plus
  image scan, and monitored alert destinations.
- Breaker, audit, and diagnosis-job acceptance are transactional. Diagnosis
  delivery is at-least-once and may require operator replay from dead-letter.
- Schema migrations are forward-only. See
  `docs/runbooks/deployment.md` and `docs/runbooks/limitations.md` before
  promotion.

## [0.1.0] - 2026-07-23

Initial hackathon implementation: PostgreSQL breaker state machine, pre-call
SDK enforcement, OTel instrumentation, three detectors, Preflight telemetry
health, self-hosted SigNoz alerts/dashboard/MCP evidence, Slack incident
actions, and the broken-agent demonstration.
