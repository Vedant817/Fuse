# Fuse Incident Response

Start every incident by recording UTC time, scope, breaker epoch, correlation
ID, policy version, Preflight state/reason, and the operator identity. Never put
prompts, secrets, or personal data in the audit reason.

## Initial Triage

```bash
curl -H "Authorization: Bearer $OPERATOR_TOKEN" \
  "http://localhost:8090/v1/breaker/status?tenant=T&environment=E&agentId=A"
curl -H "Authorization: Bearer $AGENT_OR_OPERATOR_TOKEN" \
  "http://localhost:8090/v1/preflight/status?tenant=T&environment=E&agentId=A"
curl -H "Authorization: Bearer $OPERATOR_TOKEN" \
  "http://localhost:8090/v1/diagnosis/jobs?tenant=T&environment=E&agentId=A"
```

Breaker state (`armed`, `tripped`, `disabled`) and Preflight state
(`protected`, `degraded`, `blind`, `disabled`) are separate axes.

## Runaway Agent or Valid Trip

1. Confirm the provider path is guarded and no bypass exists.
2. Stop or isolate additional agent replicas using the same logical scope.
3. Inspect breaker audit, detector result, policy version, and SigNoz evidence.
4. Check for already-permitted in-flight calls; Fuse does not cancel them.
5. Fix or bound the agent behavior before resume.
6. Resume with a manual actor, specific reason, unique idempotency key, and the
   expected trip epoch.
7. Confirm the new epoch is armed and run one controlled canary call.

## Suspected False Positive

Do not resume from the alert title alone. Review the bounded step shape,
detector score/threshold, trace evidence, and business intent. If safe, resume:

```bash
curl -X POST -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  http://localhost:8090/v1/breaker/resume \
  -d '{
    "scope":{"tenant":"T","environment":"E","agentId":"A"},
    "reason":"confirmed false positive: bounded polling was expected",
    "actor":{"type":"manual","id":"operator:on-call"},
    "correlationId":"incident-correlation-id",
    "idempotencyKey":"resume-unique-id",
    "expectedEpoch":1
  }'
```

Recurring false positives require a reviewed policy change and canary, not a
habitual resume procedure.

## Missed Trip

1. Verify every provider dispatch used `FuseGuard`.
2. Inspect Preflight. `blind` or `degraded` means detector silence was not
   trustworthy.
3. Check step-report failures. The reporter defaults fail-closed and latches
   subsequent guarded calls when a detector observation cannot be durably
   evaluated, but an integration can still bypass or misconfigure it.
4. Compare the bounded observation window with the effective policy.
5. Confirm the scope was registered and the exact-scope credential matched.
6. Check direct route latency/errors separately from SigNoz fallback timing.
7. Preserve evidence and add a regression fixture before changing thresholds.

## Telemetry Blind or Exporter Failure

Reason codes `exporter-delivery-unconfirmed`, `exporter-delivery-failed`, and
`exporter-delivery-stale` indicate the real OTLP export path is not currently
proven. Check collector reachability, credentials, TLS, exporter queues, and
clock health. Missing-field or orphan reasons point to instrumentation shape.

Preflight does not trip the breaker. Decide explicitly whether to pause the
agent operationally, relying on the deployment's approved outage policy.

## PostgreSQL or Schema Failure

- `/healthz` may remain 200.
- `/readyz` returns 503 with `store_unavailable` or `schema_not_ready`.
- Mutations return 503 rather than claiming success.
- Permits follow the configured store outage mode.

Stop rollout and compare the eight migration ledger IDs and SHA-256 checksums
with the immutable image. Do not rewrite historical SQL or update a checksum to
silence a mismatch; investigate artifact or database tampering. If migration
compatibility is uncertain, use a restored copy of the pre-change backup and
repeat the enforcement canary.

## Redis Failure or 429 Saturation

Production startup requires a connected shared Redis. Runtime limiter errors
fail normal API requests closed with 503 `store_unavailable` and preserve the
request correlation ID. `/healthz` remains 200; `/readyz` returns 503 with
`rate_limit_store_unavailable` after a bounded `PING`. Restore Redis and confirm
the same process returns ready before allowing traffic; a restart is not normally
required. Check Redis connectivity, TLS/auth, memory, command latency, and key
volume. If requests return 429, confirm whether one credential is shared across
too many agents before raising limits.

## Diagnosis Backlog or Dead Letter

Enforcement has already committed. Inspect queue metrics and list jobs by
tenant/status. Identify MCP, snapshot filesystem, or Slack failure. After the
dependency is healthy, replay dead-letter jobs through the operator API. Never
edit queue rows manually without preserving an external incident record.

At-least-once delivery can duplicate an external side effect. Compare the
audit-event-derived Slack message identity before manually reposting.

## Stale or Forged SigNoz Alert

- `unbound-alert`: update the alert rule to carry `fuse.source_epoch`; no state
  change occurred.
- `stale-alert`: investigate scheduling, queueing, or clock skew.
- `stale-epoch`: the breaker episode already advanced; do not force the old
  alert onto current state.
- Unexpected fresh trip with valid epoch: rotate the webhook token, review
  channel access, inspect the alert in SigNoz, and audit affected scopes.

Webhook credentials can trip but cannot resume, disable, or enable.

## Slack Resume Rejected

Check, in order:

1. Slack request timestamp freshness and HMAC signing secret.
2. `SLACK_AUTHORIZED_USER_IDS`.
3. `SLACK_TEAM_ID`, when configured.
4. An operator credential matching the incident tenant.
5. The incident card's expected epoch versus current breaker epoch.
6. Cooldown and breaker transition rules.

Do not bypass these checks by weakening the webhook route. Use the operator API
with the same expected epoch and an audited reason when Slack is unavailable.

## Credential Exposure

- Agent token: rotate the exact scope credential and inspect permit/detector/
  Preflight traffic. It cannot call breaker control routes.
- Webhook token: rotate and inspect unexpected trips. It is trip-only.
- Operator token: treat as high severity; rotate immediately and inspect all
  breaker and diagnosis replay audit events for its tenant or wildcard scope.

Rotation requires a controlled restart as documented in
[operations.md](./operations.md).

## Closure

Before closing, record root cause, affected scopes and epochs, guarded versus
unguarded exposure, estimated provider cost as an estimate, recovery evidence,
policy/code follow-up, and whether the incident changes any public guarantee.
