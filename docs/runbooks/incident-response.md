# Fuse incident-response runbook

Status: living document, first written 2026-07-23 (task.md §9.3). Every
command below uses the real request schemas
(`packages/contracts/src/breaker-api.ts`) and route paths
(`services/control-plane/src/routes/breaker.ts`) — verified by reading them
directly, not guessed. Every behavior claim cites the test that proves it.
Cross-references `docs/threat-model.md` for the underlying trust-boundary
reasoning rather than repeating it.

## How to read a breaker/Preflight state

```bash
curl -H "Authorization: Bearer $OPERATOR_TOKEN" \
  "http://localhost:8090/v1/breaker/status?tenant=T&environment=E&agentId=A"
```

Breaker `state` is one of `armed` / `tripped` / `disabled` (never
`unknown` for a real persisted record — `unknown` is a permit-response-only
value meaning "the store was unreachable, we couldn't tell").
`/v1/preflight/status` (same auth tier) separately reports
`protected` / `degraded` / `blind` / `disabled` — Preflight's own read on
whether this scope's _telemetry_ is trustworthy enough to make the breaker's
decisions meaningful, independent of the breaker's own state.

## Incident: false-positive trip (breaker tripped, but the agent wasn't actually misbehaving)

1. Confirm it's a false positive, not a missed real issue: pull the
   incident's Slack card (if `SLACK_BOT_TOKEN` was configured) or the local
   HTML snapshot at `FUSE_INCIDENT_SNAPSHOT_DIR` — `runDiagnosisAndNotify`
   writes one for every trip regardless of Slack configuration
   (`diagnosis-worker.test.ts`'s "always writes a local HTML snapshot"). It
   contains the detector's evidence bundle (up to 5 real spans, if
   `FUSE_SIGNOZ_MCP_URL` was configured) and the deterministic hypothesis
   text — read it before resuming, since a resume with no real diagnosis is
   exactly the failure mode Preflight/diagnosis exists to prevent.
2. Resume via the operator API (never via the alert webhook token, which
   cannot resume — `docs/threat-model.md` §2):
   ```bash
   curl -X POST -H "Authorization: Bearer $OPERATOR_TOKEN" \
     -H "Content-Type: application/json" \
     http://localhost:8090/v1/breaker/resume -d '{
       "scope": {"tenant":"T","environment":"E","agentId":"A"},
       "reason": "confirmed false positive: <why>",
       "actor": {"type":"human","id":"<you>"},
       "correlationId": "<incident-id>",
       "idempotencyKey": "<unique-per-attempt>"
     }'
   ```
   `reason` is required and stored verbatim in `breaker_audit_log` — it is
   the permanent record of why a human overrode enforcement, not optional
   metadata.
3. Alternatively, use Slack's own resume button if the incident card was
   posted (opens a modal requiring a reason before submission —
   `slack-actions.ts`'s `buildResumeReasonModalView`/
   `executeAuthorizedResume`, tested end-to-end in
   `slack-interactive.test.ts`).
4. If false positives from this detector are recurring, tune its threshold
   in the versioned policy config (`packages/contracts/src/policy.ts`'s
   `DetectorsConfigSchema`) rather than repeatedly resuming — a
   consistently wrong threshold is a policy bug, not an incident.

## Incident: missed trip (a real cost/loop problem that should have tripped, didn't)

1. Check Preflight state first — a `blind`/`degraded` scope is Fuse's own
   honest signal that its telemetry coverage was too thin to trust a
   detector's silence (task.md's core claim: "clearly report when telemetry
   makes protection unreliable," not silently assume protection held).
   `fuse.preflight.state` on the SigNoz dashboard
   (`infra/signoz/dashboards/fuse-agent-cost-health.json`) shows this over
   time.
2. If Preflight reported `protected` and a detector still should have fired
   but didn't, check whether the relevant detector config
   (`packages/contracts/src/policy.ts`) has since been loosened, and
   whether `fuse.detector.score`/`fuse.detector.fired` on the dashboard show
   the score approaching but never crossing threshold — that's a tuning
   gap, not a code defect.
3. A missed trip is never silently "fine" — the breaker's whole purpose is
   preventing the next expensive call, so treat every missed-trip
   post-mortem as a policy-threshold or telemetry-coverage review, per
   `AGENTS.md`'s definition of done.

## Incident: breaker stuck (won't resume, or immediately re-trips)

1. `cooldownUntil` on the status response: a resume attempted before
   cooldown expires is rejected — this is by design (prevents a rapid
   trip/resume/trip thrash), not a bug. Wait for cooldown or use `disable`
   (below) if the situation genuinely needs enforcement off immediately.
2. If it re-trips right after resuming, the underlying condition (loop,
   cost velocity) is likely still active — check the detector's live score
   on the dashboard before resuming again. Resuming into an still-active
   problem just burns another cooldown cycle.
