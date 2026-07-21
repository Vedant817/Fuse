# Fuse threat model

Status: living document, first written 2026-07-21 against the code as it
exists at commit range up to `docs: record README/CONTRIBUTING/CODEOWNERS
evidence in task.md`. This satisfies task.md §1.2. It documents the system
**as built**, not an aspirational design — every mitigation cited below is
backed by a specific file and test; every gap listed is something a real
holder of the stated credential could exploit against the current code.
Re-read and update this document whenever the control plane's auth model,
webhook handling, or data-collection surface changes.

## 1. Assets

- **Breaker state and audit log** (Postgres, `packages/breaker-store`) — the
  authoritative record of every tenant/environment/agent's armed/tripped/
  disabled state and every transition's actor/reason/correlation ID.
- **Preflight telemetry-health state** (same store) — a scope's
  protected/degraded/blind/disabled verdict.
- **Bearer tokens** (`CONTROL_PLANE_API_TOKENS` / `_AGENT_API_TOKENS` /
  `_WEBHOOK_TOKENS`) — the only credential type in the system. There is no
  session, cookie, or per-tenant credential; see §4 for why this matters.
- **SigNoz alert payloads** — untrusted input arriving over the webhook
  route; the only externally-triggered write path into breaker state besides
  the operator API.
- **Span/telemetry data** (OTel `gen_ai.*`/`fuse.*` attributes,
  `SpanTelemetrySampleWire` reports) — deliberately structural/metadata only
  (see §5); not itself an asset requiring redaction, by design.

## 2. Actors and trust boundaries

| Actor                                                                 | Holds                                                                                            | Trust boundary                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Operator (human or automation with `CONTROL_PLANE_API_TOKENS`)        | Full control: trip/resume/disable/enable any scope, read/report Preflight, submit webhook alerts | Fully trusted within the deployment — no further restriction below "has an operator token"                  |
| Agent SDK (`CONTROL_PLANE_AGENT_API_TOKENS`, embedded in `FuseGuard`) | Permit checks + Preflight report/read only; `403` on every `/v1/breaker/*` call                  | Trusted not to misuse the calls it _can_ make, not trusted with control actions                             |
| SigNoz webhook channel (`CONTROL_PLANE_WEBHOOK_TOKENS`)               | Trip-only, via alert payload                                                                     | Trusted to deliver genuine SigNoz alerts; payload content (scope, reason) is otherwise untrusted (see §3)   |
| Unauthenticated network caller                                        | Nothing                                                                                          | Every mutating and every Preflight/permit route requires a bearer token (`auth.ts`); only `/health` is open |
| A dependency listed in `pnpm-workspace.yaml`'s `allowBuilds`          | Arbitrary code execution during `pnpm install`, scoped to the installing user                    | See §7                                                                                                      |

**Load-bearing design fact, stated plainly:** tokens in this system are flat,
global roles — "an operator token" or "an agent token" — not
tenant/environment-scoped credentials. This is the single most consequential
trust-boundary decision in the system and is examined in §4.

## 3. Webhook authentication, replay, and forgery resistance

Implemented (`services/control-plane/src/routes/webhook.ts`,
`services/control-plane/src/signoz-alert-mapper.ts`):

- Auth is the same bearer-token check as every other route (SigNoz has no
  HMAC-signing option for webhooks — verified against its current docs,
  recorded in `packages/contracts/src/alert-webhook.ts`). Configure SigNoz's
  webhook channel with an empty username and the webhook token as the
  Basic-Auth password; it is sent and checked as a bearer token.
- Route-scoped 256 KB body limit and a 200-alert-per-delivery cap
  (`AlertGroupSchema.alerts.max(200)`), so a single webhook payload cannot be
  unboundedly large.
- Idempotency: `alertCorrelationId = signoz:${fingerprint}:${startsAt}` is
  used as both the idempotency key and the correlation ID, specifically so a
  genuine Alertmanager redelivery (new HTTP request, same alert instance) is
  recognized as a duplicate rather than tripping
  `IdempotencyConflictError`. Verified in
  `services/control-plane/src/webhook.integration.test.ts`.
- Every trip the webhook causes uses **server-controlled**
  `policyVersion`/`cooldownSeconds` (`config.webhookDefaultPolicyVersion`/
  `webhookDefaultCooldownSeconds`) — never read from the untrusted alert
  payload.
