# Fuse Demo Scripts

Use two separate demonstrations. The first proves the product's enforcement
claim in about 90 seconds. The second proves that SigNoz can independently
corroborate or fall back for the same breaker episode; do not combine their
latency claims.

## Setup

Complete the README quick start and leave the control plane running. The direct
proof needs PostgreSQL but does not need SigNoz, Slack, or an LLM key.

```bash
set -a; source .env; set +a
curl --fail http://localhost:8090/healthz
curl --fail http://localhost:8090/readyz
```

For a deterministic local reset, run `infra/reset.sh` only against disposable
local state.

## 90-Second Direct Enforcement Proof

Run:

```bash
pnpm --filter @fuse/broken-agent run demo:real-detect loop
```

Narration:

1. **0-15 seconds:** "This is a deliberately looping Analyzer/Verifier agent.
   Every provider dispatch is wrapped by `FuseGuard`."
2. **15-35 seconds:** "After each completed step, the SDK sends its bounded
   trailing shape to the control plane. No prompt or tool content is needed."
3. **35-55 seconds:** Point to the direct detector actor and epoch. "The
   loop-signature detector fired, and PostgreSQL committed the breaker trip
   before the observation returned."
4. **55-75 seconds:** Point to `0 provider calls`. "The script attempted the
   next guarded dispatch. The permit was denied before the provider callback,
   so the call count did not move. This is the critical proof."
5. **75-90 seconds:** "SigNoz receives the same detector signal
   asynchronously for dashboards, fallback alerting, and evidence. It is not
   being credited for this direct stop."

The command must fail unless all of these are true:

- the run stopped because a real detector tripped;
- the breaker actor is `system:detector:loop-signature`;
- the breaker is durably `tripped`;
- the post-trip provider dispatch count is zero.

Repeat with either alternative detector:

```bash
pnpm --filter @fuse/broken-agent run demo:real-detect context-bloat
pnpm --filter @fuse/broken-agent run demo:real-detect cost-velocity
```

## Longer SigNoz Fallback Proof

This proof depends on SigNoz scheduling and webhook delivery. Report its
measured timing separately and do not promise a fixed duration.

```bash
infra/signoz-up.sh
infra/signoz-alerts-up.sh
infra/signoz-dashboard-up.sh
```

Procedure:

1. Register a fresh dedicated scope and record its armed breaker epoch `N`.
2. Emit a detector-fired metric carrying `fuse.source_epoch=N` and confirm it
   is queryable in SigNoz.
3. For a true fallback test, inject failure before the direct trip commits, so
   the breaker remains armed at epoch `N`. Do not clear a successful direct
   trip and call the later webhook the original enforcement event.
4. Wait for the provisioned SigNoz rule and webhook. Record metric timestamp,
   rule evaluation, webhook receipt, and committed trip timestamps.
5. Confirm the webhook actor is `system:signoz-webhook:<detector>` and the next
   guarded provider callback remains at zero.
6. Resume the breaker, advancing its epoch.
7. Redeliver the old epoch `N` alert. Confirm `stale-epoch` and no state change.

Also show the dashboard and the MCP-backed diagnosis. If evidence is absent,
show the explicit unavailable result rather than substituting synthetic spans.

## Preflight Honesty Proof

Use the supported `bootstrapFuseOtel` runtime. Demonstrate these transitions:

1. Successful OTLP trace export with required structural fields results in
   `protected` after any recovery dwell.
2. Exporter failure results in `blind` with
   `exporter-delivery-failed`.
3. A report with no success from the separate exporter-evidence capability
   cannot claim `protected`.
4. Restored delivery first enters `recovering`; only sustained healthy evidence
   returns to `protected`.

Say explicitly that Preflight reports trust in telemetry. It does not itself
trip the breaker.

## Diagnosis and Resume Proof

After a trip:

1. List the durable job:

   ```bash
   curl -H "Authorization: Bearer $CONTROL_PLANE_API_TOKENS" \
     "http://localhost:8090/v1/diagnosis/jobs?tenant=demo"
   ```

2. Show the local incident snapshot and, when configured, the Slack card.
3. Explain that MCP and Slack run after the trip and cannot weaken enforcement.
4. Resume through Slack only with a signed, fresh request from an authorized
   user/workspace and the matching trip epoch.
5. To prove dead-letter operations, use the authenticated replay endpoint with
   the exact scope, a manual actor, a reason, and an idempotency key.

## Claims to Avoid

- Do not say every LLM call is protected; only guarded provider paths are.
- Do not say zero calls after detection; say zero guarded dispatches after the
  trip commits, excluding already-permitted in-flight calls.
- Do not present historical SigNoz alert timing as direct enforcement latency.
- Do not call estimated cost provider billing.
- Do not claim customer savings, production use, SLA, precision, or recall.
- Do not present a recorded artifact as a live run.
