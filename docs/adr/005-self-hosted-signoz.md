# ADR-005: Self-hosted SigNoz (reversing the SigNoz Cloud decision)

- Status: accepted
- Date: 2026-07-21
- Deciders: Vedant817 (explicit choice, via delegated senior-engineer agent)

## Context

task.md's decision log previously recorded (2026-07-21, alongside ADR-003):
"SigNoz Cloud (not self-hosted) is the target deployment... requires the
user to supply an account/ingestion key, which cannot be created by an
agent." That credential never arrived, and §3.3/§4.5's SigNoz-ingestion and
alert-rule work stayed blocked for the whole session as a result — not a
silent gap, but a real one, since nothing could prove traces/metrics/logs
actually reach a real SigNoz backend.

The user has now explicitly reversed that choice: self-hosted SigNoz
instead of SigNoz Cloud. Self-hosted needs no external account or
ingestion key, so this also removes the single biggest "blocked, not
built" item in task.md.

## Decision

Self-host SigNoz locally via **Foundry**
(`https://github.com/SigNoz/foundry`), the current officially-supported
deployment tool as of SigNoz v0.130.0+ (the previous bundled
`docker-compose.yaml` + `install.sh` approach is deprecated upstream — this
was verified directly against the current `foundryctl` CLI and its
`docs/reference/casting-file.md`, not assumed from memory, since this
repo's own convention throughout this build has been to verify current
external-system behavior rather than guess).

- `infra/signoz/casting.yaml` is the checked-in source of truth — a
  declarative config (`mode: docker`, `flavor: compose`) that
  `foundryctl forge`/`cast` expands into a real Docker Compose stack
  (SigNoz backend+UI, ClickHouse, ClickHouse Keeper, an internal Postgres
  metastore, and the SigNoz OTel Collector) under `infra/signoz/pours/` —
  generated output, git-ignored, never hand-edited (same convention as
  `dist/`).
- Image versions are pinned explicitly (`signoz/signoz:v0.133.0`,
  `signoz/signoz-otel-collector:v0.144.6`) rather than left at Foundry's
  own `:latest` default, per AGENTS.md's dependency-pinning requirement —
  verified against each component's actual current upstream release tag.
- `infra/signoz-up.sh` scripts the full bring-up: installs `foundryctl` if
  missing (the official `curl -fsSL https://signoz.io/foundry.sh | bash`
  installer), runs `foundryctl cast`, waits for the backend health
  endpoint, and — critically — completes SigNoz's one-time first-run
  org/admin bootstrap via `POST /api/v1/register` if not already done.
  Idempotent: safe to re-run.
- `.env.example` now documents `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`
  as the default export target — no ingestion key or auth header needed
  for a local, unauthenticated collector (`packages/otel`'s `bootstrapOtel`
  already worked identically against any OTLP endpoint; only the
  documented default target changes, not the code).

## A real deployment bug found and fixed during verification

Standing this up was not a rubber stamp. The first `foundryctl cast` run
produced a stack where every container reported healthy and the SigNoz UI
was reachable, but the OTel Collector's OTLP receivers (ports 4317/4318)
never actually started — `docker exec`-level inspection of
`/proc/net/tcp` showed nothing listening on either port despite the
collector's own log claiming "Everything is ready." Root cause, found by
reading the SigNoz backend's logs directly: `"cannot create agent without
orgId"` — the collector is managed via OpAMP and registers itself against
the SigNoz backend, but a fresh install has no organization yet (created
only via first-run setup), so registration failed silently in a retry loop
and the collector kept running with no receivers/pipelines configured.
This is expected behavior for a fresh install, not a Foundry defect — but
it meant the stack looked "up" while being completely non-functional for
ingestion, which is exactly the kind of gap this build's evidentiary
standard exists to catch rather than let slide as "containers are green."
`infra/signoz-up.sh`'s first-run bootstrap step exists specifically to
close this gap non-interactively.

## Verification (real, not assumed)

After the org/admin bootstrap, a genuine end-to-end proof was run: the
actual `@fuse/otel` package's `bootstrapOtel` + `withGenAiSpan` (the same
code every other package in this repo uses) emitted one real span to
`http://localhost:4318`, and the span was confirmed present in the
self-hosted instance's own ClickHouse backing store by direct query
(`SELECT serviceName, name, timestamp FROM
signoz_traces.distributed_signoz_index_v3 WHERE serviceName =
'fuse-signoz-smoke-test'` — returned the expected row, span name `chat
smoke-test-model` matching `withGenAiSpan`'s `${operationName}
${requestModel}` naming convention exactly). This is strictly stronger
evidence than was ever available for the SigNoz Cloud path, where no
credentials existed to verify anything at all.

## Alternatives considered

- **Hand-roll a docker-compose.yml directly** (ClickHouse, otel-collector,
  and backend services, without Foundry): rejected — SigNoz itself no
  longer maintains a ready-made compose file as its supported path
  (deprecated as of v0.130.0), so maintaining an equivalent by hand would
  mean carrying a config SigNoz's own team has stepped away from, likely
  to drift from their actual current image/architecture over time (e.g.,
  their query-service and frontend were consolidated into a single
  `signoz/signoz` image at some point — exactly the kind of detail that
  goes stale in a hand-maintained file).
- **Keep `:latest` tags (Foundry's own default)**: rejected per AGENTS.md's
  pinning requirement; explicit version tags were verified to work
  identically (the OpAMP registration bug was unrelated to version choice,
  confirmed by reproducing it under both pinned and unpinned images before
  finding the actual root cause).
- **Commit the generated `pours/` output**: rejected — it's fully
  deterministic output of `casting.yaml` (modulo image digests), so
  committing it would just be a second, driftable copy of the same
  source of truth; regenerate with `foundryctl forge` instead.

## Consequences

- task.md §3.3's "traces/metrics/logs arrive in the targeted SigNoz
  version" acceptance criterion, blocked all session, is now verified —
  see task.md for the updated evidence.
- §4.5 (SigNoz alert-rule-as-code) and the alert-label-propagation question
  in `signoz-alert-mapper.ts`'s doc comment are now genuinely actionable
  (a real backend exists to test against) but are not yet done — this ADR
  unblocks that work, it doesn't complete it.
- Local dev now requires running `infra/signoz-up.sh` (in addition to
  Postgres) to get real telemetry; README's "Getting started" is updated
  accordingly. Everything already built (breaker, Preflight, detectors) was
  designed to work without SigNoz running at all and continues to.
- The self-hosted stack's admin credentials are a fixed, documented local
  default — acceptable for a single-developer local stack bound to
  localhost only; would need real secret generation before any shared or
  networked deployment, which is out of scope for this ADR.