3. To take enforcement out of the loop entirely (e.g. investigating a
   detector bug, not the agent's behavior) use `/v1/breaker/disable` — a
   disabled scope reports `breaker-disabled` on the next webhook alert
   instead of tripping (`webhook.integration.test.ts`'s "a disabled scope
   reports breaker-disabled... and stays disabled") and must be explicitly
   `/v1/breaker/enable`d again, same auth tier, same required `reason`.

## Incident: telemetry pipeline down (Preflight reports `blind`, or stops reporting at all)

This is the scenario task.md's core claim is specifically about — Fuse
reporting honestly that it can no longer vouch for protection, rather than
silently continuing to look "armed" while blind.

1. Check the agent side first: is the SDK's Preflight reporter actually
   running (`packages/sdk/src/preflight-reporter.ts`)? A process crash or a
   misconfigured `FUSE_CONTROL_PLANE_URL` stops reports entirely, which
   Preflight's own heartbeat-grace logic (`preflightHeartbeatGraceMs`) will
   eventually surface as `blind` — check how long ago `lastGoodAt` was on
   `/v1/preflight/status`.
2. If reports are arriving but coverage/orphan-rate/token-missing-rate
   thresholds are being crossed (`reasonCode` on the status response tells
   you which), that's a genuine instrumentation regression upstream (OTel
   SDK misconfigured, spans missing required `gen_ai.*` attributes) — fix
   the instrumentation, don't just widen the threshold to make the symptom
   go away.
3. **Fuse does not fail the breaker closed just because Preflight reports
   blind** — Preflight and the breaker are deliberately independent signals
   (breaker enforcement continues on whatever its own state already is; a
   `blind` Preflight state is a trust/visibility signal about whether that
   enforcement can be relied on, not itself an enforcement action). This is
   an intentional design boundary, not an oversight — but it means a
   `blind` scope's breaker could still be silently `armed` while providing
   no real protection, which is exactly why `blind` must be treated as an
   incident in its own right, not a footnote.

## Incident: Postgres (state store) outage

1. `/readyz` flips to 503 `{"status":"not-ready","reason":"store_unavailable"}`
   (`health.ts`) — a load balancer should stop routing here; `/healthz`
   stays 200 (liveness — the process itself is fine).
2. Permit checks follow `CONTROL_PLANE_STORE_OUTAGE_MODE` (default
   `fail-closed` — denies, doesn't crash;
   `guard.test.ts`/`app.integration.test.ts` prove this path). Mutating
   calls (trip/resume/disable/enable) always fail with 503 regardless of
   outage mode — a control action that can't be persisted must not report
   success (`config.ts`'s doc comment, by design, not configurable).
3. Restart Postgres / restore connectivity; `pool.on('error', ...)`'s
   safety net (`@fuse/breaker-store`'s `createPool`) prevents one bad idle
   connection from crashing the whole control-plane process while you do.
4. No data is lost from a store outage itself (nothing was written during
   the outage) — but every permit check that fail-closed during the window
   denied a real LLM call an agent may have needed; that's the accepted
   cost of the safer default, not a defect to "fix" after the fact.

## Incident: leaked webhook/agent/operator token

See `docs/runbooks/operations.md` §5 for the rotation mechanics (no online
revocation — env var change + restart). Severity differs sharply by role
(`docs/threat-model.md` §2/§4):

- **Leaked webhook token**: can only cause trips (fail-safe direction), and
  only for scopes an attacker can name in a forged alert payload — cannot
  resume/disable/enable anything. Rotate it, but this is a nuisance/
  availability risk, not a data-exposure one.
- **Leaked agent token**: can check permits (reads current state, can
  trigger a lazy-init of a new scope) but gets 403 on every `/v1/breaker/*`
  route — cannot force-trip, resume, disable, or enable anything
  (`auth.test.ts`).
- **Leaked operator token**: full control — force-trip/resume/disable/
  enable any scope the token is valid for (every tenant, if it's an
  unscoped/wildcard token — `docs/adr/004-tenant-scoped-tokens.md`). Rotate
  immediately; audit `breaker_audit_log` for any transitions you didn't
  expect, since every mutation records its actor/reason/correlationId.

## Incident: Slack or SigNoz MCP unreachable during a real trip

Both are designed to degrade, not to block the trip itself or crash the
process — verified by tests, not just intended:

- `runDiagnosisAndNotify` never throws even if evidence fetch rejects
  unexpectedly (`diagnosis-worker.test.ts`) and always writes the local
  HTML snapshot regardless of Slack's availability.
- A Slack post that fails (network error, non-2xx, API-level error) logs
  and moves on (`slack-client.test.ts`, `diagnosis-worker.test.ts`'s "logs
  but does not throw when the Slack post is not delivered").
- The breaker's own trip already committed before diagnosis runs at all —
  diagnosis/Slack are fire-and-forget _after_ the enforcement decision
  (`webhook.ts`'s `void runDiagnosisAndNotify(...)`), so an outage here
  never delays or blocks the actual protection.

Action: check `FUSE_INCIDENT_SNAPSHOT_DIR` for the local HTML snapshot
(always written) instead of waiting on Slack; fix the Slack/MCP
connectivity issue at your own pace since it does not affect enforcement
correctness in the meantime.
