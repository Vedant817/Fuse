# Fuse demo script (task.md §11.1)

Status: rehearsed live on 2026-07-23 and independently re-verified on
2026-07-26 against the real local stack (Postgres, control plane,
self-hosted SigNoz with alert rules provisioned). Every number and output
quoted below is measured, not invented. Re-running will produce different
scope IDs/timestamps but the same shape of result, unless noted otherwise.

## Setup (once, before either beat)

```bash
docker compose -f infra/docker-compose.yml up -d postgres
infra/signoz-up.sh                      # only needed for Beat 1
infra/signoz-alerts-up.sh               # only needed for Beat 1
pnpm --filter @fuse/breaker-store run migrate
set -a; source .env; set +a
pnpm --filter @fuse/control-plane run dev   # separate terminal
```

`infra/reset.sh` gives a fully deterministic reset before a rehearsal if
the local Postgres has accumulated state from prior runs.

## Beat 1: healthy → loop → real SigNoz alert → trip → blocked call → audit → diagnosis → resume

**Primary two-minute story** (narrate the bolded lines; the rest is
supporting detail for judge questions):

1. **Run the real proof** — no manual trip call anywhere in this script:

   ```bash
   pnpm --filter @fuse/broken-agent run demo:real-detect
   ```

   The production SDK now reports each completed step synchronously so the
   control plane can trip before the next call; this path correctly trips in
   ~100ms. For this proof only, the script explicitly clears that
   `system:detector:*` trip once, confirms the breaker is armed, and then
   waits for a new trip whose `updatedBy.id` is
   `system:signoz-webhook:*`. It refuses to accept the synchronous trip as
   SigNoz evidence. On 2026-07-26 the independently attributed webhook trip
   took **330.76 seconds** after re-arming (the earlier live runs measured
   210.9s, 231s, and 331s — see
   `docs/adr/006-signoz-alert-rule-provisioning.md`). This is the honest cost
   of proving the external observability-platform path rather than the
   faster production enforcement path.

2. **The real, unscripted result**: both `context-bloat` and
   `loop-signature` fired — `context-bloat` about 11 seconds before
   `loop-signature`. **The system correctly applied only the first trip and
   treated the second as a no-op**, not a double-transition:

   ```
   audit log (real, from this run):
   2026-07-23 15:17:37 | armed → tripped | actor: system:signoz-webhook:context-bloat  | noop=false
   2026-07-23 15:17:48 | tripped → tripped | actor: system:signoz-webhook:loop-signature | noop=true
   ```

   **This is a better demo moment than a single clean detector firing** — it
   shows the idempotency guarantee (task.md §4/§9) actually holding under a
   genuine multi-detector race, not a contrived one.

3. **Prove the blocked next call** — a permit check for the same scope
   immediately after:

   ```json
   {
     "allowed": false,
     "state": "tripped",
     "reason": "Fuse: context-bloat detector fired for "
   }
   ```