- **Fixed: replay/timestamp-skew window.** `isStaleAlert`
  (`services/control-plane/src/routes/webhook.ts`) rejects any alert
  (per-alert, not the whole batch) whose `startsAt` is older than
  `config.webhookMaxAlertAgeMs` (default 10 minutes) or claims to be
  further in the future than `webhookMaxClockSkewAheadMs` (default 1
  minute) — outcome `stale-alert`, never a trip. An unparseable `startsAt`
  fails closed (treated as stale) rather than being assumed fresh. Proven
  in `webhook.integration.test.ts`: a 20-minute-old alert, a 5-minute-future
  alert, and an unparseable timestamp are all rejected without tripping
  anything, while a 1-minute-old alert still trips normally. **What this
  does and does not fix:** it defends against a captured HTTP request (or
  a stale re-queued delivery) being replayed long after it stopped being
  relevant. It does **not** defend against an attacker who already holds a
  valid webhook token minting a brand-new, currently-fresh forged alert —
  `fingerprint` and `startsAt` remain entirely attacker-chosen fields with
  no payload signature to verify, since SigNoz offers no signing option
  for its webhook channel. That residual capability (a valid token can
  still force a trip for any scope it names, as often as it likes, as long
  as each attempt uses a fresh timestamp) is unchanged and tracked below.
  **Recommended follow-up** for that residual gap: a per-webhook-token
  trip-rate limit tighter than the global 120 req/min default (§6), since
  the staleness window alone cannot bound how often a valid token is used.
- **No scope binding on the token itself.** `mapSignozAlertToNormalizedEvent`
  derives `scope` (tenant/environment/agentId) entirely from the alert
  payload's own labels. A webhook token is not associated with any specific
  tenant at the auth layer, so a holder of a valid webhook token can trip
  **any** tenant/environment/agentId it names in the payload, not only
  "its own." This is a known, accepted tradeoff already noted in
  `config.ts`'s own doc comment ("a leaked webhook credential can only cause
  a trip ... for the scope named in the alert's own labels") — worth
  restating here explicitly because "only for its own scope" is **not**
  actually true today; it is "only a trip, for any scope."
- **No key-rotation mechanism.** Tokens are static environment variables;
  rotating one requires a control-plane restart with a new `.env` value and,
  during any overlap window, both old and new tokens are simultaneously
  valid (whichever set the running process loaded at start). There is no
  online/graceful rotation, no token expiry, and no revocation list.
  **Recommended follow-up:** document (and eventually automate) a rotation
  runbook: add new token → restart → confirm → remove old token → restart.

## 4. Human-action authorization, audit, and the cross-tenant blast radius

**Implemented and tested** (already `[x]` in task.md §1.2 before this
document existed): every mutating control-plane endpoint
(`/v1/breaker/trip|resume|disable|enable`) requires a bearer token, an
`actor {type, id}`, a `reason`, and an `idempotencyKey`; every transition is
recorded in `breaker_audit_log` with actor/reason/correlation/policy-version.
Verified in `store.integration.test.ts` and `app.integration.test.ts`. At the
SQL layer, every store query filters by `tenant`/`environment`/`agent_id`
(`packages/breaker-store/src/store.ts`) — there is no missing-`WHERE`-clause
cross-tenant data leakage.

**Fixed (ADR-004, `docs/adr/004-tenant-scoped-tokens.md`):** the gap was one
layer up from storage, at authorization — `scope` is read directly from the
request body/query (`services/control-plane/src/routes/permit.ts`,
`routes/breaker.ts`, `routes/preflight.ts`) and, previously, no token was
associated with any particular tenant, so:

- A single leaked **operator** token could trip/resume/disable/enable
  **every** tenant's breaker on the deployment, not just one team's.
- A single leaked **agent** token could read or report Preflight status for
  **any** tenant's scope, not just the agent it was issued to.

