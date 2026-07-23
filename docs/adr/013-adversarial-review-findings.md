# ADR-013: Adversarial review findings and fixes (task.md §11.3)

- Status: accepted
- Date: 2026-07-23
- Deciders: Vedant817 (explicit choice, via delegated senior-engineer agent)

## Context

task.md §11.3 asks for independent adversarial review across correctness/
races, security/privacy, observability claims, and fresh-install
reproducibility, with bounded checklists, before treating this build as
demo-ready. Four independent subagents were run in parallel, each with a
scoped, source-level review task and no access to the others' findings.
This ADR records what they found, what was fixed, and what is recorded as
a real, open gap rather than silently dropped.

## Findings and their disposition

### Fixed: unbounded attacker-controlled `detector` label (security review)

A holder of only a webhook-tier token (the lowest-privilege credential in
this system) chooses the `fuse.detector` label on a forged-but-otherwise-
valid SigNoz alert. `services/control-plane/src/signoz-alert-mapper.ts`
extracted this label with **no length cap** — unlike `reason`, which was
already `.slice(0, 2000)` — and the resulting `NormalizedAlertEvent` is
never actually run through `NormalizedAlertEventSchema.safeParse()`
anywhere on the real webhook path (only in the schema's own unit test),
so a schema-level `max()` alone would not have been load-bearing either.
This unbounded value flowed into `actor.id`
(`system:signoz-webhook:${detector}`), persisted verbatim into the
unbounded `TEXT` `breaker_audit_log.actor_id`/`breaker_state.updated_by_id`
columns, and into an info-level log line
(`diagnosis-worker.ts`'s "unrecognized detector label" path) for any value
that isn't exactly one of the three known detector names — trivial for an
attacker to guarantee. This directly contradicted
`docs/threat-model.md` §5's claim about bounded, disciplined logging.

**Fixed**: added `.max(200)` to `NormalizedAlertEventSchema`'s `detector`
field (`packages/contracts/src/alert-webhook.ts`) for documentation/intent,
and — since that schema isn't actually enforced on this path — truncated
`detector` to 200 characters at the point of construction in
`signoz-alert-mapper.ts`, the same defensive pattern already used for
`reason`. New test:
`signoz-alert-mapper.test.ts`'s "truncates an oversized detector label"
proves a 10,000-character label is cut to exactly 200, not passed through.

### Fixed: `.env.example`'s placeholder tokens silently work as real credentials (fresh-install review)

`.env.example`'s shipped placeholder tokens (e.g.
`changeme-generate-a-strong-random-token`, 39 characters) are long enough
to pass `TokenConfigEntrySchema`'s `min(16)` check. A fresh
`cp .env.example .env` with no edits to the token lines starts the control
plane successfully using these publicly-known strings as live bearer
tokens — silently insecure, not the documented "fails closed on a missing
value" behavior the README's troubleshooting table claimed. The only
actual failure trigger was a completely _empty_ token list, not the
shipped placeholder text.

**Fixed**: `services/control-plane/src/config.ts`'s `loadConfig()` now
rejects any token (plain or `tenant:token` form) that starts with
`changeme` (case-insensitive) with a clear startup error naming the exact
env var and value. Six new tests in `config.test.ts` cover all three token
env vars, the `tenant:token` form, case-insensitivity, and confirm a real
token that merely _contains_ "changeme" elsewhere is not falsely rejected.
`README.md`'s troubleshooting table corrected to describe the two real,
distinct failure modes (empty token vs. placeholder token) instead of
conflating them into one inaccurate row.

### Recorded as an open, real gap — not fixed this slice: unbounded scope-tuple growth in Postgres + OTel cardinality (security review)

Distinct from the already-fixed `DetectorRunner` in-memory scope cap
(ADR-012, which only bounds a buffer used by `/v1/detectors/observe`): a
holder of only an **agent-scoped** token (the lowest-privilege credential
for `/v1/permit` and `/v1/preflight/report`) can send requests with a
fresh, arbitrary `agentId` every time. `BreakerStore.ensureRecordExists()`
and its Preflight equivalent unconditionally insert a **new, permanent**
row into `breaker_state`/`preflight_state` for any never-seen scope tuple,
with no cap, TTL, or eviction of any kind — unlike `idempotency_keys`
(has `expires_at`, see `docs/runbooks/operations.md` §8) and unlike
`DetectorRunner`'s buffer. The same scope tuple also becomes a new label
combination on `fuse.breaker.permit.decisions`/`fuse.preflight.state` —
`packages/otel/src/metrics.ts`'s own doc comment asserts these have
"bounded cardinality by design: ... a finite, pre-registered set in any
real deployment," which is an assumption, not an enforced invariant.

**Not fixed this slice** — this is a materially bigger design question
than the `DetectorRunner` cap (which was a self-contained, in-memory,
per-process fix): bounding it here would mean either registering valid
`agentId`s ahead of time (a real onboarding-flow decision, not present in
this system's design at all) or adding a cap/rate-limit specifically on
_new_-scope creation distinct from the existing per-token request-rate
limit — both real feature designs, not a one-line patch, and both would
need their own test coverage and threat-model update before shipping.
Recorded honestly here and cross-referenced from
`docs/threat-model.md` and `docs/runbooks/limitations.md` rather than
silently left out of both.

### Reviewed, no action needed

- **Correctness/races**: no confirmed bug found. `breaker-store`'s
  epoch-CAS is enforced by Postgres itself (`UPDATE ... WHERE epoch=$n`
  inside a transaction, not an app-level read-then-write race), and the
  advisory-lock-per-idempotency-key serialization was independently
  re-verified. One **unconfirmed, low-confidence** theoretical note:
  if a session-level advisory unlock query itself failed at exactly the
  wrong moment while its connection stayed alive in the pool, a future
  reuse of that same connection could reacquire the lock instantly
  (session-level advisory locks are reentrant). No evidence this is
  reachable in practice was found — recorded here as a "worth a second
  look" item, not a demonstrated defect.
- **Observability claims**: every checked claim (the five metrics'
  existence and real emission call sites, the OpenAPI spec's 13 paths
  matching the 13 real route registrations exactly, the webhook
  idempotency/no-op mechanism the demo script's narrative relies on, the
  `DetectorRunner` hardcoded-config claim, and the post-fix `pnpm audit`
  finding count) verified true against the actual source, not just
  cross-checked against other docs.
- **Fresh-install reproducibility**: every other README/`.env.example`/
  `docs/demo-script.md` command, path, port, and cross-reference checked
  out — the placeholder-token issue above was the only real gap found.

## Consequences

- `NormalizedAlertEventSchema`'s `detector` field now has a real, documented
  upper bound, and the mapper enforces it directly rather than relying on
  an unenforced schema.
- Startup now fails fast and loudly on a forgotten placeholder token
  instead of an operator discovering it later via a leaked/guessable
  credential.
- The unbounded-scope-cardinality gap is a genuine, undone piece of work —
  tracked here, in the threat model, and in the limitations runbook, not
  silently absent from all three.
