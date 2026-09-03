# Fuse Operations Runbook

This runbook covers installation, routine checks, diagnosis delivery, policy,
credentials, retention, and recovery. Production deployment steps are in
[deployment.md](./deployment.md).

## Install and Start

```bash
pnpm install
set -a; source .env; set +a
docker compose -f infra/docker-compose.yml up -d postgres
pnpm --filter @fuse/breaker-store run migrate
pnpm --filter @fuse/control-plane run build
pnpm --filter @fuse/control-plane run start
```

Expected probes:

```bash
curl --fail http://localhost:8090/healthz
curl --fail http://localhost:8090/readyz
```

`/healthz` is liveness only and bypasses limiter storage, so it remains 200
while Redis or PostgreSQL is unavailable. `/readyz` performs a bounded Redis
`PING`, then checks PostgreSQL, required columns, and the exact IDs and SHA-256
checksums of all eight migration ledger entries. A 503 reason is
`rate_limit_store_unavailable`, `store_unavailable`, or `schema_not_ready`.

## Required Production Configuration

- `DATABASE_URL`: TLS PostgreSQL with backups and PITR.
- `CONTROL_PLANE_API_TOKENS`: operator credentials; prefer `tenant:token`.
- `CONTROL_PLANE_AGENT_API_TOKENS`: exact
  `tenant:environment:agentId:token` entries. Production rejects legacy and
  wildcard forms.
- `CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS`: separate exact-scope entries for
  exporter delivery evidence. Production rejects missing, partial, wildcard,
  and raw-token-reused entries. The matching exporter receives only the raw
  token as `FUSE_PREFLIGHT_EXPORTER_TOKEN`.
- `CONTROL_PLANE_WEBHOOK_TOKENS`: tenant-bound where each channel is
  single-tenant; wildcard only for an intentional shared channel.
- `CONTROL_PLANE_DETECTOR_POLICY_FILE`: immutable, validated policy JSON.
- `CONTROL_PLANE_RATE_LIMIT_REDIS_URL`: shared `redis://` or `rediss://`
  endpoint. Production refuses to start without a connected client.
- Standard `OTEL_EXPORTER_OTLP_*` settings for the collector.

Every production bearer credential must contain at least 32 bytes. Generate
each role independently with `openssl rand -hex 32`; `loadConfig` rejects
shorter values. Validate a prepared runtime file without printing its values:

```bash
pnpm --filter @fuse/control-plane run build
pnpm run validate:production-env -- /etc/fuse/control-plane.env
```

Use distinct `fuse_runtime`, `fuse_migrator`, and `fuse_maintenance` database
roles and separate secrets. Runtime receives DML only, migration receives DDL,
and maintenance receives only `SELECT, DELETE` on `idempotency_keys`; see the
deployment runbook for external PostgreSQL grants.

Optional diagnosis/Slack settings are documented in `.env.example`. A Slack
resume requires all of `SLACK_SIGNING_SECRET`, `SLACK_AUTHORIZED_USER_IDS`, an
optional matching `SLACK_TEAM_ID`, and an operator token usable for the
incident tenant.

## Migrations

The forward-only migration runner holds a PostgreSQL advisory lock, applies
each file in its own transaction, and records its ID and SHA-256 content checksum
in `schema_migrations`. Before applying anything, every existing ledger checksum
must match the migration file in the running image; missing or altered historical
files fail closed. The first upgrade from the legacy ID-only ledger adds the
checksum column under the same lock, backfills nulls from that image once, and
makes the column non-null. Because no earlier digest exists, operators must
verify the image provenance and migration files before that one-time upgrade.
Never edit an applied SQL file; add a new forward migration instead.
Current order:

1. `0001_init.sql`
2. `0002_preflight.sql`
3. `0003_scope_registry.sql`
4. `0004_preflight_evidence_order.sql`
5. `0005_diagnosis_jobs.sql`
6. `0006_preflight_exporter_order.sql`
7. `0007_diagnosis_job_replays.sql`
8. `0008_preflight_source_evidence.sql`

Run before each application rollout:

```bash
pnpm --filter @fuse/breaker-store run migrate
```

Take and verify a restorable backup first. There are no down migrations. Never
run `infra/reset.sh` outside disposable local development.

## Scope and Policy Operations

Register each scope through `POST /v1/scopes/register` before agent traffic.
Inspect the loaded policy with:

```bash
curl -H "Authorization: Bearer $OPERATOR_TOKEN" \
  "http://localhost:8090/v1/policies/effective?tenant=T&environment=E&agentId=A"
```

Policy is loaded once at startup. Roll forward or back by mounting an immutable
reviewed file and performing a rolling restart. A production request with no
matching policy fails rather than using hidden defaults.