Bearer tokens can now optionally be bound to a single tenant via a
`tenant:token` config entry (instead of a plain token); `requireBearerAuth`
(`services/control-plane/src/auth.ts`) checks the matched token's tenant
against the request's actual target tenant
(`extractTenantFromRequest` — `request.body.scope.tenant` for POST bodies,
`request.query.tenant` for GET) and returns `403 unauthorized` on mismatch.
Wired into `/v1/permit`, `/v1/preflight/*`, and `/v1/breaker/*`. Proven
against a real Postgres-backed store in
`services/control-plane/src/app.integration.test.ts` ("control-plane
tenant-scoped tokens: closing the cross-tenant blast radius") — a tenant-A
token gets 403 attempting to trip/resume tenant B's scope or read its
Preflight status, and the attempted cross-tenant trip is confirmed to have
never actually happened (tenant B's scope remains `unknown_scope`
afterward).

**This fix is opt-in, not a default, and that tradeoff is deliberate and
recorded, not silently glossed over:** a plain (unscoped) token — the only
form that existed before this ADR — still normalizes to the wildcard
tenant `'*'` and is valid for every tenant, exactly reproducing prior
behavior. A deployment that never migrates its `.env` to `tenant:token`
pairs is **still exactly as exposed as described above** — the capability
to close the gap now exists and is tested, but using it requires an
operator to actually configure tenant-scoped tokens. `.env.example`
documents the format and recommends it once more than one tenant shares a
deployment.

**Still not covered by this fix:** the SigNoz webhook (`/v1/webhooks/*`) is
deliberately excluded from tenant binding — see ADR-004's "Scope of this
decision" section for why (a webhook channel may watch multiple tenants,
and one delivery can carry alerts for several scopes at once). Its
authentication remains exactly as described in §3, including the
still-open replay/timestamp-skew gap.

## 5. Prompt/tool payload collection, redaction, and retention

**Current stance: nothing is collected, so there is nothing to redact.**
`withGenAiSpan` (`packages/otel/src/gen-ai-span.ts`) attaches only
structural metadata to spans — operation name, provider, model name,
tenant/environment/agentId, session/step/correlation IDs, token _counts_
(not content), estimated cost, finish reasons, and outcome. No raw prompt
text, completion text, or tool-call arguments are ever placed on a span,
metric, or log anywhere in this codebase (confirmed by direct review of
every `span.setAttributes`/`span.setAttribute` call site). Control-plane
logging (`request.log`/`app.log`, 4 call sites total) never logs
`request.body` verbatim; the one error log that includes request data logs
only the already-validated `scope` object
(`services/control-plane/src/routes/permit.ts`).

The one piece of caller-supplied free text that **is** persisted is the
`reason` string on a trip/resume/disable/enable call (and the mapped
`reason` on a webhook-triggered trip), truncated to 2000 characters and
stored in `breaker_audit_log` as intended audit evidence, not incidental
logging. Since `reason` is operator/detector-authored free text, it is a
narrow retention surface worth naming explicitly: if a future detector or
integration ever populates `reason` with anything derived from prompt/tool
content, that content would flow into the audit log's normal retention path.
**Recommended follow-up, if/when that changes:** define a redaction step
before any detector-generated `reason` string is persisted.

There is currently no prompt/tool payload collection at all in this system,
so retention/deletion/demo-data policy for that data class is not yet
applicable — this will need a real policy the day any component starts
attaching prompt or tool content to telemetry (e.g. a future diagnosis
feature that quotes the offending trace).

## 6. Denial of service and rate limiting

`@fastify/rate-limit` is registered globally
(`services/control-plane/src/app.ts`): **120 requests/minute**, keyed by the
raw `Authorization` header value when present, else by IP. This applies
uniformly to every route — `/v1/permit` (cheap, no DB write on the happy
path), `/v1/preflight/report` (can carry up to 2000 span samples and always
writes to Postgres), and `/v1/breaker/*` all share the same ceiling. A
global 64 KB body limit applies everywhere except the webhook route's
explicit 256 KB override.

**Gap:** a single valid (even agent-scoped, lowest-privilege) token can
issue up to 120 `/v1/preflight/report` calls/minute, each up to 2000 spans,
each causing a Postgres write — there is no endpoint-specific tighter limit
reflecting that this is a heavier operation than a permit check.
**Recommended follow-up:** either a lower per-route limit on
`/v1/preflight/report`, or accept this as within tolerance for a
single-tenant-per-deployment demo scale and revisit before any multi-tenant
production deployment.

## 7. Supply chain

`pnpm-workspace.yaml` explicitly allows four packages
(`cpu-features`, `esbuild`, `protobufjs`, `ssh2`) to run their install
lifecycle scripts, overriding pnpm's default script-blocking policy — all
four are transitive dependencies needed for native bindings/build tooling
used by `testcontainers`/OTel packages. This is a narrow but real increased
attack surface: a compromise of any of the four would achieve local code
execution during `pnpm install` (developer machine or CI), with the
installing user's privileges. There is no automated `pnpm audit`, license
check, or dependency-scanning step anywhere in the repo yet (no CI exists at
all — see task.md §0/§12). **Recommended follow-up:** add `pnpm audit` (or
equivalent) to the `check`/CI pipeline once CI exists, and periodically
re-justify the `allowBuilds` list against the then-current dependency tree.