4. **Show the audit event** (`docs/runbooks/operations.md` §7's query) —
   the two rows above, with real `correlation_id`s tying each straight back
   to the SigNoz alert delivery that caused it.

5. **Show the evidence-backed diagnosis** — the real local HTML snapshot
   this trip produced (`FUSE_INCIDENT_SNAPSHOT_DIR`, or Slack if
   `SLACK_BOT_TOKEN` is configured):

   > 🔴 **Fuse tripped: context-bloat**
   > **Hypothesis:** Input token count grew past the configured safeguard
   > (score 1, threshold 1), consistent with a conversation history that is
   > never compacted, deduplicated, or cached.
   > **Recommended fix:** Add history compaction/summarization, prompt
   > caching for the stable prefix, or a hard context-size ceiling with a
   > truncation/summarization fallback.
   > ⚠️ _No matching spans were found in SigNoz for this scope in the
   > incident window — the detector fired on telemetry that may have since
   > aged out of the query window._

   **Say this last line out loud on stage.** It is the honest behavior of a
   real MCP evidence query that came back empty in this run, not a scripted
   success — Fuse reports that gap rather than fabricating evidence, which
   is itself part of the pitch.

6. **Resume, for real**:

   ```bash
   curl -X POST http://localhost:8090/v1/breaker/resume \
     -H "Authorization: Bearer $CONTROL_PLANE_API_TOKENS" -H "Content-Type: application/json" \
     -d '{"scope": {...}, "reason": "confirmed, resuming", "actor": {"type":"manual","id":"user:demo-operator"}, "correlationId": "...", "idempotencyKey": "..."}'
   ```

   Real result: `epoch` incremented 1→2, `state: armed`. A follow-up permit
   check returns `allowed: true` again.

### Numbers to actually say on stage

- Alert-to-trip latency: **~331 seconds** in the latest verified run (be ready for
  "why so slow" — answer: SigNoz's own alert-evaluation cadence, not
  anything Fuse's own code adds; `/v1/permit`'s own p50 is 6ms,
  `docs/adr/011-permit-load-test.md`).
- Zero model dispatches occur between the trip committing and the resume —
  this is the proven guarantee (`guard.integration.test.ts`), not asserted
  from this manual rehearsal alone.

## Beat 2: Preflight — remove telemetry, show blind, restore, show recovery

Real transcript from this rehearsal (`agent-preflight-beat` scope):

1. **Healthy report** → `state: "protected"`, `reasonCode: "healthy"`.
2. **Report spans missing token-count fields** →

   ```json
   {
     "state": "blind",
     "reasonCode": "missing-required-fields",
     "reason": "100.0% of spans are missing input/output token counts — cost-velocity and context-bloat detection are blind regardless of other fields"
   }
   ```

   **Say plainly**: Fuse just told you it can no longer trust its own
   detectors for this scope — not a crash, not silence, an honest downgrade.

3. **Report healthy spans again, immediately** → state stays `"blind"`
   (`reasonCode: "recovering"`), with `pendingRecoveryState: "protected"`
   and a `pendingSince` timestamp. **This is deliberate hysteresis** — one
   good report doesn't instantly erase a real gap; recovery must hold for a
   dwell window (`minRecoveryDwellMs`, default 60s) first.
4. **Wait past the dwell window** (~2 minutes elapsed in the actual
   rehearsal, comfortably past 60s) **and report healthy spans once more** →
   `state: "protected"` commits for real.

This whole beat takes about 2-3 minutes end to end (dominated by the
recovery-dwell wait) — plan the primary two-minute story around Beat 1 and
treat Beat 2 as the "if there's time" second act, or pre-run it and show
the real transcript above instead of waiting live.

## Offline-safe fallbacks

If the live stack (Docker/SigNoz) isn't reachable at demo time:

- **Beat 1**: show the real audit-log transcript and diagnosis snapshot
  quoted above (both are genuine past output, timestamped, not fabricated
  for this document) instead of re-running live. State plainly that this
  is a recorded prior run, not a live one.
- **Beat 2**: same — the four real JSON responses above are a complete,
  honest substitute for a live re-run.
- **Dashboard**: `infra/signoz/dashboards/fuse-agent-cost-health.json`
  renders correctly even against no/sparse data (an honest "No Data" state,
  not a misleading zero — `docs/adr/008-signoz-dashboard-provisioning.md`).
  Re-opened live via the browser during this rehearsal (not just an API
  check): 6 of 7 panels showed real, non-empty data from this exact run
  (breaker permit decisions, Preflight state, detector fired/score, token
  usage, operation duration); only "Estimated spend" stayed an honest
  "No Data" (no guarded call this session carried a non-zero cost). No
  static screenshot file was captured this slice — a real, minor gap
  (task.md §11.2 asks for one) — but the live render was visually verified,
  not assumed from the JSON alone.
- Never present a recorded/offline artifact as if it were happening live —
  say "this is from an earlier run" explicitly.

## Judge-question depth (beyond the two-minute story)

- **"What if two detectors fire for different reasons at once?"** — Beat
  1's real result above answers this directly: first trip wins, subsequent
  ones are audited no-ops, never a double-transition or lost history.
- **"What happens to in-flight calls when a trip lands mid-request?"** — a
  call already past its own permit check may still complete; the guarantee
  is about the _next_ call (`guard.integration.test.ts`'s in-flight-exposure
  test measures this precisely; `docs/runbooks/limitations.md` states it in
  plain language).
- **"Is the estimated cost real billing?"** — no, explicitly labeled
  estimated, computed from a local pricing table
  (`packages/otel/src/pricing.ts`), not reconciled against a provider
  invoice.
- **"What if Slack or the MCP evidence fetch is down?"** — both degrade to
  a local-only path (HTML snapshot; a diagnosis with `evidence unavailable`)
  and never block the trip itself, which already committed before either is
  attempted (`docs/adr/012-failure-injection-review.md`).