Review false positives and missed trips before changing thresholds. Store the
policy version with the incident and use staged canary scopes.

## Breaker and Audit Operations

Check state:

```bash
curl -H "Authorization: Bearer $OPERATOR_TOKEN" \
  "http://localhost:8090/v1/breaker/status?tenant=T&environment=E&agentId=A"
```

Every transition requires actor, reason, correlation ID, and idempotency key.
Use `expectedEpoch` for operator automation so a stale action cannot target a
new incident.

Retrieve the durable audit trail:

```sql
SELECT id, created_at, from_state, to_state, epoch_before, epoch_after,
       actor_type, actor_id, reason, correlation_id, policy_version, noop
FROM breaker_audit_log
WHERE tenant = 'T' AND environment = 'E' AND agent_id = 'A'
ORDER BY created_at DESC
LIMIT 100;
```

## Diagnosis Queue

Monitor these low-cardinality metrics:

- `fuse.diagnosis.queue.jobs` by `pending`, `running`, or `dead-letter`;
- `fuse.diagnosis.delivery.attempts` by bounded outcome;
- `fuse.diagnosis.delivery.latency` by bounded outcome.

List jobs:

```bash
curl -H "Authorization: Bearer $OPERATOR_TOKEN" \
  "http://localhost:8090/v1/diagnosis/jobs?tenant=T&status=dead-letter&limit=50"
```

Replay only after fixing the underlying MCP, filesystem, or Slack failure:

```bash
curl -X POST -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  "http://localhost:8090/v1/diagnosis/jobs/$AUDIT_EVENT_ID/replay" \
  -d '{
    "scope":{"tenant":"T","environment":"E","agentId":"A"},
    "actor":{"type":"manual","id":"operator:on-call"},
    "reason":"dependency restored and delivery verified",
    "idempotencyKey":"diagnosis-replay-unique-id"
  }'
```

Only `dead-letter` jobs can replay. Replays are tenant-bound, idempotent, and
audited separately from breaker state.

## Preflight Operations

Alert when a production scope is `blind`, remains `degraded`, or has an old
`lastGoodAt`. Use the reason code to distinguish:

- missing fields or orphan spans;
- exporter delivery unconfirmed, failed, or stale;
- no recent telemetry or stale evidence;
- operator-disabled monitoring;
- recovery hysteresis.

Fix exporter delivery and instrumentation rather than widening thresholds just
to restore green status. A `protected` result is not a substitute for a direct
end-to-end canary.

## Credential Rotation

Tokens are loaded at startup and have no online expiry:

1. Add a new credential alongside the old credential.
2. Roll the control plane and verify both.
3. Move the caller to the new credential.
4. Remove the old credential and roll again.
5. Review audit events and failed-auth metrics.

Use a different token per agent scope in production. Never put a
`tenant:environment:agentId:token` configuration entry into an Authorization
header; callers send only the token portion.

## Rate Limiting and Capacity

Size `CONTROL_PLANE_RATE_LIMIT_MAX` above peak aggregate request volume per
credential. A 429 is treated by the SDK as control-plane unavailability and
therefore follows its outage policy. Redis command errors fail normal API
requests closed with HTTP 503 `store_unavailable` and the request correlation ID;
the route handler is not entered. During an incident, `/healthz` remains live and
`/readyz` returns structured `rate_limit_store_unavailable`; the same process
reconnects and becomes ready after Redis recovers. Route or framework failures
outside the limiter retain their own error contracts and are not reported as a
Redis outage. Monitor Redis errors and 429 saturation.

Size `CONTROL_PLANE_DB_POOL_MAX` within the PostgreSQL connection budget. Load
test the exact deployment; historical local measurements are not capacity
promises.

## Provisional Operational SLOs

The checked-in `v1-provisional` objectives are startup guardrails, not SLOs
derived from production history. Review them after 30 days of representative
traffic and version any target change rather than silently editing the meaning
of an existing incident. The 50 ms permit target is above the local c=50 p99
measurement in ADR-011, but that developer-host result is not a production
capacity promise.

| Surface              | Provisional objective                                                | Alert opening condition                                                                               |
| -------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Permit               | p95 <= 50 ms; degraded/server-error ratio <= 0.1%; deny p95 <= 50 ms | 5 minute rolling rules; latency must remain high for the full window, error ratio fires on one breach |
| Detector observation | p95 <= 100 ms; rejected/error ratio <= 1%                            | 5 minute rolling latency/error rules                                                                  |
| SigNoz webhook       | zero auth failures; non-auth processing failure ratio <= 1%          | any 401/403 in 5 minutes; one processing-ratio breach                                                 |
| Diagnosis            | pending jobs <= 100; zero dead letters; zero lease-renewal failures  | backlog above 100 for 10 minutes; any dead letter or renewal failure                                  |
| Rate-limit Redis     | every readiness sample is `1`                                        | any `0`, or five consecutive SigNoz evaluations with no readiness metric                              |
| Preflight            | zero committed `stale`/`no_data` evaluations; every sweep healthy    | any stale/no-data evaluation or failed sweep; five absent sweep evaluations also open                 |