## 8. Abuse-case test inventory

Threats already covered by an existing, passing test (not a standalone
abuse-case list before this document, but real coverage):

| Threat                                                           | Test evidence                                                                                              |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Forged/unknown bearer token                                      | `auth.test.ts`, `app.integration.test.ts` (401 cases)                                                      |
| Valid-but-wrong-role token (e.g. agent token on `/v1/breaker/*`) | `auth.test.ts`, `app.integration.test.ts` (403 cases)                                                      |
| Prefix/length-based token guessing                               | `auth.test.ts` constant-time comparison tests                                                              |
| Malformed/schema-invalid request body                            | `app.integration.test.ts`, `preflight.integration.test.ts`, `webhook.integration.test.ts` (400 cases)      |
| Duplicate/replayed webhook delivery (same alert instance)        | `webhook.integration.test.ts`                                                                              |
| Concurrent duplicate idempotency-key requests (true race)        | `store.integration.test.ts` (advisory-lock serialization)                                                  |
| Stale-epoch / out-of-order transition attempts                   | `store.integration.test.ts` (CAS contention cases)                                                         |
| Store outage during permit vs. during a mutation                 | `guard.test.ts` (SDK-side), `app.integration.test.ts`/`preflight.integration.test.ts` (control-plane side) |
| Control-plane unreachable from the SDK                           | `guard.test.ts` (timeout/network-error fail-closed/fail-open cases)                                        |

Threats identified by this document, now with a test (updated from the
original "no test yet" list — struck through, not deleted, so the history
of what this document originally found is still visible):

- ~~Cross-tenant control via a single leaked operator/agent token (§4)~~ —
  now covered: `app.integration.test.ts`'s "control-plane tenant-scoped
  tokens" suite proves both the fixed behavior (a scoped token cannot cross
  tenants) and that a wildcard token still can (the documented, opt-in
  tradeoff).

- ~~Webhook replay via a stale `(fingerprint, startsAt)` pair (§3)~~ — now
  covered: `webhook.integration.test.ts` proves a 20-minute-old alert, a
  5-minute-future alert, and an unparseable timestamp are all rejected
  (`stale-alert`, no trip), while a fresh alert still trips normally.

Still with **no test** (tracked as follow-up work, not silently dropped):

- Forgery via a _fresh_, attacker-chosen `(fingerprint, startsAt)` pair from
  a holder of a genuinely valid webhook token (§3's residual gap — the
  staleness window doesn't and can't prevent this; would need a rate-limit
  test once that follow-up is built).
- Endpoint-specific rate-limit exhaustion on `/v1/preflight/report` (§6).

## 9. Summary risk register

| #   | Risk                                                                                 | Severity (given current scale)                                               | Status                                                                          |
| --- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | No token-to-tenant binding — leaked operator/agent token affects every tenant        | High for any multi-tenant deployment; low for the current single-tenant demo | Fixed (ADR-004), opt-in — a wildcard-token deployment remains exposed by choice |
| 2   | Webhook had no replay-window; a stale captured alert could be replayed indefinitely  | Medium (availability/nuisance only — a trip is fail-safe, not data-exposing) | Fixed — `webhookMaxAlertAgeMs`/`webhookMaxClockSkewAheadMs` (§3)                |
| 2b  | Residual: a _fresh_ forged alert from a valid webhook token is still not prevented   | Medium (same fail-safe-only impact; SigNoz has no payload signing)           | Open — recommended fix is a per-webhook-token trip-rate limit                   |
| 3   | Flat rate limit across cheap and heavy endpoints                                     | Low                                                                          | Open, documented, not yet fixed                                                 |
| 4   | No online key rotation                                                               | Low (env-var restart-based rotation works, just isn't graceful)              | Open, documented                                                                |
| 5   | `allowBuilds` supply-chain surface, no dependency audit in CI                        | Low-medium, narrow scope                                                     | Open, no CI exists yet to enforce it                                            |
| 6   | Audit-log `reason` field is a future redaction surface if content ever flows into it | None today (nothing populates it with sensitive content yet)                 | Monitor, no action needed now                                                   |

None of these gaps affect the breaker's core guarantee (zero provider calls
after a committed trip) — that guarantee is enforced independently of the
auth model and is proven under both sequential and concurrent load in
`packages/sdk/src/guard.integration.test.ts`. They affect _who can trigger_
enforcement actions and _how finely scoped_ that trigger is, not whether
enforcement itself works once triggered.