Artifacts are versioned in
`infra/signoz/alerts/operational-slos-v1-provisional.json`. They use the SigNoz
`v5`/`v2alpha1` schema tested against the repository's pinned SigNoz v0.133.0.
`pnpm run test:signoz-alerts` statically proves that every queried metric is
defined by `packages/otel/src/metrics.ts`, all thresholds route only to
`fuse-operations`, and no infrastructure rule carries tenant/agent/source-epoch
grouping.

### Episode semantics

- Traffic-driven permit, detector, webhook, diagnosis lease-failure, and
  Preflight-state rules set `alertOnAbsent: false`. No calls or incidents can
  be legitimate idle time and must not become a no-data page.
- Diagnosis queue depth, Redis readiness, and Preflight sweep health are
  continuously sampled operational signals. They set `alertOnAbsent: true`,
  `absentFor: 5`, and renotify for both `firing` and `nodata` states.
- Threshold incidents resolve when the rolling condition clears. Diagnosis
  no-data resolves after queue samples resume within target; Redis/sweeper
  no-data resolves only after a healthy `1` sample is evaluated.
- `infra/signoz/channels/fuse-operations.json` sets `send_resolved: true`.
  Resolution is an operator notification only: it never resumes a breaker,
  replays diagnosis work, or changes Preflight state.

### Cardinality contract

Operational SLO series are infrastructure-wide. They never include tenant,
environment, agent, execution, source epoch, alert fingerprint, job ID, token,
or correlation labels. Permitted dimensions are finite enums:

- `fuse.slo.version`: one active value per deployed release;
- `fuse.outcome`: at most five permit outcomes or four HTTP outcomes;
- diagnosis status/outcome: three/four values; lease reason: two values;
- Preflight health class/source: six/four values.

Per-scope product metrics such as `fuse.preflight.self_alert.active` remain
separate. Their scope count is bounded operationally by the registered-scope
cap (default 10,000 per tenant); they are not inputs to infrastructure-wide SLO
rules. Investigate a page using scoped traces/audit rows only after the broad
signal opens.

### Triage

1. Confirm the alert state is `firing` versus `nodata` and record its
   `fuse_slo_version`.
2. Compare `/healthz` and `/readyz`; a live/unready process indicates a
   dependency failure, not a dead process.
3. For permit/detector/webhook errors, inspect bounded outcome series and
   correlated server logs. Do not treat deny responses as errors.
4. For diagnosis, inspect pending/dead-letter jobs through the authenticated
   API before replaying anything.
5. For Preflight, distinguish committed stale/no-data scope health from a dead
   sweeper. Fix telemetry delivery rather than weakening thresholds.
6. Resolve the dependency and verify the checked-in rule emits a resolved
   notification. Do not manually close an incident while its metric remains
   unhealthy.

## Retention and Backup

Schedule deletion of expired idempotency records:

```sql
DELETE FROM idempotency_keys WHERE expires_at < now();
```

The running Preflight sweeper automatically deletes
`preflight_source_evidence` in capped batches. A source is active for twice
`preflightMaxEvidenceStalenessMs`; deletion eligibility is four times that
configured staleness, leaving one additional complete active-source TTL as a
safety window. Selection uses PostgreSQL time and `FOR UPDATE SKIP LOCKED`, so
active/refreshed rows are retained and multiple control-plane replicas can share
cleanup without duplicate ownership or unbounded lock waits. Repeated sweeps
eventually drain restart-created source rows while each pass remains capped at
the configured sweep batch size (default 100, maximum 1,000).

Define explicit retention for breaker audit, replay audit, diagnosis jobs, and
SigNoz telemetry. Preserve records required for incident and compliance review
before deletion. Configure managed PostgreSQL backups/PITR and rehearse restore.

## Graceful Shutdown

Use SIGTERM/SIGINT. The server stops new HTTP work, drains diagnosis attempts,
closes Redis and PostgreSQL, and flushes OTel. Avoid hard process termination;
leases allow recovery, but a hard kill increases duplicate-delivery risk.

## Rollback

For code-only rollback, deploy the previous immutable image digest and repeat
readiness plus the trip/blocked-next-call canary. If schema compatibility is in
doubt, restore the verified pre-migration backup into a new database, test it,
then switch `DATABASE_URL`. Do not overwrite the current database first.
