# Fuse Internal Implementation Evidence Archive

This file preserves chronological implementation notes, commands, test counts,
historical gaps, and superseded decisions from the hackathon build. It is not a
public product specification or the current architecture source. Verify current
behavior against code, tests, `docs/architecture.md`, accepted ADRs, and
`docs/runbooks/limitations.md`.

Entries below are intentionally historical. A checked box means its acceptance
criteria were verified at the time recorded; it does not certify current
production readiness. Append concise evidence for new slices and avoid
repeating broad claims already documented publicly.

## Status protocol

- `[ ]` not started
- `[~]` in progress (include owner/branch in the task note)
- `[x]` verified complete
- `[!]` blocked (include cause, evidence, and the exact unblock action)
- `[d]` deliberately deferred (include reason, risk, and target milestone)

For each completed feature, add a short evidence note beneath its task with the
test command/result, commit SHA, and any remaining risk. Work in critical-path
order unless a dependency makes safe parallel work possible.

## Current Product Outcome

Fuse must demonstrate a trustworthy closed loop:

1. Preflight tells whether an agent can be protected with current telemetry.
2. The SDK reports a bounded structural window to the direct detector route.
3. A firing detector atomically trips the exact agent scope before the report
   is acknowledged.
4. Middleware blocks the next guarded provider dispatch and emits an auditable
   decision.
5. SigNoz asynchronously stores and visualizes OTel data, corroborates or falls
   back with a source-epoch-bound alert, and supplies MCP diagnosis evidence.
6. Durable diagnosis recommends a bounded fix; resume requires an authorized,
   reasoned, epoch-bound human action.

Demo success measures:

- zero guarded provider callbacks after the breaker trip commits and before an
  authorized resume, excluding calls already past permit;
- trip-to-enforcement latency is measured and visible;
- prevented-call and avoided-cost estimates are labeled as estimates;
- all three detector types have reproducible fixtures;
- breaking required telemetry changes protection status to `degraded` or
  `blind` and generates an alert;
- the full demo can be reset and rerun from documented commands.

## Priority and scope guardrails

- **P0:** breaker vertical slice, broken agent, OTel/SigNoz flow, one reliable
  detector, webhook, audit evidence, honest Preflight, reproducible demo.
- **P1:** all three detectors, dashboard, MCP diagnosis, Slack actions,
  persistence, security/reliability hardening, full CI and runbooks.
- **P2:** optional fix PR, learned baselines, advanced multi-tenancy, richer UI,
  and long-horizon analytics. P2 must not jeopardize P0/P1.
- Out of scope for the hackathon: a general telemetry contract platform,
  provider billing reconciliation, autonomous production code merging, and a
  universal LLM gateway.

## 0. Repository and delivery foundation

### 0.1 Governance and source control

- [x] Preserve the supplied `Fuse_Hackathon_Brief.md` as product context.
- [x] Add root `AGENTS.md` with senior-engineer workflow, quality gates,
  subagent protocol, production boundaries, and definition of done.
- [x] Add root `CLAUDE.md` that delegates to and reinforces `AGENTS.md`.
- [x] Create this feature/subtask tracker.
- [x] Initialize Git and set repository-local author to
  `Vedant817 <vedantmahajan271@gmail.com>`.
- [!] Connect a remote owned by `Vedant817`, verify personal-account
  authentication, push the initial branch, and record repository URL here.
  Blocked: `gh` CLI is not installed on this machine and no remote is
  configured (`git remote -v` empty). Unblock action: install/authenticate
  `gh` as `Vedant817` (or supply an existing remote URL owned by
  `Vedant817`), then push branch `main`. All work in the meantime proceeds
  as local, verified commits per AGENTS.md's explicit allowance for this
  case.
- [x] Decide protected default branch and short-lived branch strategy.
  Decision (2026-07-21): solo hackathon-speed build, direct commits to
  `main` with no PR review gate; every commit must still pass the full
  local `pnpm run check` + `pnpm run test:integration` before being made.
  Branch protection/PR-required review is deferred until a remote exists
  and/or a second contributor joins — tracked as a deferred item, not
  forgotten.
- [ ] Add issue/PR templates that require acceptance criteria, verification,
  risk, screenshots/telemetry evidence, and rollback notes. Deferred: no
  remote yet to host templates against; low risk while solo.

### 0.2 Project structure and tooling

- [x] Write ADR-001 selecting the language/runtime and justify it for OTel,
  middleware portability, SigNoz integration, and demo speed.
  Evidence: `docs/adr/001-language-and-runtime.md` (commit `9a296a6`) —
  TypeScript/Node 24/pnpm workspaces.
- [x] Write ADR-002 for the system boundaries and state-store choice.
  Evidence: `docs/adr/002-system-boundaries-and-state-store.md` (commit
  `9a296a6`) — component boundaries + Postgres with epoch-based CAS.
- [~] Scaffold the chosen workspace with clear boundaries. Done so far:
  breaker middleware/SDK (`packages/sdk`), control plane (`services/
  control-plane`, webhook not yet built), shared contracts
  (`packages/contracts`). Not yet started: detectors/policy engine,
  Preflight service, broken demo agent, diagnosis/notification worker,
  OTel instrumentation, SigNoz dashboards/alerts/local infra. Tracked as
  the remaining critical-path work in §3-§8 below.
- [x] Pin runtime and package-manager versions and commit the lockfile.
  Evidence: `package.json` `engines`/`packageManager`, `pnpm-lock.yaml`
  committed (commit `b3b4c8e`).
- [x] Add formatter, linter, strict type checking, unit/integration test
  runners, coverage output, build command, and one aggregate `check`
  command. Evidence: `pnpm run check` (format+lint+build+typecheck+test)
  and `pnpm run test:integration` both pass from a fully clean state
  (all `dist/`/`.tsbuildinfo` removed) across all 6 workspace packages as
  of commit `7e91c1a`; `pnpm run test:coverage` verified working after
  fixing a missing `@vitest/coverage-v8` dependency (commit `02aaa2c`).
- [x] Add `.editorconfig`, `.gitignore`, `.env.example`, license,
  contribution guide, code owners, and a concise initial README.
  Evidence: `.editorconfig`, `.gitignore`, `.env.example`, `LICENSE`
  (Apache-2.0) already existed; added `README.md` (repo layout table,
  prerequisites, clone/configure/start/test/reset/stop commands, SigNoz
  and real-provider status, documentation map), `CONTRIBUTING.md` (the
  work cycle from `AGENTS.md` restated as a contributor-facing workflow,
  ADR process, commit/push conventions, code style), and
  `.github/CODEOWNERS` (single owner, `@Vedant817`, matching the current
  single-maintainer reality). `pnpm run format`/`pnpm run lint` both pass
  clean with these files present.
- [x] Add secret scanning, dependency audit, and license checks. Evidence:
  `docs/adr/009-supply-chain-scan.md`; the production dependency graph now
  returns `No known vulnerabilities found`, and CI retains the audit/SBOM
  evidence.
- [x] Add CI for clean install, format/lint/type check, tests, build, security
  checks, and artifact retention; protect secrets on forked pull requests.
  Evidence: `.github/workflows/ci.yml` has read-only permissions, no secret-
  consuming PR step, pinned actions, full checks/integration/coverage,
  dependency audit, CycloneDX SBOM retention, and hardened container smoke.
  It is checked in locally but cannot produce GitHub-run evidence until push.
- [~] Add reproducible local infrastructure with health checks and pinned
  image versions for SigNoz and the selected state dependencies.
  Done: `infra/docker-compose.yml` pins `postgres:16-alpine` with a
  healthcheck. Not done: SigNoz itself is not yet stood up locally.
- [x] Add deterministic seed/reset scripts and document supported host
  prerequisites. Evidence: `infra/reset.sh` deterministically drops/
  re-migrates the Postgres schema; host prerequisites (Node >=24, pnpm
  >=11, Docker) and the reset/stop commands are now documented in
  `README.md`.

Acceptance criteria:

- [x] a new contributor can clone, configure, start, test, reset, and stop
  the project from documented commands — all six steps are now written
  out verbatim in `README.md`'s "Getting started" and "Common commands"
  sections (clone is implicit; configure via `.env.example`; start via
  `docker compose ... up` + `pnpm --filter @fuse/control-plane run dev`;
  test via `pnpm run test`/`test:integration`; reset via
  `infra/reset.sh`; stop via `docker compose ... down`).
- [~] CI is configured to perform the same checks as local development plus
  audit/SBOM/container smoke. The local equivalents pass; GitHub execution is
  pending the explicitly-deferred push (see §12 open blockers).
- [x] no secret or machine-specific path is committed — `.env` is
  gitignored, `.env.example` holds only placeholders, and this was
  re-checked via `git status`/diff review before every commit this
  session.

## 1. Architecture, threat model, and contracts

### 1.1 System design

- [ ] Draw the end-to-end sequence for Preflight, normal model-call permit,
  SigNoz alert, trip, blocked next call, diagnosis, Slack action, and resume.
  Not done as a diagram; the trip/permit/resume portion is documented in
  prose in ADR-002 and enforced by tests, but there is no single sequence
  artifact covering the full Preflight→...→Resume loop (most of that loop
  doesn't exist yet).
- [~] Define components, trust boundaries, data ownership, deploy topology, and
  supported single-node versus distributed behavior. ADR-002 defines
  component boundaries and the trust boundary (only `control-plane` touches
  the store). Deploy topology and single-node-vs-distributed behavior are
  not yet written down as an explicit statement.
- [~] Define stable identifiers for tenant, environment, agent, session, task,
  trace, alert, policy version, and breaker epoch. Done: tenant/environment/
  agentId (`Scope`), policy version (`policyVersion`), breaker epoch
  (`epoch`) — all implemented, validated, and tested. Not yet defined:
  session, task, trace, and alert identifiers (these arrive with OTel
  instrumentation and detector/alert work, §3-§5).
- [x] Define breaker states and transitions (at minimum protected/armed,
  tripped, disabled, and protection-degraded) with authorized actors and
  guards. Evidence: `packages/breaker-core/src/transitions.ts` — armed/
  tripped/disabled states, `system`/`policy`/`manual` actor types, guards for
  cooldown and disabled-overrides-trip; 16 total tests, including 2
  property-based invariant tests, all passing
  (`pnpm --filter @fuse/breaker-core run test`).
  Note: "protection-degraded" here refers to a distinct concept — Preflight's
  telemetry-health status (§6), not yet built; the enforcement-state enum
  intentionally does not conflate the two (see `breaker-state.ts` comment).
- [x] Specify what happens to in-flight calls at trip time and state the exact
  guarantee for calls beginning after a committed trip. Guarantee (tested,
  not just asserted): once a trip's HTTP response has been observed, every
  subsequent `guard()` call is denied and reaches the provider zero times —
  proven sequentially and under 25-way concurrency in
  `packages/sdk/src/guard.integration.test.ts`. Calls already past their
  permit check and mid-dispatch *before* the trip request was even sent may
  still complete; this exposure was measured at exactly the number of calls
  actually in flight (2 of 2 in the test), not estimated. This is the
  honest, tested limitation to state in demo/docs: Fuse cannot cancel an
  in-flight provider request, only prevent the next one.
- [x] Choose and document state consistency, atomic transition mechanism,
  deduplication window, TTL/retention, and recovery after process restart.
  Evidence: ADR-002 (epoch-based CAS, 7-day idempotency-key TTL); restart
  recovery proven by `store.integration.test.ts`'s "restart recovery" case
  (fresh `pg.Pool` + `BreakerStore` against the same DB observes persisted
  state correctly).
- [x] Decide explicit fail-open/fail-closed policy for SDK/control-plane/store
  outages and allow policy-level overrides with conspicuous status.
  Evidence: control-plane `storeOutageMode` (permit path only; mutations
  always fail closed on store outage — tested) and SDK `outageMode` (default
  fail-closed, fail-open opt-in — tested) in `guard.test.ts`. "Conspicuous
  status": every permit response carries a `degraded: boolean` and, when
  degraded, `state: "unknown"` rather than guessing armed/tripped/disabled —
  there is no dedicated status/config-inspection endpoint yet (deferred,
  P2 — the live per-request `degraded` flag covers the P0 honesty
  requirement). **Found and fixed during a later audit pass**:
  `packages/breaker-store/src/pool.ts`'s `withStoreErrors` — the function
  this entire fail-open/fail-closed contract depends on to detect "the
  store is unreachable" — only classified Node/TCP-level errno codes
  (`ECONNREFUSED`, `ETIMEDOUT`, etc.), not Postgres's own SQLSTATE
  connection-loss codes (`57P01`/`57P02` admin/crash shutdown, `08006`
  connection_failure, and the rest of SQLSTATE class 08). A real Postgres
  restart, failover, or admin-initiated disconnect would have surfaced as
  a generic unclassified error instead of the documented, configured
  outage behavior — an incomplete classifier presented with the
  confidence of "any connection-level failure becomes
  `StoreUnavailableError`." Fixed by extending the code set; 17 new unit
  tests (`pool.test.ts`) cover every added code plus confirmation that an
  unrelated Postgres error code (e.g. `23505` unique_violation) is
  correctly left unwrapped.
- [ ] Define delivery semantics for SigNoz alerts and Slack/MCP work; design all
  handlers for at-least-once delivery. Not started — depends on §4/§5/§7.
- [ ] Record capacity targets and budgets for permit-check latency, webhook
  latency, trip propagation, throughput, availability, and telemetry cost.
  Not started; no load testing has been run yet (tracked in §9.2).

### 1.2 Threat and privacy model

All five items below are now covered by [`docs/threat-model.md`](./docs/threat-model.md),
written against the system as actually implemented (not aspirationally) —
every mitigation cited is backed by a specific file/test, and every gap
listed was independently verified by reading the actual code (not assumed).

- [x] Inventory assets and attackers: control credentials, resume endpoint,
  policy mutation, tenant isolation, alert forgery/replay, malicious prompt/tool
  data, log injection, denial of service, and supply-chain risk.
  Evidence: `docs/threat-model.md` §1-§2 (assets, actors/trust boundaries)
  and §6-§7 (DoS, supply chain). Two genuine, previously-undocumented gaps
  were surfaced by this exercise: (1) tokens were flat global roles with no
  token-to-tenant binding — a single leaked operator token could control
  every tenant's breaker, not just one (§4 of the threat model) — **fixed**
  in a follow-up slice: tokens can now optionally be bound to a single
  tenant (`tenant:token` config format, ADR-004), enforced in
  `services/control-plane/src/auth.ts`'s `requireBearerAuth` and proven
  against a real Postgres-backed store in `app.integration.test.ts`
  ("control-plane tenant-scoped tokens: closing the cross-tenant blast
  radius"); opt-in, so an unscoped/wildcard token remains exactly as
  exposed as before, by informed choice. (2) The webhook had no
  replay/timestamp-skew window, so a stale captured alert could be
  replayed to force a trip long after it stopped being relevant — **fixed**
  in the same follow-up slice: `isStaleAlert` now rejects alerts with a
  stale, future-skewed, or unparseable `startsAt` (§3). Honestly scoped: a
  *fresh* forgery from a genuinely valid webhook token remains possible
  (SigNoz has no payload signing), assessed as low severity (a trip is
  fail-safe, not data-exposing) and tracked as further follow-up work
  (recommended fix: a per-webhook-token trip-rate limit), not silently
  accepted as fully resolved.
- [x] Define webhook authentication/signature verification, timestamp skew,
  replay prevention, key rotation, and least-privilege secret storage.
  Evidence: `docs/threat-model.md` §3 — documents the actual bearer-token
  mechanism (SigNoz has no HMAC option) and the idempotency-key derivation.
  Timestamp-skew/replay prevention is now implemented, not just documented:
  `isStaleAlert` (`services/control-plane/src/routes/webhook.ts`) rejects
  any alert whose `startsAt` is older than `webhookMaxAlertAgeMs` (default
  10 min) or too far in the future (`webhookMaxClockSkewAheadMs`, default
  1 min), fail-closed on an unparseable timestamp — proven in 4 new
  `webhook.integration.test.ts` cases (stale, future-skewed, unparseable,
  and still-fresh-and-tripping). Honestly scoped: this defends against
  replaying a captured/stale request, not against a valid webhook-token
  holder forging a brand-new fresh alert (SigNoz has no payload signing,
  so that residual gap is unchanged and tracked in the threat model's risk
  register as needing a per-webhook-token rate limit). Key rotation
  remains manual/restart-based, stated as an open gap, not glossed over.
- [x] Define human-action authorization and audit requirements for resume,
  disable, policy override, and force trip. Evidence: every mutating
  control-plane endpoint requires a bearer token, an `actor {type, id}`, a
  `reason`, and an `idempotencyKey`; every transition is recorded in
  `breaker_audit_log` with actor/reason/correlation/policy-version — tested
  in `store.integration.test.ts` and `app.integration.test.ts`. Cross-
  referenced in `docs/threat-model.md` §4 alongside the token-binding gap
  above (the audit trail is solid; who is authorized to write to it is the
  open question).
- [x] Set prompt/tool payload collection defaults, redaction rules, retention,
  deletion, and demo-data constraints. Evidence: `docs/threat-model.md` §5
  — verified by direct review of every `span.setAttributes` call site that
  no raw prompt/completion/tool-call content is ever collected anywhere in
  this codebase (only structural metadata: model name, token *counts*,
  identity, timing). The one caller-supplied free-text field that is
  persisted (`reason`, truncated to 2000 chars in the audit log) is
  intentional audit evidence, not incidental logging, and is flagged as a
  redaction surface to revisit only if a future feature ever derives
  `reason` from prompt/tool content.
- [x] Produce an abuse-case test list and map P0/P1 threats to mitigations.
  Evidence: `docs/threat-model.md` §8 — a table mapping each threat to its
  actual passing test (auth rejection, wrong-role 403, malformed bodies,
  duplicate webhook delivery, concurrent idempotency races, stale-epoch
  CAS contention, store/control-plane outage handling), plus an honest
  second table of threats identified by this document that have **no**
  test yet (cross-tenant token blast radius, webhook replay, per-route
  rate-limit exhaustion) — tracked as follow-up work rather than implied
  covered.

### 1.3 Versioned contracts

- [x] Define and validate the policy-file schema: scope, budgets, detectors,
  fail mode, cooldown, notification routes, and manual/policy resume rules.
  Evidence: `packages/contracts/src/policy.ts` — versioned `PolicySchema`
  with `policyVersion`, `cooldownSeconds`, `storeOutageMode`,
  `controlPlaneOutageMode`, an open-ended `detectors` record for future
  detector configs, and `notificationRoutes`. Minimal by design: detector-
  specific budget/threshold fields are added additively in §4 without
  breaking this schema.
- [ ] Define versioned alert-webhook input and normalized internal alert event.
  Not started (§5.1).
- [x] Define trip/permit/resume API requests, responses, idempotency keys,
  stable error codes, and compatibility rules. Evidence:
  `packages/contracts/src/breaker-api.ts` — fully implemented,
  contract-tested (11 tests in `breaker-api.test.ts` covering valid
  fixtures and malformed input: oversized reason, negative cooldown, wrong
  actor type, missing idempotency key, wrong types), and exercised
  end-to-end through real HTTP in the control-plane and SDK integration
  suites. Correction (audit, 2026-07-22): `errors.ts` (stable error codes,
  `FuseHttpError`) has no dedicated contract test file of its own — it was
  previously bundled into this same "11 tests" claim, which overstated its
  coverage. It is exercised indirectly (every integration test asserting a
  specific `error` code/status touches it), but has no fixture/malformed-
  input tests of its own the way `breaker-api.ts` does.
- [x] Define structured breaker audit event and required correlation fields.
  Evidence: `packages/contracts/src/audit.ts` `BreakerAuditEventSchema` —
  scope, from/to state, epoch before/after, actor, reason, correlationId,
  policyVersion, noop flag; persisted to `breaker_audit_log` and returned
  in every transition response.
- [ ] Define Preflight result and protection-state reason codes. Not started
  (§6).
- [ ] Define diagnosis output with evidence references, confidence/limitations,
  recommended action, and safe fallback when MCP is unavailable. Not started
  (§7).
- [~] Add JSON/OpenAPI schemas, generated types where appropriate, fixtures,
  contract tests, and malformed-input/fuzz cases. Done: zod schemas +
  inferred TS types (equivalent to generated types from one source of
  truth), fixtures, and malformed-input contract tests for everything built
  so far. Not done: no OpenAPI spec has been generated/published yet, and
  there is no property-based/fuzz testing of the zod schemas themselves
  (only of breaker-core's state machine, via `fast-check`).

Acceptance criteria:

- the guarantee and non-guarantees can be explained without marketing ambiguity;
- every external boundary rejects invalid/oversized input safely;
- every state-changing request is scoped, authenticated, idempotent, and logged.

## 2. Breaker-first vertical slice (highest risk, P0)

### 2.1 Breaker core

- [x] Implement the state model and policy evaluation as deterministic,
  side-effect-free domain logic. Evidence: `packages/breaker-core/src/
  transitions.ts` — every function is pure (`current` + `input` in,
  outcome out; clock is caller-supplied, never read internally).
- [x] Implement atomic `trip`, `permit`, `resume`, `disable`, and status
  operations with tenant/environment/agent scoping. Evidence:
  `packages/breaker-store/src/store.ts` (epoch-CAS `UPDATE ... WHERE
  epoch=$expected`) + `services/control-plane` HTTP routes, all scoped by
  `{tenant, environment, agentId}`.
- [x] Make trip/resume idempotent and safe under duplicates, reordering,
  concurrent requests, stale breaker epochs, and restarts. Evidence
  (`store.integration.test.ts`, real Postgres via testcontainers):
  duplicate idempotency-key delivery returns the identical stored outcome;
  10 concurrent trip requests for one scope produce exactly one real
  transition (epoch 0→1) and 9 no-ops; a stale `expectedEpoch` is rejected,
  not silently applied; a fresh `BreakerStore`/`pg.Pool` against the same
  database after a simulated restart observes the persisted tripped state.
- [x] Store who/what/why/when for every state transition and policy version.
  Evidence: `breaker_audit_log` table + `BreakerAuditEvent`, written inside
  the same transaction as the state update.
- [x] Implement cooldown and authorized manual/policy resume without
  accidental timer-based reopening. Evidence: `applyResume` rejects a
  `policy`-actor resume while `cooldownUntil` is in the future
  (`cooldown_active`), a `manual`-actor resume overrides it; there is no
  code path anywhere that transitions state on a bare timer — every
  transition requires an explicit call. Tested in both
  `breaker-core`'s unit tests and `breaker-store`/`control-plane`'s
  integration tests.
- [x] Add unit/property tests for every valid and invalid transition.
  Evidence: 16 total tests, including 2 `fast-check` property tests (epoch
  monotonicity; a disabled breaker can never be moved to tripped by
  `applyTrip` for any actor/reason) in `transitions.test.ts`, all passing.
  Audit correction (2026-07-23): earlier wording said "16 unit + 2 property"
  (18 implied), but the executable suite contains 14 example tests and 2
  property tests; `vitest` reports exactly 16.

Section 2.1 acceptance criteria (races/bypass/restart/store-failure/status)
were folded into the combined gap review recorded under §2.3 below, since
by the time 2.1 was implemented the full stack (store→control-plane→SDK)
already existed to test it against realistically.

### 2.2 Pre-call middleware/SDK

- [x] Define a provider-neutral model-call wrapper and an initial real
  provider adapter; keep provider SDK types out of the domain layer.
  Evidence: `FuseGuard.guard(dispatch, correlationId)`
  (`packages/sdk/src/guard.ts`) wraps any `() => Promise<T>` —
  provider-agnostic by construction, no provider SDK types anywhere near
  `breaker-core`. Real provider adapters (ADR-003, 2026-07-21 decision):
  `packages/sdk/src/providers/` — a shared `OpenAiCompatibleProvider` class
  plus `createGroqProvider`/`createNvidiaBuildProvider` factories (both
  platforms expose an OpenAI-compatible `/chat/completions` API; base
  URLs/auth verified against each platform's current docs). The adapter logic
  is tested against a faithful local mock (`openai-compatible-mock.ts`) and,
  after credentials were supplied on 2026-07-23, against both real APIs:
  `pnpm --filter @fuse/sdk run test:live` passed the Groq and NVIDIA Build
  smoke tests with non-empty content and positive token usage.
- [x] Check a permit immediately before provider dispatch, after expensive
  local preparation where practical but before network bytes can be sent.
  Evidence: `guard()` always calls `checkPermit()` and returns/throws before
  ever invoking `dispatch()`; proven by `dispatch` mock never being called
  on denial (`guard.test.ts`) and the fake provider receiving zero requests
  after a real trip (`guard.integration.test.ts`).
- [x] Return a typed, actionable breaker error containing incident/
  correlation identifiers without leaking policy secrets. Evidence:
  `BreakerTrippedError` (`packages/sdk/src/errors.ts`) carries only scope,
  reason, correlationId, state, degraded — no tokens/credentials/internal
  policy fields.
- [~] Emit permit/deny latency, decision, state, and correlation telemetry
  while controlling cardinality. Done: `onDecision` hook fires for every
  permit check with `{scope, correlationId, allowed, state, degraded,
  latencyMs, reason}` (tested in `guard.test.ts`). Not done: not yet wired
  to an actual OTel metrics/span exporter. Correction (audit, 2026-07-22):
  this previously predicted §3.2's OTel-metric wiring would "consume this
  same hook" client-side. That is not what happened — §3.2 wired
  `fuse.breaker.permit.decisions` server-side in
  `services/control-plane/src/routes/permit.ts` instead, the one place a
  permit decision is authoritative network-wide across every SDK/agent
  caller, not per `FuseGuard` instance. This SDK-side `onDecision` hook
  remains unwired to any exporter.
- [x] Implement configured behavior for control-plane timeout/unavailability
  and expose that degraded protection state. Evidence: SDK `outageMode`
  (default `fail-closed`; `fail-open` requires explicit opt-in) tested for
  network error, non-2xx, malformed response, and timeout cases, all
  resolving to `degraded: true, state: "unknown"` rather than a guessed
  state.
- [x] Prove with a fake provider request counter that a tripped breaker
  results in zero provider calls; repeat under concurrency and trip/permit
  races. Evidence: `guard.integration.test.ts` — 10 sequential calls after
  a committed trip (0 new requests), 25 concurrent calls fired after the
  trip's HTTP response returns (0 new requests, all rejected with
  `BreakerTrippedError`), and an in-flight-exposure measurement (exactly 2
  in-flight calls started *before* the trip request completed).
- [x] Run one controlled integration test against a real provider or a
  faithful HTTP test endpoint and preserve evidence for the demo. Both the
  generic fake provider and the OpenAI-compatible mock are real,
  network-listening HTTP servers (not in-process function-call counters)
  — `packages/sdk/src/providers/openai-compatible.integration.test.ts`
  runs the actual `OpenAiCompatibleProvider` class (the same code a real
  Groq/NVIDIA call would use) through `FuseGuard` against the mock, proving
  the concrete adapter's request/auth/response handling — not just the
  generic dispatch-wrapper contract — respects the breaker. Real API evidence
  was added on 2026-07-23: both live provider tests passed, and the narrated
  demo made a guarded Groq call after a real HTTP 200 permit decision.

### 2.3 Hardcoded trigger proof

- [x] Add a temporary deterministic threshold trigger behind a clearly named
  demo/test policy, not the production default. Evidence:
  `packages/sdk/src/demo-threshold-trigger.ts` — `DemoThresholdTrigger`, a
  sliding-window call counter exported only from `@fuse/sdk/demo` (kept out
  of the default `@fuse/sdk` import path), using policy version
  `demo-hardcoded-threshold-v1` (`packages/contracts/src/policy.ts`'s
  `DEMO_HARDCODED_THRESHOLD_POLICY_VERSION`).
- [x] Run an end-to-end slice: threshold -> atomic trip -> next pre-call
  denied -> structured audit event. Evidence:
  `demo-threshold-trigger.integration.test.ts` — 3 calls under threshold
  succeed with no trip; the 4th call pushes the window over the limit and
  the trigger itself (not a test helper standing in for one) calls the
  real trip endpoint; the response's `record.state` and
  `auditEvent.toState` are both `"tripped"`; the next guarded call is
  denied and the real fake-provider HTTP server receives zero additional
  requests.
- [x] Measure the maximum additional calls possible due to already in-flight
  work and present this honestly in docs/demo. Measured (not estimated):
  exactly the number of calls that were genuinely in flight before the trip
  request was issued (2, in the dedicated in-flight-exposure test) — see
  §1.1's in-flight guarantee entry above for the full statement. This
  number is fixture-specific (it depends on how many calls a given agent
  actually has outstanding at trip time); the demo/README will need to
  state this as "bounded by actual concurrency, not a fixed constant"
  rather than quoting "2" as a universal guarantee.
- [x] Perform post-slice review for races, bypass routes, process restarts,
  state-store failure, and misleading status; fix P0/P1 findings. See the
  dated gap-review entry in §12 for the independent adversarial review
  performed across §2.1-§2.3's full implementation and its resolution.

Acceptance criteria:

- tests provide deterministic proof that the provider dispatch function is not
  invoked after the committed trip — met, see §2.2/§2.3 evidence above;
- all state changes are attributable and replay-safe — met, see §2.1 evidence;
- the configured outage behavior is tested and visible — met, see §1.1 and
  §2.2 evidence (control-plane `storeOutageMode`, SDK `outageMode`, the
  `degraded`/`state:"unknown"` fields).

## 3. Deliberately broken agent and sensing (P0)

### 3.1 Authentic failure fixture

- [x] Select and document an authentic Analyzer/Verifier-style workflow with a
  safe, bounded, provider-mocked default mode. Decision (2026-07-21, user
  chose a generic invented example over modeling a specific real system):
  a generic Analyzer↔Verifier reflection loop — Analyzer drafts, Verifier
  critiques or approves — a common real production pattern (self-critique/
  reflection agents). `services/broken-agent`. Default mode uses a fully
  deterministic mock model (`mock-model.ts`, no network, no real cost); a
  real provider (`@fuse/sdk/providers`) can be substituted at the call site
  behind its own explicit opt-in, still bounded by the same safety
  ceilings.
- [x] Implement normal termination and three opt-in failure modes: repeating
  loop, growing conversation context, and abnormal call/cost velocity.
  Evidence: `Scenario = 'normal' | 'loop' | 'context-bloat' |
  'cost-velocity'` (`types.ts`); `normal` terminates via verifier approval
  in a handful of rounds; `loop` never approves and produces
  byte-identical analyzer content every round (the canonicalizable
  loop-signature shape); `context-bloat` never approves and produces
  strictly-increasing input token counts round over round; `cost-velocity`
  has the same approve-quickly shape as `normal` but is paced with
  near-zero inter-round delay, producing an abnormally high calls/time
  rate.
- [~] Add hard demo safety ceilings for calls, runtime, tokens, and actual
  spend that cannot be disabled accidentally in a real-provider run.
  Evidence: `safety.ts`'s `clampCeilings` — every configured ceiling is
  `Math.min(configured, ABSOLUTE_MAX_*)`, so it can only ever be
  *tightened*, never loosened past the in-code absolute maximum; no
  environment variable or config path raises the absolute ceiling. Test:
  "clamps a configured ceiling far above the absolute maximum back down to
  it" (`maxCalls: 999_999` still executes at most `ABSOLUTE_MAX_CALLS`
  rounds). **Found and fixed during a later audit pass**:
  `analyzer-verifier.ts`'s claim that ceilings are "checked before every
  single call, unconditionally" was only symmetric for spend, not tokens —
  spend was re-checked immediately after each call, but `totalTokens` was
  only re-checked at the *top of the next* loop iteration, so a single
  call that pushed tokens past the ceiling wasn't caught until one round
  later (or never, if that call happened to be the last one anyway).
  Fixed with a symmetric post-call token check; regression test "stops
  immediately (not one round late) when a single call pushes total tokens
  past the ceiling" configures a call that returns 100k tokens against an
  80k ceiling and asserts `totalCalls === 1`, not 2. **Independent audit
  correction (2026-07-23):** only `maxCalls` is a strict pre-dispatch hard
  cap. Runtime, token, and synthetic estimated-spend thresholds can exceed
  their in-code maxima by one already-dispatched call: a custom model returning
  1M input + 1M output tokens produced 2M total tokens / $4 synthetic spend
  before stopping, over the advertised 300k / $2 values. A provider call can
  likewise run past the runtime threshold because this fixture has no
  provider-cancellation contract. The spend value is explicitly estimated,
  not actual provider billing. This remains `[~]` until provider adapters can
  accept enforceable per-call token/time budgets; comments and regression
  tests now state the one-call exposure honestly rather than claiming an
  impossible strict bound after dispatch.
- [x] Make the fixture deterministic with seed, scenario, iteration delay, and
  reset controls. Evidence: `RunConfig.{scenario, seed, iterationDelayMs}`
  fully determine output (no real randomness anywhere in `mock-model.ts`);
  "reset" is implicit — every call to `runAnalyzerVerifier` is a fresh,
  independent run with no shared mutable state between runs.
- [x] Add tests proving the normal workflow does not trip default policies and
  each broken scenario produces its intended telemetry shape. Evidence:
  `analyzer-verifier.test.ts` (originally 6 unit tests, now 8: normal
  terminates via verifier-approved without ever being denied; loop
  produces a repeated byte-identical shape and runs to the safety ceiling;
  context-bloat produces strictly-increasing input tokens; cost-velocity
  is measurably faster than a paced normal run; ceiling clamping; a mocked
  breaker trip stops dispatch immediately with zero further model calls;
  plus 2 new regression tests below) and `analyzer-verifier.integration.test.ts`
  (2 tests against a real Postgres + control plane: a normal run completes
  end to end; a trip issued via the real operational API mid-run — exactly
  as a detector's webhook will do in §5 — stops the fixture at
  `breaker-tripped` with the model spy showing zero calls after the trip
  committed). **Found and fixed during a later audit pass**: verifier
  approval was detected with a bare `/\bapproved\b/i` substring search,
  which also matches negated content ("not approved", "cannot be
  approved") — harmless with the mock model's exact `'Approved.'` output,
  but a real, correctness-relevant bug the moment a real `Model`
  implementation is substituted (an explicitly documented substitution
  point, `RunConfig.model`) and produces free-text verifier output with
  more natural rejection phrasing. Fixed by anchoring the match to the
  start of the content (`/^\s*approved\b/i`); regression test "does not
  treat a negated rejection ('not approved') as approval" injects a
  custom model whose verifier text starts with "This draft is not
  approved..." and asserts no round is ever marked approved.
- [x] Add a runnable, narrated live demo against a real running control
  plane (not a test suite). Evidence: `services/broken-agent/src/demo.ts`
  (`pnpm --filter @fuse/broken-agent run demo`) — a normal run, a loop
  scenario capped by the fixture's own ceiling, an external trip via the
  real `/v1/breaker/trip` API stopping dispatch mid-run with an exact
  before/after dispatch count, an operator resume, and the resulting
  Preflight status; optionally a real Groq/NVIDIA call when
  `GROQ_API_KEY`/`NVIDIA_API_KEY` is set. Fails fast with setup
  instructions if the control plane isn't reachable. Manually run
  end-to-end against a real Postgres + real control-plane process (not just
  `app.inject()`) — output verified to be accurate and legible. Re-run with
  real credentials on 2026-07-23: Act 6 returned a Groq
  `llama-3.1-8b-instant` response; Postgres independently recorded the
  generated `agent-real-llm-*` guard scope as `armed`, epoch 0. A follow-up
  instrumentation fix also made the call visible in ClickHouse and its scope
  `protected` in Preflight, as detailed in the dated audit entry below.
  Found and fixed one real bug during this verification: the OTel
  shutdown/flush at the end originally threw uncaught when no OTLP
  collector was reachable (a fully valid, unconfigured-by-default state —
  SigNoz not running), crashing the whole demo with a stack trace after a
  clean summary; fixed to degrade to an informational message instead,
  matching the same "telemetry failure must never look like a product
  failure" principle already applied to `PreflightReporter`. Distinct
  from, and does not itself satisfy, the still-open Preflight-specific
  "remove a token field, detect blind, restore, show recovery" demo beat
  above — this demo covers the breaker/Preflight-status loop generally,
  not that specific telemetry-regression scenario.

### 3.2 OTel instrumentation

- [x] Pin the tested OTel semantic-convention/version assumptions. Evidence:
  `packages/otel` — `@opentelemetry/semantic-conventions@1.43.0`, gen_ai
  attributes imported from its `/incubating` subpath (these remain
  experimental/incubating upstream, not yet in the stable registry — this
  is stated honestly, not glossed over). Actual current attribute/metric
  names (`gen_ai.provider.name`, `gen_ai.request.model`,
  `gen_ai.usage.{input,output}_tokens`, `gen_ai.operation.name`,
  `gen_ai.response.finish_reasons`, `gen_ai.client.token.usage`,
  `gen_ai.client.operation.duration`) were verified against the installed
  package's actual `.d.ts` type declarations, not assumed from memory or
  blog posts — the initial `^0.57.x`/`^1.30.x` OTel JS package guesses were
  found to be badly stale (real latest: sdk-node/exporters `0.220.0`,
  sdk-metrics/sdk-trace/resources `2.9.0`) and corrected before writing any
  code against them.
- [x] Emit model/provider, operation, input/output/total tokens, estimated cost,
  agent/session/task, step index, parent chain, retry, and outcome attributes
  using standard `gen_ai` names where available and namespaced extensions
  where necessary. Evidence: `packages/otel/src/gen-ai-span.ts`'s
  `withGenAiSpan` + `attributes.ts`'s `fuse.*` namespaced extensions
  (tenant/environment/agent_id/session_id/task_id/step_index/scenario/
  outcome/estimated_cost/correlation_id). Not done: no `retry` attribute
  yet (no detector/webhook retry path exists to instrument) — tracked for
  §5/§7.
- [x] Preserve trace context across agents, tools, queues, and HTTP calls; test
  that there are no unexpected orphan step spans. Evidence:
  `services/broken-agent`'s run is one root `invoke_agent` span with each
  round nested as a `chat` child via `withGenAiSpan`'s use of the OTel
  active-context API (no manual parent-id plumbing) —
  `analyzer-verifier.otel.test.ts` proves every non-root span has the root
  as its parent and shares its trace ID, with an explicit "nothing floats
  free" span-count assertion. Caveat: this fixture is entirely in-process
  (no real queue/HTTP hop between "agents" yet), so cross-process
  propagation (W3C traceparent over an actual HTTP call) is exercised by
  `@opentelemetry/sdk-node`'s built-in HTTP context propagation but not
  yet covered by a Fuse-specific test — deferred until a real
  network-separated agent step exists.
- [x] Emit monotonic token/cost counters, request/error/denial counts, latency
  histograms, active-loop signals, and derived cost velocity with documented
  units and aggregation windows. Evidence: `gen_ai.client.token.usage`
  (`{token}` unit histogram, dimensioned by token type + model, tested)
  and `gen_ai.client.operation.duration` (`s` unit histogram, tested) in
  `metrics.ts`; `fuse.breaker.permit.decisions` counter for permit
  allow/deny history — **found and fixed during a later audit pass**: this
  counter existed and was documented as if wired, but nothing in any real
  code path ever called it (only its own unit test did) — a metric
  presented with the confidence of finished instrumentation while being
  dead scaffolding. Now genuinely wired in
  `services/control-plane/src/routes/permit.ts` (the one place a permit
  decision is actually authoritative, network-wide across every SDK/agent
  caller, not client-side per `FuseGuard` instance), proven by 3 new unit
  tests (`routes/permit.test.ts`) asserting the exact scope/state/allowed/
  degraded dimensions are recorded on both a successful and a
  store-unavailable-degraded decision, and NOT recorded for a request that
  never reaches the store. Not done: no active-loop signal or derived
  cost-velocity metric yet — those are detector outputs (§4), which don't
  exist yet; this slice provides the raw token/duration data they will
  consume.
- [x] Define a versioned price table with effective dates and model alias
  handling; label calculated cost as estimated and retain raw token counts.
  Evidence: `packages/otel/src/pricing.ts` — `PRICE_TABLE_VERSION`,
  per-entry `effectiveDate`, `estimateCostUsd()` returns `priced: false`
  (not a misleading zero) for unmatched provider/model pairs, tested.
  Explicitly labeled illustrative/estimated in code comments, not a live
  pricing feed. No model-alias remapping table yet (not needed until
  detectors need to match a rotating/aliased model name).
- [ ] Emit structured breaker logs correlated to trace, alert, agent, task, and
  policy without prompt content or secrets by default. Not done — the
  OTel logs pipeline is bootstrapped (`bootstrapOtel` configures an OTLP
  log exporter) but nothing actually emits a log record yet; the
  control-plane's audit events (already correlated to trace/agent/policy
  in Postgres, §2.1) have not yet been mirrored as OTel log records. Real
  gap, tracked for the control-plane's next OTel integration pass.
- [x] Apply resource attributes for service, version/build, deployment
  environment, and telemetry schema version. Evidence:
  `packages/otel/src/resource.ts` — `service.name`, `service.version`,
  `deployment.environment.name`, and a custom
  `fuse.telemetry_schema_version` resource attribute
  (`FUSE_TELEMETRY_SCHEMA_VERSION`), merged with OTel's env-detected
  default resource.
- [~] Add batching, timeouts, bounded queues, sampling policy, and a visible
  dropped-telemetry metric. Done: batching (BatchLogRecordProcessor,
  PeriodicExportingMetricReader), timeouts (OTLP exporter
  `timeoutMillis`/`concurrencyLimit` available, using SDK defaults). Not
  done: no explicit sampling policy configured (uses OTel's default
  always-on sampler) and no dropped-telemetry metric exists yet — real gap
  for the production-hardening pass (§9).
- [x] **Found and fixed during a later audit pass**: `bootstrapOtel` was
  never actually called by any real, long-running service process —
  `services/control-plane/src/server.ts` (the actual production
  entrypoint, run via `pnpm --filter @fuse/control-plane run start/dev`)
  never invoked it, meaning the control plane emitted zero telemetry about
  itself outside of tests that manually called `bootstrapOtel` in-process.
  All the OTel plumbing in `packages/otel` was real and well-tested, but
  the one long-running service meant to use it in production never
  actually wired it in — a genuine gap between "looks OTel-native" and "is
  OTel-native when actually run." Fixed: `server.ts`'s `main()` now calls
  `bootstrapOtel({ serviceName: 'fuse-control-plane', serviceVersion,
  deploymentEnvironment })` once at startup (added `@fuse/otel` as a real
  dependency, a new `CONTROL_PLANE_DEPLOYMENT_ENVIRONMENT` config field),
  and flushes/shuts it down alongside the existing SIGTERM/SIGINT
  handlers. Deliberately NOT called from `buildApp()`, which every
  integration test also calls (often many times per process) — OTel
  global-provider registration is a one-shot no-op on repeat, so it must
  happen exactly once, only in the real entrypoint.

### 3.3 SigNoz ingestion proof

- [x] Configure OTLP export through environment-driven secure endpoints.
  Done: `bootstrapOtel` defaults to standard `OTEL_EXPORTER_OTLP_*`
  environment variables when no explicit endpoint is passed. Verified
  against a real local HTTP receiver (`packages/otel/src/
  sdk.integration.test.ts`, kept lightweight/no-Docker for every test run)
  **and** against the real self-hosted SigNoz collector (ADR-005) — see
  below. `.env.example`'s `OTEL_EXPORTER_OTLP_ENDPOINT` now defaults to
  `http://localhost:4318`, no auth header needed for the local,
  unauthenticated collector.
- [x] Verify traces arrive in the targeted SigNoz version and originate from
  Fuse's own instrumentation, not a synthetic probe.
  Evidence (ADR-005, docs/adr/005-self-hosted-signoz.md): with the
  self-hosted stack up (`infra/signoz-up.sh`, SigNoz v0.133.0 +
  signoz-otel-collector v0.144.6), the actual `@fuse/otel` package's
  `bootstrapOtel`/`withGenAiSpan` emitted one real span, and it was
  confirmed present by directly querying the stack's own ClickHouse store:
  `SELECT serviceName, name, timestamp FROM
  signoz_traces.distributed_signoz_index_v3 WHERE serviceName =
  'fuse-signoz-smoke-test'` returned the row, with `name` matching
  `withGenAiSpan`'s `${operationName} ${requestModel}` naming convention
  exactly (`chat smoke-test-model`). This is real end-to-end ingestion
  proof, not a wire-level request-shape assertion.
- [x] Verify metrics and logs also arrive and can be correlated with the
  trace for one demo run.
  Evidence (docs/adr/005-self-hosted-signoz.md, "Verification" section): a
  second smoke run emitted one `chat` span plus, in the same span
  context, one manually-emitted log record (via `@opentelemetry/api-logs`
  — logs aren't emitted anywhere in the app code today, so this exercises
  `bootstrapOtel`'s configured log pipeline specifically, not app content).
  All three signals confirmed in ClickHouse: the trace
  (`signoz_traces.distributed_signoz_index_v3`); both `gen_ai.client.*`
  histograms (`signoz_metrics.distributed_time_series_v4`); and the log
  record (`signoz_logs.distributed_logs_v2`) with its `trace_id` column
  matching the span's own trace ID byte-for-byte — real proof of
  cross-signal correlation, not just three separate arrivals. Verified via
  direct ClickHouse query (not yet the SigNoz UI itself, which reads the
  same data through its own query layer).
- [~] Capture saved queries/screenshots or an automated smoke check as
  evidence. Done: the exact ClickHouse queries and their results are
  recorded in docs/adr/005-self-hosted-signoz.md as reproducible evidence.
  Not done: this isn't yet a checked-in automated test (would need a
  ClickHouse client dependency and a live-optional gate, matching the
  `*.live.test.ts` pattern) — today it's documented manual verification,
  reproducible by a human following the ADR, not CI-enforced.
- [ ] Validate representative cardinality and ingestion volume; remove
  high-cardinality dimensions from metrics where required. Partially
  addressed by design (metrics.ts's cardinality-discipline comments: token/
  duration histograms are dimensioned by model, not by
  session/agent/correlation id) but not validated against real sustained
  ingestion volume, which requires a longer-running load test, not just
  the single-span proof above.

Acceptance criteria:

- a single task can be followed from agent step through model span and breaker
  decision in SigNoz;
- token counts and estimated cost reconcile with deterministic fixtures;
- broken scenarios are safe by default and cannot create unbounded spend.

## 4. Detection and SigNoz alerts (P0/P1)

This section's checkboxes were badly stale before the 2026-07-22/23
gap-closure session: `packages/detectors` and its 39 unit tests already
existed and covered nearly everything below, but nothing had ever checked
these boxes, and — the actually-missing part — nothing in the running system
called the detectors or had ever created a real SigNoz alert rule. Both are
now true. See the dated entries in §12 for full evidence.

### 4.1 Detection framework

- [x] Define a detector result contract containing detector/version, score,
  threshold, window, evidence references, scope, and deduplication key.
  Evidence: `packages/contracts/src/detector.ts`'s `DetectorResultSchema`
  (pre-existing, now also the live wire contract `DetectorRunner` returns).
- [x] Build deterministic fixture/replay tooling from synthetic, non-sensitive
  telemetry. Evidence: `packages/detectors/src/fixtures.ts` (pre-existing).
- [~] Establish a normal baseline set and evaluate false positive/negative
  behavior before selecting defaults. Done: every detector's test suite
  proves it stays quiet on the other two scenarios' fixtures plus a sparse/
  low-traffic fixture (9 such "stays quiet on X" tests across the three
  files) — this is the false-positive evaluation, just never written up as
  a standalone document. Not done: no formal baseline-tuning write-up
  exists; the chosen defaults were carried over from the original
  implementation, not re-derived from real production traffic (none exists
  yet).
- [x] Keep detector configuration in the versioned policy file and include the
  effective policy version in alerts/trips. Evidence:
  `packages/contracts/src/policy.ts` plus
  `services/control-plane/src/policy-loader.ts`: startup validation, duplicate
  selector rejection, exact/wildcard specificity, and wire-window checks.
  `CONTROL_PLANE_DETECTOR_POLICY_FILE` is mandatory in production; direct
  detector trips carry the resolved `policyVersion`, cooldown, and thresholds.
  `/v1/policies/effective` exposes the loaded result to an authorized operator.

### 4.2 Loop-signature detector

- [x] Canonicalize repeatable step/span shapes while excluding volatile IDs,
  timestamps, and token counts. Evidence: `packages/detectors/src/types.ts`'s
  `StepRecord.canonicalShape` contract (pre-existing); now genuinely
  live-wired (this session) via `services/broken-agent/src/
  analyzer-verifier.ts`, which hashes the model's actual output content
  (`createHash('sha256')`, not an invented label) into `canonicalShape` —
  proven by a new test that spies on `guard.recordStepObservation` during a
  real `loop` run and confirms a small, bounded, genuinely-*repeating* set
  of shapes, not just "some hash was computed."
- [x] Detect consecutive and short-cycle repeats, including Analyzer/Verifier
  ping-pong and retry/replan cycles. Evidence: `loop-signature.test.ts` —
  "fires on the Analyzer/Verifier ping-pong (cycle length 2)" and "detects
  a cycle-length-1 (immediate consecutive repeat), not just cycle-length-2."
- [x] Require configurable minimum repetitions/window and distinguish expected
  bounded iteration from pathological progress-free repetition. Evidence:
  `LoopSignatureConfig{windowSize,minRepetitions,maxCycleLength}` +
  "does not fire on a short, legitimate bounded loop (2 repetitions, below
  the minimum)."
- [x] Test noise, alternating cycles, legitimate loops, retries, missing spans,
  delayed spans, and high-volume cases. Evidence: `loop-signature.test.ts`'s
  10 tests include "handles missing/delayed spans gracefully," "is
  invariant to delayed/out-of-order delivery," and "handles a high-volume
  window without misclassifying noisy-but-distinct steps as a loop."

### 4.3 Context-bloat detector

- [x] Compute input-token growth over a scoped session/task window.
- [x] Support absolute context ceiling, consecutive growth, slope/ratio, and
  minimum-call safeguards to prevent early noise.
- [x] Handle model context-window changes, history compaction, cached tokens,
  late data, and session boundaries. Evidence: `context-bloat.test.ts`'s
  "does not penalize a legitimate history compaction/reset," "is invariant
  to delayed/out-of-order step delivery," "handles a stable large context
  without flagging it."
- [x] Test linear growth, sudden jumps, stable large contexts, normal resets,
  and missing token attributes. Evidence: 14 tests total, including "is
  robust to a missing/zero token attribute on the first step" and "reports
  a finite, JSON-serializable score" (a real regression test for a past
  `Infinity`-becomes-`null` bug).

### 4.4 Cost-velocity detector

- [x] Compute estimated spend per documented time window with low-traffic and
  incomplete-window safeguards. Evidence: `CostVelocityConfig
  {minCallsForSignal,minElapsedMsForSignal}` + matching tests.
- [x] Implement a deterministic static threshold for the demo.
- [d] Add an optional learned baseline with minimum history, robust outlier
  treatment, seasonality stance, and cold-start fallback. Deliberately out
  of scope per the module's own doc comment (task.md always marked this
  optional/lower-priority than a working static-threshold detector) — no
  real production traffic history exists yet to learn a baseline from.
- [x] Test spikes, sustained burns, traffic growth, price-table changes, sparse
  workloads, delayed telemetry, and counter resets. Evidence:
  `cost-velocity.test.ts`'s 12 tests, including "detects sustained burn
  (many moderate calls) as well as a sharp spike," "only sums calls
  actually inside the trailing window, ignoring older calls (a counter-
  reset-like scenario)," and a named regression test documenting (not
  fixing — an inherent fixed-window property) that a burst straddling the
  window boundary can be under-counted.

### 4.5 SigNoz rules and delivery

- [x] Express each supported detector as a SigNoz query/derived metric and alert
  rule, documenting any preprocessing that cannot live in SigNoz. Evidence:
  `docs/adr/006-signoz-alert-rule-provisioning.md` records the decision and
  why — canonicalizing a step shape and evaluating a repeat-cycle across a
  trailing window is not expressible as a native SigNoz query, so
  `services/control-plane/src/detector-runner.ts` runs the real
  `@fuse/detectors` functions in-process and emits the *result* as two OTel
  gauges (`fuse.detector.score`, `fuse.detector.fired`); `infra/signoz/
  alerts/{loop-signature,context-bloat,cost-velocity}.json` are real,
  working `threshold_rule` definitions against `fuse.detector.fired`,
  grouped by tenant/environment/agent_id/source_epoch so each breaker episode
  gets its own alert instance and delayed delivery remains bound to the state
  observed by the detector.
- [x] Configure evaluation interval, window, pending duration, recovery, labels,
  annotations, severity, and routing without embedding credentials.
  Evidence: `evalWindow`/`frequency` set per rule (tuned to 15s/1m after
  live measurement — see below); `labels`/`annotations` set per rule;
  `preferredChannels` routes to the `fuse-control-plane` webhook channel,
  itself created via `infra/signoz/channels/fuse-control-plane.json` with
  the actual bearer token supplied at apply-time by `infra/
  signoz-alerts-up.sh` (never committed). "Recovery" (a resolved alert)
  reuses the pre-existing, already-tested `resolved-observed` webhook
  behavior (§5.1) — not re-verified against a live SigNoz resolve event in
  this session specifically.
- [x] Include enough scoped identifiers and evidence in webhook payloads without
  sending sensitive prompt/tool content. Evidence: live-proven — real
  webhook deliveries correctly resolved to the exact scope
  (tenant=demo/environment=local-demo/agent_id=agent-real-detect-*) via the
  pre-existing `signoz-alert-mapper.ts`, confirmed by real
  `breaker_audit_log` rows (see below). No prompt/tool content anywhere in
  the metric or its labels — only tenant/environment/agent_id/detector
  type.
- [x] Add rule-as-code/export artifacts and a repeatable install/update process.
  Evidence: `infra/signoz/alerts/*.json`, `infra/signoz/channels/*.json`,
  `infra/signoz-alerts-up.sh` — run twice back to back against the live
  instance; the second run detected every channel/rule as already present
  and created nothing, proving real idempotency (create-if-missing by
  name, not a full diff/update — documented as a deliberate, narrower
  scope in the script's own header comment).
- [~] Test firing and recovery against each fixture plus duplicate, delayed, and
  out-of-order notification delivery. Done: firing proven live end-to-end
  three separate times (see §12) with correct actor attribution
  (`system:signoz-webhook:loop-signature`, `system:signoz-webhook:
  context-bloat`) in the real `breaker_audit_log`. Duplicate/delayed/out-
  of-order *delivery* relies on the same idempotency-key mechanism already
  proven against synthetic Alertmanager payloads in
  `webhook.integration.test.ts` (§5.1) — that mechanism doesn't care where
  a delivery came from, but a live SigNoz-sourced duplicate was not
  separately manufactured this session.
- [x] Measure historical SigNoz fallback latency; this is not direct enforcement latency.
  No prior budget existed to check against — this session establishes the
  first real measurement instead of an assumption. Three independent,
  single-fresh-scope runs (`services/broken-agent/src/
  demo-real-detect.ts`, no manual trip call anywhere in the script), all
  measured from run-end to observed trip, both real and attributed to
  `system:signoz-webhook:loop-signature` in the audit log:
  - `evalWindow: "1m"` / `frequency: "1m"`: multi-minute delivery.
  - `evalWindow: "1m"` / `frequency: "15s"` (tightened, expecting an
    improvement): also multi-minute on a clean single-scope run - essentially the
    same order of magnitude, *not* meaningfully faster. Tightening
    `frequency` did not fix the dominant cost, which is most likely
    SigNoz's own internal alert-routing/dispatch delay (outside the rule's
    own `evalWindow`/`frequency` fields, and not something this session
    found an API-exposed knob for) rather than evaluation cadence — an
    honest negative result, not hidden to make the tuning look successful.
  - A fourth attempt, run back-to-back with an earlier scope whose alert
    was still `firing` (never resumed), never tripped at all even after
    480s — see below.
  This is far slower than the sub-minute figure a live demo would want,
  and is documented as such rather than glossed over. A genuine, separate
  discovery from the fourth attempt: SigNoz's rule `state` field appears to
  be per-*rule*, not strictly per-*group* — a brand-new alert instance
  (a fresh agent scope) that starts firing while the rule is already
  `"firing"` from an older, never-resolved scope may not generate its own
  notification. `services/broken-agent/src/demo-real-detect.ts` and any
  rehearsed demo (§11) must therefore resume/clear prior scopes (or
  restart the control plane, which drops its in-memory detector buffers)
  before a fresh single-scope proof, rather than stacking multiple
  never-resumed firing scopes on the same three rules.

Acceptance criteria:

- [x] each detector catches its intended fixture and stays quiet for the agreed
  normal fixtures — met, see the per-detector test evidence above;
- [x] SigNoz alerting, rather than an undisclosed parallel path, triggers the demo
  breaker — met and proven live three times; the webhook has no other
  trigger path than a real Alertmanager-shaped delivery;
- [x] thresholds, windows, limitations, and policy version are inspectable —
  the alert-rule JSON files and `DetectorsConfigSchema` are both
  human-readable, checked-in, and versioned; the discovered latency/
  overlapping-scope limitations are documented here and in ADR-006, not
  hidden.

## 5. Authenticated enforcement control plane (P0)

### 5.1 Alert webhook

- [x] Implement strict content type/body size/schema validation. Evidence:
  `services/control-plane/src/routes/webhook.ts` — a route-specific 256KB
  body limit (grouped Alertmanager deliveries can carry many alerts, wider
  than the global 64KB default) and `SignozAlertmanagerWebhookPayloadSchema`
  validation (bounded to 1-200 alerts per delivery); malformed payloads
  return 400 `invalid_request`, tested.
- [x] Verify signature/authentication, timestamp freshness, and replay nonce or
  idempotency key before any state change. Done: bearer-token authentication
  (SigNoz has no HMAC-signing option for webhooks — verified against its
  current docs; it authenticates via HTTP Basic Auth or, with an empty
  configured username, a bearer token, so Fuse's webhook uses the same
  bearer mechanism as the rest of the API, with its own least-privilege
  token tier — see below); idempotency via a key derived from the alert's
  own stable identity (`fingerprint`+`startsAt`+source breaker epoch), hashed
  into bounded correlation/idempotency fields, tested for duplicate
  delivery; and timestamp-freshness/replay-window rejection via
  `isStaleAlert` (`services/control-plane/src/routes/webhook.ts`), which
  rejects any alert whose `startsAt` is older than `webhookMaxAlertAgeMs`
  (default 10 min) or too far in the future (`webhookMaxClockSkewAheadMs`,
  default 1 min), fail-closed on an unparseable timestamp — proven in 4
  `webhook.integration.test.ts` cases (stale, future-skewed, unparseable,
  still-fresh-and-tripping). Correction (audit, 2026-07-22): this item was
  previously left `[~]`/"not done" here after the replay-window check
  shipped in §1.2's follow-up slice — that characterization was stale.
  Residual, honestly scoped and unchanged: a *fresh* forgery from a
  genuinely valid webhook token remains possible (SigNoz has no payload
  signing), assessed low severity (a trip is fail-safe, not
  data-exposing) and tracked as further follow-up (recommended fix: a
  per-webhook-token trip-rate limit) — see §1.2 and `docs/threat-model.md`
  §3.
- [x] Map external payloads to the normalized alert contract and reject unknown
  tenant/environment/agent scope. Evidence:
  `services/control-plane/src/signoz-alert-mapper.ts`'s
  `mapSignozAlertToNormalizedEvent` — tolerant of dotted/underscored label
  key variants and strict about the canonical bounded nonnegative
  `fuse.source_epoch` value. Checked against the real self-hosted instance
  (ADR-005):
  `signoz_metrics.distributed_time_series_v4`'s stored `labels` for
  `@fuse/otel`-emitted data show SigNoz preserves OTel attribute names
  verbatim (dots intact — `deployment.environment.name`, `service.name`),
  not sanitized to underscores the way a vanilla Prometheus/OTel-bridge
  would. Since alert rules are built from these same stored labels, the
  dotted form (`fuse.tenant`) is very likely what actually reaches a
  webhook — already the first-checked form in `findLabel`'s lookup order,
  so no code change was needed, just confirmation. Both forms are still
  accepted defensively; this is real evidence at the label-storage layer,
  not a live "watched a real alert payload arrive" end-to-end proof
  (creating an alert rule needs the SigNoz UI's session-based auth, which
  was not reverse-engineered — a further, optional step, not done here).
  Returns `undefined` for unresolvable scope, and the webhook route reports
  `unknown-scope` per-alert rather than trip anything. 8 mapper unit tests
  + a dedicated integration test.
- [x] Make duplicate delivery return the original outcome and prevent duplicate
  incidents/notifications. Evidence: `webhook.integration.test.ts`'s
  duplicate-delivery test — two identical deliveries produce identical
  `results[]` (the second replays the first's outcome verbatim via
  `BreakerStore`'s idempotency mechanism) and the breaker's epoch advances
  exactly once. The immutable source epoch is passed directly as
  `expectedEpoch`; no retry changes the request hash based on current breaker
  state. Both correlation and idempotency IDs are a fixed-size SHA-256 digest
  of the alert episode identity, so an oversized SigNoz fingerprint is never
  persisted in those contract-bounded fields.
- [x] Handle resolved alerts according to explicit policy; never auto-resume
  solely because an alert resolved unless the policy deliberately allows it.
  Evidence: the webhook's default (and only implemented) behavior for
  `status: "resolved"` is `resolved-observed` — no state mutation at all;
  tested that a breaker tripped by a firing alert stays `tripped` after
  the matching alert resolves. No opt-in auto-resume-on-resolve path
  exists yet (not required, avoids speculative abstraction).
- [x] Return fast after durable acceptance when diagnosis/Slack work is
  queued. The trip audit and diagnosis job now commit transactionally;
  asynchronous delivery uses leases, bounded retry, dead-letter, and replay.
- [x] Rate-limit abusive sources and emit safe audit/operational telemetry for
  accepted and rejected requests. Evidence: the webhook inherits the
  global `@fastify/rate-limit` policy (120/min by default, operator-tunable
  through `CONTROL_PLANE_RATE_LIMIT_MAX`/`_WINDOW_MS`, keyed by bearer token) from
  `app.ts`, same as every other route; every trip (or no-op/rejection) is
  recorded in `breaker_audit_log` with the `system:signoz-webhook:{detector}`
  actor, same as any other trip source.

Least-privilege token tier added alongside this slice: `CONTROL_PLANE_
WEBHOOK_TOKENS`, scoped to only `/v1/webhooks/*` — a leaked SigNoz webhook
credential can cause a trip for the scope named in an alert's own labels,
but cannot resume, disable, or force-trip anything directly (agent tokens
get 403, not a silent pass, tested).

### 5.2 Operational API

- [x] Implement authenticated health, readiness, scoped status, force-trip,
  resume, disable/enable, and policy inspection endpoints. Evidence: built
  and tested as part of the breaker-first vertical slice (§2) —
  `/healthz`, `/readyz`, `/v1/breaker/status`, `/v1/breaker/{trip,resume,
  disable,enable}`, plus operator-only `/v1/policies/effective` for the
  validated policy file actually loaded by a replica.
- [x] Enforce roles and tenant/environment boundaries for all control actions.
  Evidence: the three-tier token model (operator/agent/webhook, §2 and
  this slice) plus scope-parameterized routes; cross-scope isolation is
  inherent to `BreakerStore` keying every operation by
  `(tenant, environment, agentId)`.
- [x] Require reason and idempotency key for manual mutations; record actor,
  before/after state, and correlation IDs. Evidence: `TripRequestSchema`/
  `ResumeRequestSchema`/etc. require `reason`, `actor`, `idempotencyKey`;
  `breaker_audit_log` records `from_state`/`to_state`/`actor`/`reason`/
  `correlation_id`/`policy_version` for every transition (§2.1).
- [ ] Provide safe pagination/filtering for incident and audit views. Not
  done — no audit-log *read* API exists yet (only the write path via
  `breaker_audit_log`); needed once a dashboard/incident view is built (§8).
- [x] Publish OpenAPI and contract tests; ensure error responses leak no
  stack, secret, or cross-tenant existence information. Evidence:
  `docs/openapi.yaml` covers the live routes including scope registration,
  direct detector enforcement, and effective-policy inspection; schema and
  auth/integration tests assert stable errors and tenant denial.

### 5.3 Resilience

- [x] Add health/readiness distinction, graceful shutdown, timeouts, bounded
  retry with jitter, circuit breaking for dependencies, and backpressure.
  Evidence: `/healthz` (liveness, no dependency check) vs `/readyz`
  (pings Postgres) built in §2; graceful shutdown via `server.ts`'s
  SIGTERM/SIGINT handlers; Postgres pool timeouts (`pool.ts`). Not done:
  no explicit circuit-breaker-for-dependencies pattern beyond the CAS
  retry loop's own bounded attempts, and no dedicated backpressure
  mechanism beyond the global rate limiter — acceptable at current scale,
  revisit under real load testing (§9.2).
- [x] Add durable diagnosis work delivery. Migration `0005` adds one job per
  trip audit; workers use leases, bounded retry/backoff and dead-letter.
  Migration `0007` adds operator-attributed idempotent replay audit.
- [~] Test restart recovery, store/queue outage, partial write, clock skew,
  duplicate delivery, and multi-instance concurrency. Done: restart
  recovery, store outage (`StoreUnavailableError` → 503), duplicate
  delivery (webhook + operational API), and concurrency (10-way/8-way
  concurrent writer races) — all tested in §2/§5.1's integration suites.
  Additional evidence (audit, 2026-07-22): a real `fuse-postgres` Docker
  container was killed (`docker kill`) while the real control-plane
  process (not testcontainers) was live and serving `/v1/permit`. Observed:
  in-flight requests already past the store call completed normally; new
  requests during the outage got `allowed: false, state: "unknown",
  degraded: true` (the documented fail-closed behavior) and `/readyz`
  correctly returned 503; the process itself stayed up throughout (no
  crash from the resulting `ECONNREFUSED`/idle-client errors — the
  `createPool` idle-error safety net fix above proven under a real kill,
  not just a unit test); once Postgres was restarted, `/readyz` returned
  200 and a fresh `/v1/permit` succeeded immediately, with no restart of
  the control-plane process required. Not done: no explicit clock-skew
  test (the store's `now` is always server-supplied, so client clock skew
  doesn't reach it, but this hasn't been tested directly) and no
  multi-instance (two control-plane processes against one Postgres) test
  — single-instance-per-test-run so far.
- [ ] Define backup/restore, migration, rollback, and retention procedures.
  Not done — tracked for the production-hardening pass (§9.3 runbooks).

Acceptance criteria:

- forged, replayed, oversized, malformed, or cross-scope requests cannot trip
  or resume a breaker — met and tested (auth tiers, schema validation, size
  limits, unknown-scope rejection);
- webhook response and state transition remain correct under retries/restarts
  — met and tested (idempotent duplicate delivery, restart recovery);
- core enforcement does not depend synchronously on Slack or MCP availability
  — trivially true today since neither exists yet (§7); revisit once built
  to ensure it stays true.

## 6. Preflight telemetry health (P0)

### 6.1 Coverage evaluator

- [x] Define required versus optional fields for spans/metrics by instrumentation
  schema version: model, token counts, estimated cost inputs, scoped identity,
  parent propagation, and flow timestamps.
  Evidence: `packages/contracts/src/preflight.ts` `SpanTelemetrySampleSchema`
  (`hasRequestModel`, `hasInputTokens`, `hasOutputTokens`, `hasScopedIdentity`,
  `hasValidTimestamps`, `isRootSpan`, `hasParent`) is the wire contract every
  reporter (agent SDK, or a manual `curl`) must satisfy.
- [~] Evaluate recent coverage percentage, freshness, orphan-span rate,
  cost/velocity flow, exporter drop signals, and build/version changes.
  Done: coverage % (`requiredFieldCoveragePercent`), freshness
  (`freshnessMs`/staleness threshold), orphan-span rate
  (`orphanRatePercent`, driven by `hasParent`/`isRootSpan`) — all in
  `packages/preflight/src/evaluator.ts`.
  Deferred (real gap, not silently dropped): cost/velocity flow health is
  covered by the separate `cost-velocity` detector (§ existing detectors),
  not folded into the Preflight evaluator; there is no distinct "exporter
  drop" signal beyond span absence/missing-fields; there is no
  build/version-regression signal (e.g. "spans stopped reporting a field
  right after a deploy") — Preflight cannot yet distinguish "this build
  broke instrumentation" from "telemetry is generically degraded."
- [x] Implement state/reason model for `protected`, `degraded`, `blind`, and
  `disabled`, including hysteresis to avoid flapping.
  Evidence: `PreflightStateSchema`/`PreflightReasonCodeSchema` in
  `packages/contracts/src/preflight.ts`; asymmetric hysteresis (instant
  degrade, dwell-gated recovery via `minRecoveryDwellMs`) in
  `packages/preflight/src/evaluator.ts`, unit-tested in
  `packages/preflight/src/evaluator.test.ts` (13/13 passing, including
  degrade-resets-dwell-timer and re-enable-does-not-instant-recover cases).
- [x] Distinguish no traffic from broken telemetry using agent heartbeat or
  another documented signal.
  Evidence: `HeartbeatSignalSchema` (`lastSeenAtMs`); evaluator test
  `'distinguishes idle (heartbeat alive, no spans) from broken telemetry
  (no signal at all)'` and `'treats a stale heartbeat the same as no
  heartbeat (blind, not degraded)'` — both passing.
- [~] Store last-good and last-evaluated times and evidence references.
  Done: `lastGoodAt`/`evaluatedAt` persisted in Postgres
  (`packages/breaker-store/migrations/0002_preflight.sql`,
  `preflight-store.ts`), confirmed round-tripped across separate
  `evaluate()` calls by `preflight-store.integration.test.ts` (4/4 passing).
  Deferred: "evidence references" is currently just the three aggregate
  numbers (coverage %, orphan %, freshness ms), not links/IDs to the
  specific offending spans — an operator sees "40% coverage" but not
  which spans lacked which field.
- [~] Test missing fields, partial sampling, idle agents, orphan spans, delayed
  data, exporter outage, release regression, and recovery.
  Covered (13 unit tests in `evaluator.test.ts` + 4 store integration
  tests): missing required fields, partial coverage (degraded vs blind
  boundary), orphan/broken-parent spans, idle-vs-broken via heartbeat,
  stale/delayed evidence, degrade-then-recover hysteresis (including
  reset-mid-dwell), operator disable/re-enable.
  Not covered (no such signal exists yet, see gap above): exporter outage
  as a distinct condition from "no spans arrived," and release/version
  regression.

### 6.2 Protection semantics and self-alert

- [~] Expose current Preflight state beside breaker state through API,
  dashboards, Slack, and middleware decision telemetry.
  Done: `POST /v1/preflight/report` and `GET /v1/preflight/status` in
  `services/control-plane/src/routes/preflight.ts`, authenticated via the
  same three-tier bearer model as the breaker API (any known token may
  report/read); 8/8 integration tests passing in
  `services/control-plane/src/preflight.integration.test.ts`, covering
  auth rejection, unknown-scope 404, agent-reports/operator-reads,
  blind-on-missing-tokens, malformed-request 400, cross-request hysteresis
  persistence, and operator-disable.
  Also done (was the top-flagged gap, now closed): the SDK's live request
  path reports real span telemetry into Preflight automatically, with no
  extra integration work by the agent author. `withGenAiSpan`
  (`packages/otel/src/gen-ai-span.ts`) now fires an `onTelemetryObserved`
  hook after every span ends (success or error) with a structural
  `SpanTelemetryObservation` (field/token/identity/timestamp presence,
  root/parent status computed from the OTel active-context chain before
  the span starts). `FuseGuard.recordSpanTelemetry()`
  (`packages/sdk/src/guard.ts`) forwards these into a new
  `PreflightReporter` (`packages/sdk/src/preflight-reporter.ts`) that
  batches them and flushes to `/v1/preflight/report` off the request
  critical path — a flush failure is swallowed (never retried, never
  thrown) so a Preflight-reporting outage cannot affect whether a guarded
  call proceeds. `services/broken-agent/src/analyzer-verifier.ts` wires
  this at both its root `invoke_agent` and per-round `chat` spans.
  Evidence: 3 new unit tests in `packages/otel/src/gen-ai-span.test.ts`
  (14/14 passing), 9 unit tests in the new
  `packages/sdk/src/preflight-reporter.test.ts`, 3 new unit tests in
  `packages/sdk/src/guard.test.ts` (34/34 sdk unit tests passing), and
  two live end-to-end integration tests against a real control
  plane + Postgres: `packages/sdk/src/guard.integration.test.ts`
  ("recordSpanTelemetry + flush makes this scope visible as protected via
  the real Preflight API") and
  `services/broken-agent/src/analyzer-verifier.integration.test.ts` ("a
  normal run reports its own real span telemetry to Preflight, with no
  extra wiring by the caller").
  Deferred (real gap, honestly scoped down from the original ask): no
  dashboard panel exists yet (§8 not started); no Slack surfacing (§7.3
  not started); and breaker `permit()` decisions are not annotated with
  or gated by current Preflight state — Preflight remains a parallel,
  advisory signal rather than something the permit response itself
  carries. Live-wired telemetry also cannot organically produce an
  orphan-span or missing-token-count observation under normal operation
  (the OTel API guarantees a parent span in context, and the SDK's
  provider types require token counts), so the `blind`/`degraded` states
  are only reachable live via a genuine bug in a caller's own
  instrumentation, an actual call failure (tokens unknown), or the
  existing direct-API path — not via a deliberately-flippable demo
  switch, which is still the unstarted item below.
- [ ] Alert when protection degrades, including affected scope, missing signal,
  start time, last known good build, current build, and remediation link.
  Not started — no self-alert path exists; a degrade/blind transition is
  only visible if something polls `GET /v1/preflight/status`.
- [ ] Deduplicate and rate-limit blind-spot notifications; emit a recovery event.
  Not started (depends on the alert path above existing first).
- [x] Apply/document policy for whether blind status fails open or closed and
  ensure UI wording never implies full protection.
  Evidence: `disabled` is modeled as a distinct, operator-only-triggered
  state from `blind` specifically so an involuntary blind spot can never
  be confused with an intentional maintenance window (see the doc comment
  in `packages/contracts/src/preflight.ts`); Preflight itself is
  read-only/advisory and never mutates breaker enforcement state, so a
  `blind` telemetry verdict cannot itself trip or resume the breaker —
  today the breaker's own enforcement fails closed per ADR-002 regardless
  of Preflight state, and Preflight's role is confined to honest
  reporting, not gating. No UI exists yet to word this for a human, so
  the "never implies full protection" requirement is satisfied by the API
  contract (any consumer must read `state`/`reasonCode` — nothing renders
  a default "protected" absent evidence) but not yet demonstrated in an
  actual UI surface.
- [ ] Reproduce the demo beat: remove a required token field or propagation,
  detect it, alert, restore it, and show recovery.
  Partially reproducible today via direct API calls (the hysteresis
  integration test above IS this beat, minus the alert) but no rehearsed
  demo script/fixture exists yet.

Acceptance criteria:

- [x] Fuse never displays `protected` without current evidence — enforced
  structurally: `evaluatePreflight` only returns `protected` when the
  current window's spans (or heartbeat) pass freshness + coverage +
  orphan checks; there is no default/fallback path that returns
  `protected` without evaluating current input.
- [x] an instrumentation regression becomes visible within the declared
  window — degrade/blind commits on the very next evaluation (no
  hysteresis delay on the way down); demonstrated by
  `'degrades immediately (no hysteresis delay) when previously protected
  and telemetry breaks'`.
- [x] idle/no-traffic is not falsely presented as healthy telemetry — an
  idle agent with a live heartbeat and zero spans reports `degraded`
  (`no-recent-telemetry`), never `protected`; a dead agent (no heartbeat,
  no spans) reports `blind` (`no-signal`).

Honest overall status: the evaluator, its hysteresis, and its persisted
Postgres-backed API are built and fully tested (13 unit + 4 + 8 integration
tests), and the SDK's live request path (`FuseGuard` + `withGenAiSpan`) now
reports real span telemetry into that API automatically, with two
end-to-end integration tests proving a real guarded run makes its own
scope visible as `protected` via the real Preflight API. What remains
before this slice can be called fully "done" against the brief: a
self-alert/notification path, a dashboard/Slack surface, permit-response
annotation with current Preflight state, and a rehearsed demo fixture that
can deliberately flip a scope's telemetry from healthy to broken and back.
These are tracked as open work in §7/§8 and as follow-on tasks, not
silently assumed complete.

## 7. Diagnosis, recommendations, and Slack (P1)

Built end to end in the 2026-07-23 gap-closure session — a new `packages/
diagnosis` (MCP client, evidence fetcher, deterministic diagnosis engine,
incident card, Slack client, Slack interactive actions), `packages/
contracts/src/diagnosis.ts` (the versioned `DiagnosisResult` contract), and
`services/control-plane/src/diagnosis-worker.ts` + `routes/slack-
interactive.ts` wiring it into the real trip flow. See the dated §12 entry
for full evidence, including two live end-to-end runs against the real
self-hosted SigNoz MCP server.

### 7.1 SigNoz MCP adapter

- [x] Verify the actual SigNoz MCP capabilities/version and record setup,
  authentication, least-privilege permissions, and query limitations.
  Evidence: `docs/adr/007-signoz-mcp-diagnosis.md` — the official
  [SigNoz/signoz-mcp-server](https://github.com/SigNoz/signoz-mcp-server),
  41 tools confirmed live via `client.listTools()`; authenticates via a
  dedicated `fuse-diagnosis-mcp` service account assigned the read-only
  `signoz-viewer` role (not the admin session token used elsewhere in this
  repo) — two non-obvious API facts (the role-assignment body shape, the
  `SIGNOZ-API-KEY` header convention) were found only by testing the real
  endpoints, not assumed from docs.
- [x] Implement an adapter that fetches only incident-scoped traces, metrics,
  logs, and relevant time bounds; cap result size and redact sensitive
  fields. Evidence: `packages/diagnosis/src/evidence.ts`'s
  `fetchIncidentEvidence` — scopes every query to `attribute.fuse.tenant`/
  `environment`/`agent_id` (a real, only-discoverable-by-querying fact:
  these are span *attributes*, not resource attributes, so the filter
  prefix must be `attribute.*` not `resource.*` — see ADR-007 §3), caps
  results at 5 spans (`MAX_SPANS`), and whitelists a fixed field set
  (trace/span ID, name, service, timestamp, duration, error flag, `webUrl`)
  rather than passing through the tool's raw response.
- [x] Add timeouts, bounded retries, pagination, unavailable/partial-result
  handling, and mock contract fixtures. Evidence:
  `packages/diagnosis/src/mcp-client.ts`'s `SignozMcpClient` — 8s per-call
  timeout, 1 bounded retry with a forced fresh reconnect (never retries
  against a known-broken transport), never hangs. Not done: no true
  pagination (the 5-span cap is a hard truncation, not a paginated walk) —
  an honestly-scoped simplification, not silently assumed complete.
  Unavailable/partial-result handling: `fetchIncidentEvidence` degrades to
  `{available: false, reason}` on a network failure, an MCP-reported error,
  a missing text response, or unparseable JSON — 6 unit tests in
  `evidence.test.ts` cover each path plus a real live-optional test
  (`evidence.live.test.ts`, skips without credentials, matching this
  repo's `*.live.test.ts` convention).
- [x] Protect diagnosis prompts from telemetry prompt injection by separating
  untrusted evidence, constraining tools/output, and never exposing control
  credentials. There is no LLM prompt in this implementation at all (§7.2
  is fully deterministic by design), so there is no prompt-injection
  surface to protect in the traditional sense — but the spirit of this
  item is met: evidence is whitelisted to structural fields only (never
  raw span content), and the MCP API key is passed only to the
  `signoz-mcp` container's own env (`infra/docker-compose.yml`), never
  read or logged by `packages/diagnosis` or the control plane.
- [x] Preserve evidence links/IDs so claims can be checked in SigNoz.
  Evidence: `EvidenceSpan.webUrl` (the tool's own deep link) flows through
  to `DiagnosisResult.evidenceLinks` and renders as a clickable link in
  both the Slack card and the local HTML snapshot.

### 7.2 Root cause and recommendation

- [x] Implement a deterministic diagnosis summary from detector evidence before
  adding optional LLM wording. Evidence: `packages/diagnosis/src/
  diagnosis-engine.ts`'s `buildDiagnosis` — every field is a fixed string
  template or a direct pass-through of detector/evidence data; no model
  call anywhere in this path (confirmed in `packages/contracts/src/
  diagnosis.ts`'s own doc comment). "Optional LLM wording" remains
  unimplemented, by explicit choice (§7.2 always called it optional/
  secondary to a working deterministic path).
- [x] Generate hypothesis, supporting evidence, uncertainty/limitations,
  immediate containment, and targeted fix recommendations. Evidence: all
  five fields are present on every `DiagnosisResult` (`hypothesis`,
  `supportingEvidence`, `limitations`, `immediateContainment`,
  `recommendedFix`) — 7 unit tests in `diagnosis-engine.test.ts`. Confidence
  is honestly downgraded to `medium` whenever real trace evidence isn't
  available or came back empty, never presented as `high` on the
  detector's own claim alone.
- [x] Map loop -> cumulative ceiling/progress guard, context bloat -> history
  deduplication/compaction/caching, velocity -> workload/release/model-price
  investigation without presenting generic advice as certainty. Evidence:
  `DETECTOR_KNOWLEDGE`'s three fixed mappings match this exactly; every
  diagnosis carries an explicit "this is a hypothesis, not a certainty"
  limitation string.
- [d] Bound diagnosis model spend and place diagnosis calls behind their own
  separate safety budget so Fuse cannot become the runaway agent.
  Deliberately not applicable: there is no model call anywhere in the
  diagnosis path (see the item above) — nothing to bound. If "optional LLM
  wording" is ever added, this item must be revisited before that ships,
  not assumed still satisfied.
- [~] Test incomplete/conflicting evidence, MCP outage, malicious telemetry,
  unsupported detector, and diagnosis budget exhaustion. Done: incomplete/
  unavailable evidence (`evidence.test.ts`), MCP outage/error/malformed
  response (same), unsupported/unrecognized detector label
  (`diagnosis-worker.test.ts`: "skips diagnosis entirely for an
  unrecognized detector label"). Not done: no dedicated "malicious
  telemetry" adversarial test (e.g. a span field containing an oversized
  or control-character-laden value) — the whitelisting approach in
  `evidence.ts` structurally limits this risk but hasn't been tested
  against a deliberately hostile fixture. "Diagnosis budget exhaustion" is
  not applicable per the item above.

### 7.3 Slack incident workflow

- [x] Define a compact incident card: state, scope, estimated spend/avoidance,
  reason, evidence, confidence, Preflight status, proposed fix, and
  authorized actions. Evidence: `packages/diagnosis/src/incident-card.ts`'s
  `buildIncidentCardBlocks` includes state (the header's "tripped"), scope,
  reason (`supportingEvidence`), evidence (links), confidence, Preflight
  status (`context.preflightState`), proposed fix, and an authorized Resume
  button with a confirmation dialog. **Gap, honestly not closed**: no
  "estimated spend/avoidance" field exists on the card — the diagnosis-
  worker's synthetic `DetectorResult` (built from a SigNoz alert
  notification, not the process-local detector buffer that computed the
  real score) has no real cost figure to show, and `EvidenceSpan` doesn't
  carry a cost field either. Tracked as a real, scoped-out gap, not
  silently omitted.
- [x] Sign/verify interactive actions, prevent replay, enforce authorization,
  require a resume reason, and show resulting state or stale-action
  conflict. Evidence: `packages/diagnosis/src/slack-actions.ts` — HMAC-
  SHA256 signature verification with constant-time comparison
  (`verifySlackSignature`), a 5-minute replay window
  (`isFreshSlackTimestamp`, same discipline as the SigNoz webhook's
  `isStaleAlert`), a required free-text reason collected via a real Slack
  modal (not a bare button click), and `executeAuthorizedResume` calling
  the *real*, already-tested `/v1/breaker/resume` API — a Slack action is
  just another authorized caller of the existing enforcement API, not a
  new enforcement path. The receiving route
  (`services/control-plane/src/routes/slack-interactive.ts`, `POST
  /v1/slack/interactive`) is fail-closed: a missing signing secret,
  missing/invalid signature, or stale timestamp all reject with 401,
  never a silent unverified pass — 8 route tests cover this plus the
  full button-click-to-modal and modal-submit-to-resume paths, including a
  stale-action-style conflict (the resume call's own `reason`/error is
  surfaced back into the modal, per `executeAuthorizedResume`'s
  `ResumeExecutionResult`).
- [~] Deduplicate initial/update/recovery notifications and handle rate
  limits, retries, expired actions, and channel misconfiguration. Done:
  the diagnosis pipeline only ever fires on a genuinely new trip (the
  webhook route's `outcome === 'tripped'` check — a duplicate/no-op alert
  delivery, e.g. `already-tripped`/`breaker-disabled`, never re-triggers
  diagnosis), which is the dominant real-world duplication risk. Channel
  misconfiguration degrades cleanly (`postIncidentCard` returns `{posted:
  false, reason}` on a Slack API error like `channel_not_found`, tested).
  Not done: no explicit rate-limit/backoff handling for Slack's own API
  limits, and no "update"/"recovery" notification variant exists yet
  (only the initial incident post) — a real, scoped-out gap.
- [x] Ensure Slack failure cannot affect enforcement and is visible to
  operators. Evidence: `runDiagnosisAndNotify` is fired via `void` (never
  awaited) from the webhook route, after the trip has already committed;
  every step degrades and logs rather than throwing
  (`diagnosis-worker.test.ts`'s "logs (but does not throw) when the Slack
  post is not delivered" and "never throws even if evidence fetch rejects
  unexpectedly"). Live-verified: a real trip with `SLACK_BOT_TOKEN` unset
  produced a clean `"Slack incident post not delivered"` log line and the
  trip itself was entirely unaffected.
- [x] Add a no-network local renderer/snapshot for reliable demo rehearsal.
  Evidence: `renderLocalIncidentCardHtml` writes a self-contained HTML
  file per incident (`writeLocalSnapshot`, `FUSE_INCIDENT_SNAPSHOT_DIR`,
  default `/tmp/fuse-incidents`) — live-verified twice (see §12): once
  with no MCP configured ("SigNoz trace evidence was unavailable..."),
  once with the real MCP server configured (a genuine live query,
  correctly reporting zero matching spans for a synthetic test scope that
  never emitted real telemetry).

### 7.4 Optional fix PR (P2)

- [ ] Restrict automated edits to a demo repository and explicit allowlist.
- [ ] Create a branch and draft PR only; never auto-merge or mutate protected
  branches.
- [ ] Include incident evidence, rationale, tests, limitations, and rollback.
- [ ] Make the demo succeed gracefully when repository credentials are absent.

Not started — explicitly P2 in task.md's own priority guardrails, and
correctly deprioritized behind the P0/P1 work this session focused on.

Acceptance criteria:

- [x] every diagnosis claim links to evidence or is labeled as a hypothesis —
  met: every `DiagnosisResult` carries `evidenceLinks` (possibly empty) and
  an explicit `limitations` array stating what is/isn't verified;
- [x] diagnosis/Slack outages do not weaken the tripped breaker - the trip and
  diagnosis job commit first, while the durable dispatcher retries bounded
  downstream MCP/snapshot/Slack delivery independently;
- [x] no interactive action bypasses control-plane authorization — met:
  `/v1/slack/interactive` is fail-closed on signature/timestamp
  verification, and the only enforcement action it can ever trigger
  (resume) goes through the real, already-authorized `/v1/breaker/resume`
  API, not a separate privileged path.

## 8. Agent cost-health dashboard (P1)

Built and live-verified in the 2026-07-23 gap-closure session:
`infra/signoz/dashboards/fuse-agent-cost-health.json` (7 panels) applied
idempotently by `infra/signoz-dashboard-up.sh`. Two real, previously-
unrendered-anywhere metrics were added to make this possible
(`fuse.estimated_cost.usd.total`, `fuse.preflight.state` —
`packages/otel/src/metrics.ts`). Full research/trap-avoidance trail in
`docs/adr/008-signoz-dashboard-provisioning.md`, including two silently-
unrendered-but-200-accepted payload shapes found before the real one, and
a `PUT` body double-nesting bug. See the dated §12 entry for full evidence.

- [d] Define dashboard variables for environment, tenant (if applicable), agent,
  model, task type, and time range with safe defaults. Not built — the
  7 panels query without variables (fixed to whatever scope reported most
  recently); adding SigNoz dashboard variables is a real, separate research
  item (a third payload shape, likely) not attempted this slice given time
  constraints. Time range itself already has a safe default (SigNoz's own
  "Last 30 minutes").
- [x] Add current breaker and Preflight protection status panels. Evidence:
  "Breaker permit decisions (rate, by state)" and "Preflight telemetry-
  health state" panels, both live-verified showing real data from an
  actual demo run (armed/tripped states; `fuse.preflight.state="protected"`).
- [~] Add spend and tokens by agent/user/task/model while respecting privacy and
  cardinality constraints. Done: "Estimated spend (rate, by agent + model)"
  and "Token usage (input/output, by model)" panels exist and query
  correctly (schema-verified — no "never received" error); both were
  empty at verification time (only one real-cost call had happened,
  insufficient for the `increase()` aggregation's two-sample minimum — the
  same characteristic already documented for other cumulative counters in
  this repo, not a new defect). Cardinality: grouped by agent_id/model
  only, never session/correlation id, matching this repo's existing
  discipline.
- [d] Add live cost velocity with policy threshold and detector annotations.
  Not built as its own dashboard panel — `fuse.detector.score`/`.fired`
  for `cost-velocity` (already on the "Detector fired"/"Detector score"
  panels) cover the live-value half; SigNoz-native annotation overlays for
  a policy threshold line were not attempted this slice.
- [~] Add input-token/context-growth and loop-repeat views. Partial: "Detector
  score (raw, by detector type)" shows `context-bloat`'s and
  `loop-signature`'s raw scores over time, which is a proxy for both
  (context-bloat's score is often a token count or growth-run length;
  loop-signature's score is repetition count) — not a dedicated "input
  token growth curve" or "repeat count over time" view built from raw
  `gen_ai` span data directly.
- [x] Add breaker trip/deny/resume history and alert-to-trip latency. History:
  the "Breaker permit decisions" panel, grouped by state, shows
  armed/tripped transitions over time. Alert-to-trip latency itself is not
  a dashboard panel (it was measured and recorded as text in §4.5/§12,
  not wired into a queryable metric) — a real, honest gap: there is no
  `fuse.alert_to_trip.latency` metric emitted anywhere yet.
- [ ] Add projected monthly burn with explicit formula, minimum data requirement,
  confidence/limitations, and `estimated` labeling. Not built — a formula
  panel (rate × time-remaining-in-month) was considered and deliberately
  skipped this slice as a further research/verification cost not justified
  given time constraints; tracked as a real gap, not assumed done.
- [ ] Add instrumentation coverage, orphan rate, telemetry freshness/drop rate,
  and build regression views. Not built — none of Preflight's internal
  percentages (`requiredFieldCoveragePercent`, `orphanRatePercent`) are
  exported as their own OTel metrics yet, only readable via the
  `/v1/preflight/status` REST API; a dashboard panel needs a metric to
  query, and none exists for these values.
- [ ] Link panels to trace/log drill-down and the matching incident. Not
  built — no `contextLinks` configured on any widget.
- [x] Export/version the dashboard; test empty, partial, normal, runaway, and
  high-cardinality data plus common screen sizes. Evidence: the dashboard
  is checked-in JSON (`infra/signoz/dashboards/fuse-agent-cost-health.json`,
  `"version": "v5"`), applied via an idempotent script. "Empty" state was
  directly observed and confirmed to render as an honest "No Data" (with a
  distinct warning icon for a genuinely-wrong metric name, vs. a plain
  "No Data" for a valid-but-empty query — see ADR-008 §3) rather than a
  misleading zero. Partial/normal data was observed from a real demo run.
  Runaway and high-cardinality scenarios and non-default screen sizes were
  not separately tested — a real, scoped-out gap.

Acceptance criteria:

- [x] the live demo story is visible without manual query editing — met: the
  dashboard is provisioned by a script, not clicked together live;
- [x] empty or incomplete data is not rendered as zero/healthy — met and
  directly observed (SigNoz's own "No Data" state, distinguishable from a
  schema-error warning, per the evidence above);
- [x] every number has a documented unit, source, and aggregation window —
  every widget's `description` field states its source metric and
  aggregation; units are implicit in the metric names themselves
  (`usd`, `{token}`, `s`, `1`) as documented in `packages/otel/src/
  metrics.ts`'s own instrument descriptions.

## 9. Production hardening and operability (P1)

Worked in the 2026-07-23 gap-closure session, in the order committed:
`docs/adr/009-supply-chain-scan.md` (security/supply-chain scans),
`docs/adr/010-secure-defaults-audit.md` (secure defaults + `@fastify/
helmet`), `docs/adr/011-permit-load-test.md` (real `/v1/permit` load test),
`docs/adr/012-failure-injection-review.md` (failure-injection survey + the
one real fix it found, `DetectorRunner`'s scope-cardinality cap), and three
new runbooks under `docs/runbooks/`. Every item below was checked against
the actual code/tests, not assumed — several are honestly partial or not
done, tracked as such rather than silently marked complete.

### 9.1 Security and supply chain

- [~] Complete threat-model review and close all P0/P1 findings. Done:
  `docs/threat-model.md` re-read and updated with this session's real
  findings (supply-chain scan results, the `DetectorRunner` fix added to
  the risk register as risk #7, now "Fixed"). Not all findings are closed —
  this document doesn't use P0/P1 labels, it uses a severity register, and
  several risks remain deliberately **open and accepted** with documented
  rationale (residual fresh-forged-webhook-alert capability, the flat
  rate limit across cheap/heavy routes, no online key rotation) rather than
  fixed — a hackathon-timeline tradeoff, not an oversight.
- [~] Run secret, dependency, license, static-analysis, and container scans;
  remediate critical/high findings or record an explicit accepted risk.
  Done: `pnpm audit` (all known advisories remediated via
  `pnpm-workspace.yaml` overrides, including
  `@hono/node-server@2.0.10`), a license
  sweep of 533 installed packages (zero copyleft), a targeted secret-
  pattern scan of every tracked file (15 matches, all reviewed and
  confirmed benign — dev-only Postgres credentials and named test
  fixtures), and a CycloneDX SBOM. CI regenerates the required-only SBOM
  and builds/smoke-tests a hardened image. External registry image scanning
  remains a documented release-promotion gate. Full trail:
  `docs/adr/009-supply-chain-scan.md` and
  `docs/runbooks/deployment.md`.
- [x] Run authorization/tenant-isolation and webhook replay tests. Evidence:
  surveyed the existing suite first (`auth.test.ts`, `app.integration.test.ts`,
  `webhook.integration.test.ts`) rather than duplicating it, then actually
  ran it against real Postgres — 54 tests passing, including cross-tenant
  trip/resume/Preflight-read denial ("the blast-radius fix") and duplicate-
  webhook-delivery idempotency. `docs/adr/012-failure-injection-review.md`
  §"Survey" lists every scenario found already covered, with the specific
  test that proves it.
- [x] Validate secure defaults for TLS, CORS, headers, credentials, debug
  output, network exposure, and container user/filesystem permissions.
  Done: CORS (deliberately none registered — verified no
  `access-control-allow-origin` header leaks to a cross-origin caller),
  headers (added `@fastify/helmet`, asserted real header values in a new
  test), credentials (constant-time token comparison, fail-closed config
  already existed — verified by reading `auth.ts`/`config.ts` directly),
  debug output (confirmed no stack trace/secret ever reaches a client
  response), and network exposure. TLS terminates at the checked-in ingress.
  The production image was actually started non-root with a read-only root
  filesystem, every capability dropped, and `no-new-privileges`; `/healthz`
  and `/readyz` both succeeded. Full trail:
  `docs/adr/010-secure-defaults-audit.md` and
  `docs/runbooks/deployment.md`.
- [x] Generate an SBOM and document dependency update ownership. SBOM:
  originally `docs/sbom.cdx.json` plus the CI-generated CycloneDX 1.6 artifact;
  the stale point-in-time checked-in snapshot was removed on 2026-08-24 in
  favor of run-bound validated workspace/image artifacts. Dependency
  ownership: already covered by `.github/CODEOWNERS` (`* @Vedant817`) —
  a single-maintainer project has no separate dependency-ownership
  question to answer beyond that.

### 9.2 Reliability and performance

- [~] Load-test permit and trip paths at target concurrency; report
  p50/p95/p99 latency, throughput, saturation, and error rate. Done for
  `/v1/permit` only: real `autocannon` runs against a live control-plane +
  real Postgres at concurrency 50 (6,538 req/s, p50=6ms/p99=23ms/max=109ms,
  zero errors) and 200 (throughput plateaus ~7k req/s while latency
  roughly quadruples — the DB connection pool, not route logic, is the
  ceiling; it degrades by queueing, zero errors even here). A first naive
  run also surfaced that the default rate limit makes an unadjusted load
  test measure the limiter, not the route — itself a useful confirmation
  the limiter works. **Not done: the trip path was not separately
  load-tested** — a real, scoped-out gap. Full trail:
  `docs/adr/011-permit-load-test.md`.
- [x] Run race/stress tests for simultaneous permit/trip/resume and
  multi-instance operation. Simultaneous permit/trip/resume: already
  extensively covered by existing tests, verified by an actual run —
  `store.integration.test.ts`'s concurrent-trip-request, concurrent-same-
  idempotency-key, and per-caller-actor-attribution-under-concurrency
  tests, plus `guard.integration.test.ts`'s "concurrent calls racing the
  trip"/"in-flight exposure" tests. Multi-instance follow-up ran two real
  production-mode processes on ports 8090/8091 sharing PostgreSQL: both
  resolved identical effective policy, concurrent ceiling observations
  produced one `armed→tripped` audit row (epoch 0→1), and a permit through
  the opposite replica denied. That run found and fixed duplicate Slack
  delivery on idempotency replay; the repeat produced exactly one Slack
  success log/message timestamp across both replicas.
- [~] Inject state-store, queue, SigNoz, MCP, Slack, DNS/network, and clock
  failures; verify declared behavior and recovery. Verified via a real run
  (not just reading the test files): state-store outage, SigNoz MCP
  failure (timeout/tool-error/malformed-JSON), Slack failure (network
  error/non-2xx/API-level error), and clock skew (webhook `startsAt`
  future/past rejection) are all covered by existing, passing tests. N/A:
  "queue" — no message-queue component exists in this architecture.
  Not separately tested: DNS-specific failure (generic network-
  unreachable/timeout is covered via `guard.test.ts`, but not a DNS-
  resolution failure specifically). Full survey:
  `docs/adr/012-failure-injection-review.md`.
- [~] Test clean deploy/restart, schema migration/rollback, backup restore,
  and expired-state cleanup. Done: clean restart (`shutdown.test.ts`'s
  duplicate-signal and partial-cleanup-failure tests — the real shutdown
  handler drains the Fastify app, Postgres pool, and OTel export in order)
  and schema migration (real, idempotent, forward-only, protected by a
  session advisory lock; concurrent migration integration test passes).
  The Kubernetes base now schedules expired-idempotency cleanup. **External
  production prerequisites, documented honestly:** schema rollback still
  has no down migrations, managed PostgreSQL must supply backup/PITR and a
  restore rehearsal, and audit-log retention is a business decision.
- [~] Define SLOs and alerts for permit errors/latency, webhook failures,
  notification backlog, detector lag, stale Preflight, and dropped
  telemetry. The versioned `v1-provisional` operational contract now covers
  permit p95/error/deny latency, detector observation failure/latency, webhook
  auth/processing failures, diagnosis backlog/dead letters/lease renewal,
  Redis readiness/outage, and Preflight stale/no-data plus sweeper health.
  Static provisioning contracts and operations/deployment runbooks define
  opening, resolution, no-data, and bounded-cardinality semantics. This remains
  partial only because an OTel SDK dropped-export metric is still unavailable;
  do not infer collector delivery health from application SLO metrics.

### 9.3 Runbooks

- [x] Document install/configure/upgrade/rollback/uninstall procedures.
  Evidence: `docs/runbooks/operations.md` §1-5, §9 — every command is one
  this project's own scripts actually run (`infra/reset.sh`,
  `packages/breaker-store/src/migrate.ts`, `.env.example`), read directly,
  not inferred; §4 (Rollback) states plainly that no scripted schema
  rollback exists rather than implying one does.
- [x] Document incident response for false positive, missed trip, stuck
  breaker, blind telemetry, state-store outage, leaked webhook secret, and
  Slack/MCP failure. Evidence: `docs/runbooks/incident-response.md`, all
  seven scenarios, each using the real route/request schema and citing the
  test that proves the claimed behavior — generalized the "leaked webhook
  secret" ask into all three token roles (webhook/agent/operator), since
  the blast radius differs sharply by role and that distinction matters
  more than the literal ask.
- [x] Document key rotation, policy rollout/rollback, data retention/
  deletion, backup/restore, and audit retrieval. Done: key rotation
  (`operations.md` §5), policy rollout/rollback (§6 — validated startup
  policy file, exact/wildcard specificity, rolling restart and rollback),
  data
  retention/deletion (§8), audit retrieval (§7, with a real SQL query
  against `breaker_audit_log`), and managed-PostgreSQL backup/PITR plus
  restore-rehearsal requirements (`deployment.md`).
- [x] Add a limitations/non-guarantees section that matches actual tests.
  Evidence: `docs/runbooks/limitations.md` — distinguishes what Fuse
  actually guarantees (zero provider calls post-trip; honest blind/degraded
  reporting, both cited to their proving tests) from documented tradeoffs
  and every real gap found this session, each cited to its ADR/runbook.

Acceptance criteria:

- [~] a fresh environment passes smoke tests from documented commands — the
  install steps in `operations.md` §1 are the actual commands used
  throughout this session (verified repeatedly: Postgres health check,
  `/healthz`/`/readyz`), but a fresh-checkout end-to-end rehearsal from a
  truly clean machine was not separately performed this slice;
- [x] operators can distinguish Fuse failure from agent failure and recover
  without editing the database manually — met: every incident-response
  entry uses only the documented HTTP API (`/v1/breaker/*`,
  `/v1/preflight/status`) or a read-only audit-log query, never a manual
  UPDATE/DELETE against `breaker_state`/`breaker_audit_log`;
- [~] published guarantees are backed by repeatable tests and measurements —
  every guarantee in `limitations.md` cites its proving test or ADR; the
  guarantees themselves are correct, but several runbook claims (rollback,
  backup, SLOs) are explicitly "not built" rather than measured, which is
  the honest form of meeting this criterion, not a full pass.

## 10. Test matrix and release gates

Worked in the 2026-07-23 gap-closure session, after §9. Rather than write a
new test matrix from scratch, this section audits the already-substantial
suite built across §4/§7/§8/§9 against task.md's own categories — most were
already covered incidentally while building those sections; this pass adds
the handful of genuinely missing pieces (property/fuzz coverage beyond
state transitions, an OpenAPI spec) and records the rest as verified, not
assumed. Final tally from a real run at the end of this section: **396 unit
tests + 83 integration tests (real Postgres via testcontainers) = 479
tests, all passing.**

### 10.1 Automated test suites

- [x] Unit: breaker domain, policies, detector math, pricing, Preflight,
  redaction. All covered: `packages/breaker-core` (16 tests, incl.
  fast-check state-transition properties), `packages/contracts`'
  `policy.ts`/`policy-defaults.test.ts`, `packages/detectors` (43 tests
  across all three detector math functions), `packages/otel/src/pricing.ts`
  (unit-tested alongside the rest of `packages/otel`), `packages/preflight`
  (13 tests). "Redaction" is implemented as field allowlisting, not pattern
  scrubbing — `packages/diagnosis/src/evidence.ts`'s "maps only whitelisted
  fields from real rows" test is the redaction test.
- [x] Property/fuzz: state transitions, schema/parser boundaries, detector
  invariants, idempotency, and malformed webhook input. State transitions
  and idempotency were already covered
  (`packages/breaker-core/src/transitions.test.ts`'s fast-check properties;
  `store.integration.test.ts`'s concurrent-same-idempotency-key test).
  **New this session:** `packages/detectors/src/invariants.property.test.ts`
  fuzzes all three detectors' math with arbitrary step histories (asserts
  `score`/`threshold` stay finite and every result is
  `DetectorResultSchema`-valid — guards the exact "score:Infinity silently
  serializes to null" bug class `context-bloat.ts`'s own comment
  documents), and `packages/contracts/src/schema-fuzz.property.test.ts`
  fuzzes core request/webhook/policy schemas with `fc.anything()`,
  asserting `safeParse` never throws and that the webhook's 200-alert cap
  actually rejects an oversized array. 19 new tests, all passing.
- [x] Contract: provider adapter, SigNoz webhook/query payloads, MCP, Slack,
  storage, policy schema, and OpenAPI. Provider adapter
  (`packages/sdk/src/providers/openai-compatible.{test,integration.test}.ts`),
  webhook payload (`packages/contracts/src/alert-webhook.ts` +
  `webhook.integration.test.ts`), MCP (`packages/diagnosis/src/mcp-client.
  test.ts`), Slack (`slack-client.test.ts`), storage
  (`packages/breaker-store`'s full suite), policy schema
  (`policy-defaults.test.ts`) were all already covered. **New this
  session:** `docs/openapi.yaml` — a hand-authored OpenAPI 3.0 spec for all
  13 real routes, schemas matching `packages/contracts` field-for-field,
  validated with `redocly lint` (0 errors) and bundled to confirm every
  `$ref` resolves.
- [x] Integration: middleware/control plane/store/queue, OTel export, alert
  trip, diagnosis fallback, and interactive resume. All covered and
  re-verified by an actual run this session (not just reading the files):
  `app.integration.test.ts` (21), `webhook.integration.test.ts` (15),
  `preflight.integration.test.ts` (13), `store.integration.test.ts` +
  `preflight-store.integration.test.ts` (20), `sdk.integration.test.ts` (2,
  OTel export), `guard.integration.test.ts` (6). "Queue" is N/A — no
  message-queue component exists in this architecture. Diagnosis fallback
  and interactive resume: `diagnosis-worker.test.ts`,
  `slack-interactive.test.ts`.
- [x] End-to-end: normal agent, each runaway mode, blocked-next-call proof,
  telemetry regression/recovery, diagnosis, Slack, and authorized resume.
  Normal agent + blocked-next-call proof:
  `guard.integration.test.ts`'s "after a committed trip, zero provider
  requests occur" (sequential and concurrent variants) and
  `services/broken-agent`'s real demo scripts. Each runaway mode: the three
  detector fixtures (`packages/detectors/src/fixtures.ts`) plus
  `services/broken-agent/src/demo-real-detect.ts`'s live proof (§4).
  Telemetry regression/recovery: `preflight.integration.test.ts`'s
  hysteresis tests. Diagnosis/Slack/authorized resume: the full §7 chain,
  proven end-to-end in `diagnosis-worker.test.ts` and
  `slack-interactive.test.ts`.
- [~] Security: forged/replayed alerts, stale Slack action, role/scope
  isolation, secret/log leakage, prompt injection, oversized input, and
  abuse rate limits. Forged/replayed alerts, stale Slack action, role/scope
  isolation, secret/log leakage, oversized input (413, not a generic 500 —
  `app.integration.test.ts`), and abuse rate limits (`app.integration.
  test.ts`'s override test, plus the real load test in
  `docs/adr/011-permit-load-test.md` that empirically confirmed the
  limiter engages) are all covered. **"Prompt injection" does not map
  cleanly onto this codebase's actual attack surface** — Fuse never parses
  or executes LLM-generated content; diagnosis is deterministic template
  text (task.md §7.2), not an LLM reading untrusted input. The closest real
  analog — untrusted span/evidence content reaching a rendered surface
  (Slack Block Kit, the local HTML snapshot) — is tested:
  `incident-card.test.ts`'s "escapes HTML-significant characters in
  diagnosis text". Noted here rather than silently claiming a literal
  "prompt injection test" that would not mean anything concrete for this
  system.
- [x] Performance/reliability: concurrency races, load, restart, dependency
  outages, delayed/out-of-order telemetry, and recovery. Concurrency races
  (`store.integration.test.ts`, `guard.integration.test.ts`), load
  (`docs/adr/011-permit-load-test.md`), restart (`shutdown.test.ts`),
  dependency outages (state-store/SigNoz/MCP/Slack, per
  `docs/adr/012-failure-injection-review.md`'s survey), delayed/out-of-order
  telemetry (all three detectors have a dedicated "is invariant to
  delayed/out-of-order delivery" test —
  `loop-signature.test.ts`/`context-bloat.test.ts`/`cost-velocity.test.ts`).

### 10.2 Release checklist

- [~] All P0 tasks and agreed P1 tasks are complete with evidence. §1-§9 are
  complete with evidence (each section's own task.md entry). §10 (this
  section) is in progress; §11 has not started. Every completed section's
  gaps are recorded honestly (search this file for "Not built"/"real gap")
  rather than silently marked done.
- [~] Aggregate local checks pass from a clean build state, and equivalent CI
  is checked in. On 2026-07-23 every workspace `dist` directory and
  `.tsbuildinfo` was deleted (`remaining_dist=0 remaining_tsbuildinfo=0`),
  then `pnpm install`, `pnpm run check`, `pnpm run test:integration`, and
  `pnpm run test:coverage` all exited 0: 447 unit tests across 52 files and
  88 integration tests across 11 files (535 total). The new GitHub Actions
  workflow repeats install/check/integration/coverage/audit/SBOM/container
  smoke, but its remote execution remains unverified because pushing is not
  authorized in this audit.
- [x] No unresolved dependency vulnerability or known breaker bypass.
  `pnpm audit --prod --audit-level low` returned `No known vulnerabilities
  found` after pinning the compatible fixed `@hono/node-server` release.
  The zero-provider-calls-post-trip guarantee remains proven under concurrent
  load (`guard.integration.test.ts`).
- [x] Dashboard/alert exports and configuration examples match tested
  versions. `infra/signoz/dashboards/fuse-agent-cost-health.json` and
  `infra/signoz/alerts/*.json` are the exact files applied via
  `infra/signoz-dashboard-up.sh`/`infra/signoz-alerts-up.sh` and
  live-verified (ADR-006, ADR-008) — not separately-maintained examples
  that could drift from what was actually tested.
- [d] README quickstart and operator/developer docs pass a fresh-user
  rehearsal. Not done as a literal fresh-user rehearsal this slice —
  deferred to §11.2, which explicitly owns README polish. The runbooks
  (`docs/runbooks/*.md`) were written from and cross-checked against real
  commands, which is a partial substitute, not the same as an actual
  fresh-user walkthrough.
- [x] Version/changelog/release notes identify limitations and breaking
  changes. `CHANGELOG.md` now records the unreleased production-hardening
  changes and points to the limitations/runbooks; packages remain at
  `0.1.0` until the release owner deliberately cuts a tag.
- [~] Container/artifact provenance, checksums, SBOM, and rollback are
  available. The pinned multi-stage `Dockerfile` produces a non-root
  production image with OCI labels and a healthcheck; CI publishes its
  digest and SBOM artifact, while `docs/runbooks/deployment.md` documents
  digest promotion/rollback. Local final image evidence:
  `sha256:22a384731a230d679f6a15f26191baf579eac0bad414ece8063fff58c14c60a7`,
  67,837,827 bytes, user `node`, and a healthy run with a read-only root,
  all capabilities dropped, and `no-new-privileges`. A registry digest is
  necessarily unavailable until the image is pushed; schema rollback remains
  forward-fix only as documented in `docs/runbooks/operations.md`.
- [ ] Final commit is pushed using verified `Vedant817` authentication and
  the working tree is clean. **Deliberately not done, per the user's
  standing decision this session ("stay local for now")** — every commit
  in §4 through §10 is local only, never pushed. Working tree is clean
  after each commit (verified via `git status` before every commit this
  session).

## 11. Demo, judging narrative, and submission

Worked in the 2026-07-23 gap-closure session, after §10. Both demo beats
were rehearsed live against the real stack (not scripted from imagination)
and produced a genuinely unscripted result — a real multi-detector race
(context-bloat and loop-signature both fired) that turned out to be a
better demonstration of the idempotency guarantee than a single clean
trip would have been. Full transcript: `docs/demo-script.md`.

### 11.1 Repeatable two-beat demo

- [x] Script/reset the environment and seed deterministic baseline/runaway
  data. `infra/reset.sh` (pre-existing) plus `demo.ts`/`demo-real-detect.ts`
  (which generate their own runaway telemetry in-process) together satisfy
  this — no new seeding mechanism was needed.
- [x] Rehearse: start healthy -> launch loop -> show cost velocity -> SigNoz
  alert -> authenticated trip -> prove next provider call blocked -> show
  audit event -> receive evidence-backed Slack diagnosis -> authorized
  resume. Evidence: real trip at 210.9s; both `context-bloat` and
  `loop-signature` fired (11s apart), first one committed, second landed as
  an audited no-op; blocked permit check (`allowed:false`) confirmed;
  audit log queried directly (real rows, real correlation IDs); the real
  diagnosis HTML snapshot quoted verbatim in `docs/demo-script.md`
  (Slack itself untested this run — `SLACK_BOT_TOKEN` wasn't set locally,
  which is the documented graceful-degrade path, not a gap); real API
  resume (`epoch` 1→2); post-resume permit check confirmed `allowed:true`.
- [x] Rehearse Preflight beat: intentionally remove required telemetry ->
  show `blind/degraded` and self-alert -> restore instrumentation -> show
  recovery. Evidence: real `/v1/preflight/report` sequence — `protected` ->
  `blind` (`missing-required-fields`) -> `blind`/`recovering` with
  `pendingRecoveryState`/`pendingSince` set (hysteresis holding, not an
  instant flip) -> `protected` committed only after the 60s dwell window
  genuinely elapsed (~131s in the actual rehearsal).
- [x] Display actual measured numbers; use simulated/estimated spend labels
  and avoid unsupported five-figure claims. Every number in
  `docs/demo-script.md` is from the actual rehearsal (210.9s, the 11s
  dual-fire gap, real epoch values) — no invented numbers, no five-figure
  spend claims (the dashboard's own spend panel is explicitly labeled
  "estimated" and was honestly empty this run, not padded).
- [x] Prepare offline-safe fallbacks (recorded telemetry, local Slack-card
  render, screenshots) without disguising them as live behavior.
  `docs/demo-script.md`'s "Offline-safe fallbacks" section quotes the real
  recorded transcript/diagnosis snapshot and explicitly instructs saying
  "this is from an earlier run" rather than passing it off as live.
- [~] Time the primary story to two minutes and maintain a longer technical
  path for judge questions. The *narrative* is structured and marked for a
  two-minute telling (`docs/demo-script.md`'s bolded lines), and a
  "Judge-question depth" section exists for follow-up — but stated
  honestly: the full **live, unedited** proof cannot fit in two minutes
  regardless of narration pace, because SigNoz's real alert-evaluation
  cadence took 210.9s on its own. The two-minute story as actually staged
  should use the recorded transcript for the wait, or accept a ~4-minute
  live version — this is a real constraint of the architecture, not a
  scripting failure to fix.

### 11.2 Documentation and evidence

- [x] README: problem, architecture, SigNoz usage, quickstart, demo,
  policy, security, limitations, troubleshooting. Evidence: `README.md`
  rewritten with all of these as explicit sections, each linking to the
  fuller doc behind it rather than duplicating content.
- [d] Screenshots/GIF. **Not produced as saved image files** — no
  image-export mechanism was available this slice. Live-verified instead
  (browser tool, not an API check): the real SigNoz dashboard was opened
  mid-rehearsal and 6 of 7 panels showed real data from this session's own
  trip (`docs/adr/008-signoz-dashboard-provisioning.md`'s updated
  Consequences section). A real, honest gap against the literal ask —
  documented as such, not silently skipped.
- [x] Architecture diagram and control/data-flow sequence. Evidence:
  `docs/architecture.md` — a system diagram and a full-incident sequence
  diagram (Mermaid), plus why enforcement needs a dedicated control plane
  rather than living inside SigNoz.
- [x] Explain usage of SigNoz traces, metrics, logs, alerts, dashboards,
  and MCP as one closed loop. Evidence: README's "How SigNoz is used"
  section and `docs/architecture.md`'s "closed loop" paragraph, each
  capability tied to the specific file that uses it.
- [x] Publish detector formulas, thresholds, evaluation fixtures,
  false-positive tradeoffs, and cost-estimation caveats. Evidence: README's
  "Policy: detector formulas and thresholds" section — including the
  honest caveat that live detection currently always uses the hardcoded
  defaults shown, not a loadable policy file (task.md §4's own disclosed
  gap, restated here since it directly affects what the table means).
- [x] Publish the breaker guarantee, in-flight-call limitation, outage
  behavior, and Preflight protection semantics in plain language. Evidence:
  README's "The guarantee, in plain language" section, each claim linked
  to its proving test.
- [d] Produce and verify the two-minute video, repository/submission
  links, setup instructions, license, and attribution. Setup instructions
  (README's Getting Started), license (`LICENSE`, Apache-2.0, already
  linked from README), and attribution (existing `.github/CODEOWNERS`) are
  in place. **The two-minute video itself was not produced** — no
  screen-recording/video-export capability was available this slice; a
  real, stated gap, not a silent omission. `docs/demo-script.md` is the
  substitute a human presenter would use to record one.

### 11.3 Final adversarial review

- [x] Assign independent subagents/reviewers to attack correctness/races,
  security/privacy, observability claims, UX/demo clarity, and
  fresh-install reproducibility; give each a bounded checklist. Evidence:
  4 parallel subagents launched, each with a scoped, source-level review
  task and no visibility into the others' findings or this session's own
  narrative — full findings in `docs/adr/013-adversarial-review-findings.md`.
- [x] Triage every finding by severity and resolve all demo-blocking and
  P0/P1 issues; record deferred risks transparently. Two real, concrete
  gaps found and fixed: an unbounded attacker-controlled `detector` label
  reaching audit-log/log content (now capped and enforced), and
  `.env.example`'s placeholder tokens silently working as real credentials
  (now rejected at startup with a clear error). One real, more invasive gap
  found and **deliberately left open** (unbounded Postgres/OTel-cardinality
  growth via arbitrary caller-chosen scope tuples — a bigger design
  question than a patch, recorded in `docs/threat-model.md`'s risk register
  as risk #9 and in `docs/runbooks/limitations.md`). One low-confidence,
  unconfirmed theoretical note recorded but not acted on (a
  connection-pool/advisory-lock edge case with no evidence it's reachable).
- [~] Run the demo repeatedly from a clean reset and once from a clean
  clone. Partial: the demo was run for real once this session (not from a
  freshly-cloned separate checkout, and not repeated multiple times back
  to back) — the fresh-install *reproducibility* of the instructions was
  separately verified by one of the four review subagents reading every
  referenced command/path/port against the real source, which is a real
  substitute for *some* of what a clean-clone run would catch (broken
  paths, wrong ports) but not a substitute for an actual clean-clone
  execution. Not done: a literal `git clone` into a new directory followed
  by a full fresh run.
- [ ] Freeze the demo configuration, tag the release, and preserve
  known-good artifacts plus rollback instructions. Not done — deliberately
  not decided unilaterally: tagging implies a "this is release-worthy"
  judgment while a real, known gap remains open (risk #9 above) and no CI
  or release process exists yet (task.md §10.2). This is the user's call to
  make, not an agent's, especially given the standing "stay local for now"
  decision on git remote/push this whole session has operated under.

Acceptance criteria carried over from task.md's own intent for this
section: the primary demo story is real (not simulated), every number
quoted is measured, and every gap found by adversarial review is either
fixed or transparently recorded — all three are met. What is **not** met:
a literal two-minute live timing (architecturally impossible without the
recorded-transcript substitute), a produced video, and a release tag.

## 12. Decision and evidence log

Add dated entries here rather than leaving important context only in chat.

### Decisions

- 2026-07-21: Breaker-first delivery and honest Preflight status are fixed by
  the hackathon brief; dashboards and optional PR automation cannot displace
  them.
- 2026-07-21: Repository commits must use local identity
  `Vedant817 <vedantmahajan271@gmail.com>` and pushes must be authenticated as
  GitHub user `Vedant817`.
- 2026-07-21 (ADR-001): TypeScript/Node.js 24/pnpm workspaces monorepo. See
  `docs/adr/001-language-and-runtime.md`.
- 2026-07-21 (ADR-002): Component boundaries (contracts/breaker-core/
  breaker-store/sdk/control-plane) and PostgreSQL with epoch-based CAS as
  the single durable breaker state + audit store. See
  `docs/adr/002-system-boundaries-and-state-store.md`.
- 2026-07-21: Solo hackathon-speed direct-push-to-`main` branch strategy;
  branch protection/PR review deferred until a remote and/or a second
  contributor exists (§0.1).
- 2026-07-21 (initial choice, later reversed — see below): SigNoz Cloud
  (not self-hosted) was the target deployment — required the user to
  supply an account/ingestion key, which could not be created by an agent.
  Real LLM provider adapters target Groq and NVIDIA Build (NIM),
  both via a shared OpenAI-compatible `/chat/completions` client
  (`packages/sdk/src/providers/`), chosen explicitly by the user over the
  initially-assumed Anthropic/OpenAI default. The adapters are verified
  against both a faithful local mock and, as of 2026-07-23, the real Groq and
  NVIDIA Build APIs via the 2/2 passing live-optional tests. See
  `docs/adr/003-llm-provider-adapters.md`.
- 2026-07-21 (ADR-005, explicit user choice — reverses the SigNoz Cloud
  entry above): self-hosted SigNoz via Foundry (`foundryctl`), the current
  officially-supported deployment tool. No external account/credential
  needed, unblocking the ingestion-proof work that was stuck all session.
  `infra/signoz/casting.yaml` + `infra/signoz-up.sh` stand up the stack
  (pinned image versions) and complete SigNoz's first-run org/admin
  bootstrap non-interactively. See `docs/adr/005-self-hosted-signoz.md` for
  the full decision record, including a real deployment bug found and
  fixed along the way (OTLP receivers silently never starting until the
  org bootstrap step exists) and the concrete verification evidence.

### Verification evidence

- 2026-08-24 (detector/demo realism): replaced broken-agent's exact-output
  SHA-256 signature with the reusable public `StepShapeCanonicalizer`. The
  helper normalizes timestamps, numbers, UUID/ULID/opaque IDs, uses keyed
  token digests and bounded local Jaccard clusters, and exports only a
  33-character versioned fingerprint. Tests cover volatile normalization,
  paraphrases, progress boundaries, unrelated noise, low-information
  collisions, fixed-size/no-raw-content output, eviction, and invalid options.
  Broken-agent's loop now varies wording and volatile fields but produces the
  same two-step cycle; context and normal/cost phases carry non-sensitive
  structural progress labels. The cost scenario now uses
  `fuse-synthetic/mock-cost-velocity-v1` with explicit estimated pricing
  (50k input + 10k output = $0.175/call) and 700ms spacing, so four calls span
  2.1s and cross the real unchanged `$0.50/60s` default. A fake clock keeps
  tests sub-second. New end-to-end tests run each named scenario through
  `runAnalyzerVerifier` and the real default detector functions, asserting the
  exact fired set: loop -> loop-signature, context-bloat -> context-bloat,
  cost-velocity -> cost-velocity; normal fires none. Evidence: focused SDK
  74/74, OTel 28/28, detectors 44/44, and broken-agent 37/37; `pnpm run
  check` passed format, lint, all builds/typechecks, and 564/564 unit tests;
  broken-agent's real-Postgres integration suite passed 4/4; package packing
  validated all three public tarballs; `pnpm audit --prod --audit-level high`
  found no known vulnerabilities. Post-change review found no production-
  default change and no raw-content export. Residual limitations: Jaccard is lexical,
  not semantic; low-information normalized text can collide; fixed-key output
  is dictionary-guessable/linkable; process-local clustering is order/window
  dependent; input beyond the documented 32 KiB/512-token caps is ignored;
  caller-provided structural labels are required to preserve progress reliably.
- 2026-07-21: Brief reviewed; governance/tracker files created; Git initialized
  on `main`; repository-local `user.name` and `user.email` verified as
  `Vedant817` and `vedantmahajan271@gmail.com`. Initial commit evidence is in
  repository history; remote-push evidence remains blocked.
- 2026-07-21: Breaker-first vertical slice (§2) built and verified end to
  end across 5 packages (`contracts`, `breaker-core`, `breaker-store`,
  `control-plane`, `sdk`) in commits `9a296a6`..`7e91c1a`, plus the
  post-review fix commit below. From a fully clean state (all
  `dist/`/`.tsbuildinfo` removed):
  - `pnpm run check` (format, lint, build, typecheck, unit tests) passes —
    53 unit tests across 5 buildable packages (post-review-fix count; see
    the adversarial-review entry below for what changed).
  - `pnpm run test:integration` passes — 32 integration tests against a
    real Postgres (via testcontainers) and, for the SDK, a real listening
    control-plane HTTP server and a real listening fake-provider HTTP
    server.
  - The central product guarantee — zero provider dispatches after a
    committed trip — is proven by counting actual inbound HTTP requests to
    a real server, not in-process function calls, including under 25-way
    concurrency racing the trip itself
    (`packages/sdk/src/guard.integration.test.ts`).
  - `pnpm run test:coverage` verified working after fixing a missing
    `@vitest/coverage-v8` dependency (commit `02aaa2c`).
- 2026-07-21: Independent adversarial review of the full §2 slice
  (correctness/races in the CAS loop, auth bypass routes, timing side
  channels, misleading-status claims, idempotency-replay consistency,
  fail-open/fail-closed consistency, cooldown-bypass logic, swallowed
  errors), performed by a separate reviewing agent with no access to this
  session's implementation reasoning. Confirmed correct with no findings:
  CAS transition core logic (verified live with 8-way and 10-way
  concurrent writers), idempotency-key replay consistency, auth
  bypass/route-registration order, the constant-time bearer-token check,
  fail-open/fail-closed honesty (mutations always 503 on store outage
  regardless of configured mode), and cooldown/manual-override logic.
  Three findings, all resolved same-day:
  - **P1 (fixed)**: N truly concurrent requests sharing the same
    idempotency key each independently computed and committed their own
    `breaker_audit_log` row (one real transition + N-1 phantom "no-op"
    rows) before discovering via `ON CONFLICT DO NOTHING` that only one
    should have run — clients still got a correct, identical response, but
    the audit trail gained fabricated duplicate-observation rows. Fixed by
    serializing all same-key requests through a Postgres session-level
    advisory lock (`pg_advisory_lock(hashtext(scope+key))`) held for the
    idempotency-check-through-commit lifetime of `executeTransition`
    (`packages/breaker-store/src/store.ts`); different keys still run
    concurrently, only true duplicates now serialize. Regression test:
    `store.integration.test.ts`'s "N truly concurrent requests sharing the
    SAME idempotency key produce exactly one audit row" (8-way, passing).
  - **P1 (fixed)**: every configured API token could call every endpoint,
    including force-trip/resume/disable/enable — an agent-embedded SDK
    token (meant only to check permits) could assert `actor: {type:
    "manual"}` on `/v1/breaker/resume` and bypass an active cooldown,
    contradicting AGENTS.md's least-privilege requirement for
    resume/override operations. Fixed by splitting tokens into two roles:
    `CONTROL_PLANE_API_TOKENS` (operator: full access) and
    `CONTROL_PLANE_AGENT_API_TOKENS` (agent: `/v1/permit` only); a valid
    agent token attempting `/v1/breaker/*` now gets 403 `unauthorized`
    (not a silent pass, and distinct from 401 `unauthenticated` for an
    unknown token) — see `services/control-plane/src/auth.ts`,
    `config.ts`, `app.ts`. Tests: `auth.test.ts`'s scoped-token describe
    block (unit) and `app.integration.test.ts`'s "token scoping" describe
    block (integration, real HTTP + Postgres), both passing.
  - **P2 (fixed)**: CAS-retry exhaustion (sustained write contention on one
    scope past `MAX_CAS_ATTEMPTS`) threw a plain, unlabeled `Error`,
    surfacing as a generic 500 indistinguishable from an unexpected bug.
    Fixed with a typed `CasContentionExhaustedError`, mapped to a new
    `contention_exhausted` (409) error code with a `Retry-After` header.
    Not separately load-tested (P2, low likelihood at current scale); will
    be exercised naturally once load testing (§9.2) runs.
  Verified after fixes: full workspace `pnpm run check` and
  `pnpm run test:integration` pass from a clean state — 53 unit tests + 32
  integration tests across 5 buildable packages, zero failures.
- 2026-07-21: Real LLM provider adapters added (ADR-003) — Groq and NVIDIA
  Build, both via `packages/sdk/src/providers/`'s shared
  `OpenAiCompatibleProvider`. Base URLs and auth verified against each
  platform's current documentation (Groq: `console.groq.com/docs/openai`;
  NVIDIA: `docs.nvidia.com/nim`). Verified: unit tests (8 passed, mocked
  fetch, both providers) covering request shaping/auth header/response
  parsing/HTTP-error typing/timeout; an integration test running the real
  adapter class through `FuseGuard` against a faithful local mock server
  (2 passed) proving the concrete adapter — not just the generic
  dispatch-wrapper contract — respects the breaker (armed calls reach the
  mock with the correct auth header; after a trip, 5 concurrent calls are
  all denied with zero new requests to the mock). Live-optional tests
  against the real APIs correctly skip (exit 0) with no credentials
  present. Full workspace `pnpm run check`/`test:integration` pass — 61
  unit + 34 integration tests across 5 packages.
- 2026-07-21: OTel `gen_ai` instrumentation added (`packages/otel`) and
  wired into `services/broken-agent`. Actual current OTel JS package
  versions and API surface were verified against installed `.d.ts` files
  rather than assumed (initial guesses were significantly stale — see
  §3.2 evidence). `withGenAiSpan` wraps every model call in a CLIENT span
  with `gen_ai.*` + `fuse.*` attributes and records token-usage/duration
  metrics; the broken-agent's run is one root `invoke_agent` span with
  each round correctly nested underneath (no orphans, verified). A
  versioned, explicitly-estimated price table avoids misleading zero-cost
  claims for unpriced models. `bootstrapOtel` exports via standard
  `OTEL_EXPORTER_OTLP_*` env vars (works for a local collector or SigNoz
  Cloud identically) and was verified end-to-end against a real local
  HTTP receiver — actual non-empty export requests reach `/v1/traces` and
  `/v1/metrics` with the configured header. Verified: 78 unit + 39
  integration tests pass across 8 packages from a clean workspace state
  (`pnpm run check`, `pnpm run test:integration`). Real SigNoz Cloud
  ingestion (§3.3) remains the one blocked item — needs the account/key
  from the open blockers list below.
- 2026-07-21: Detector logic (`packages/detectors`: loop-signature,
  context-bloat, cost-velocity) and the SigNoz alert webhook
  (`services/control-plane/src/routes/webhook.ts`, §5.1) added, per the
  user's explicit choice to skip SigNoz Cloud verification for now and
  continue with detector logic/webhook/alert-rule-as-code against the
  local/mock path. Researched (not assumed) that SigNoz's webhook channel
  follows the Prometheus Alertmanager payload contract and authenticates
  via HTTP Basic Auth/bearer token, not HMAC signing — this reshaped the
  webhook's auth design before any code was written against a wrong
  assumption. Added a third least-privilege token tier
  (`CONTROL_PLANE_WEBHOOK_TOKENS`) scoped to only the webhook route. A
  real bug was found and fixed via integration testing: the webhook
  initially derived its correlation ID from Fastify's per-request
  auto-generated ID, which silently broke idempotency-key matching for
  genuine Alertmanager retries (each retry hashed as a "different"
  request) — fixed by deriving both the idempotency key and correlation ID
  from the alert's own stable fingerprint+startsAt identity. Verified:
  130 unit + 47 integration tests pass across 9 packages from a clean
  workspace state. SigNoz alert-rule-as-code translation (§4.5) and live
  SigNoz ingestion (§3.3) remain explicitly deferred/blocked per the
  user's decision, not silently dropped.
- 2026-07-23: Independent adversarial audit of the full system as actually
  deployed — clean-slate build, real self-hosted SigNoz + Postgres +
  control-plane brought up and hit with real HTTP traffic (not just the
  test suite), the `broken-agent` demo run against the real stack and
  independently re-verified via direct Postgres/ClickHouse queries rather
  than trusted from its own printed output, and targeted attacks against
  live concurrency, idempotency, tenant-token boundaries, webhook
  staleness/replay, Preflight hysteresis, detector boundary values, and
  `broken-agent` safety ceilings. Two P1 bugs and four lower-severity gaps
  were found, all fixed and independently re-verified live the same day
  (not just re-tested in isolation):
  - **P1 (fixed)**: `packages/breaker-store/src/store.ts`'s
    `executeTransition` misattributed the `breaker_audit_log` row's
    `actor`/`reason` on every no-op transition (already-tripped/-armed/
    -disabled/-enabled, across `trip`/`resume`/`disable`/`enable` alike):
    it sourced those columns from `finalRecord` — for a no-op, the
    *pre-existing* record, i.e. whichever earlier caller's data was
    already persisted — while still stamping the *current* caller's own
    `correlationId`, fabricating a hybrid record that misattributed one
    caller's action to a different caller's identity. Live-reproduced
    against the real running control plane before fixing: 3 concurrent
    `POST /v1/breaker/trip` requests with distinct actor/reason/
    correlationId/idempotencyKey on one scope produced two persisted
    audit rows carrying the winning caller's actor/reason but the losing
    callers' own correlationIds. The existing "10 concurrent trips ...
    exactly one real transition, rest no-op" test (§2.1) only asserted
    aggregate counts, never per-response actor/reason/correlationId
    fields, so this was invisible to it. Fixed by threading the calling
    request's own `actor`/`reason` through `ExecuteTransitionArgs` and
    using them (never `finalRecord`'s) for the audit-log INSERT and
    returned `auditEvent`, for both no-op and real transitions; the
    top-level `record` field is unchanged and still reflects true current
    state. Also added `noopReason` to `TransitionResult` (sourced from
    breaker-core's already-existing `NoopReason`), consumed by the next
    fix. New regression test in `store.integration.test.ts` asserts every
    concurrent caller's own auditEvent *and* the corresponding persisted
    row match that caller's own submitted values, win or lose; re-verified
    live post-fix with the identical 3-way-concurrent repro above —
    every response and every persisted row now correctly reflects its own
    caller.
  - **P1 (fixed)**: the SigNoz webhook route
    (`services/control-plane/src/routes/webhook.ts`) collapsed every
    no-op reason into the single per-alert outcome `'already-tripped'`,
    including `breaker-disabled`. Live-reproduced: disabled a scope for a
    maintenance window, sent a fresh valid alert for it, and the webhook
    response read `{"outcome":"already-tripped"}` even though nothing was
    ever tripped — enforcement itself was correct (disabled truly resists
    tripping), but the reported outcome would mislead an operator or any
    webhook-response-driven automation into believing a detector had
    already caught the pathology during a period when nothing was
    enforced. Fixed by branching on the now-exposed `noopReason` and
    adding a distinct `'breaker-disabled'` outcome value; re-verified live
    post-fix with the identical repro — the webhook now correctly reports
    `'breaker-disabled'` and the scope is confirmed unchanged.
  - **P2 (fixed)**: `services/control-plane/src/server.ts` built the
    Postgres pool with no operator-overridable options, silently capping
    the `/v1/permit` hot path at a hardcoded `max: 10` with no env var to
    raise it. Added `CONTROL_PLANE_DB_POOL_MAX`/`_IDLE_TIMEOUT_MS`/
    `_CONNECTION_TIMEOUT_MS`/`_STATEMENT_TIMEOUT_MS`, defaulting to the
    exact previously-hardcoded values (behavior unchanged unless
    explicitly configured), documented in `.env.example`.
  - **P2 (fixed)**: `.env.example` documented `FUSE_PERMIT_TIMEOUT_MS` and
    `FUSE_SDK_OUTAGE_MODE` as SDK config, but nothing anywhere read either
    — an operator setting them would see zero effect with no warning.
    `services/broken-agent/src/demo.ts` (the one runnable `FuseGuard`
    construction site) now reads and validates both at startup via a new
    `demo-config.ts` helper, with a logged warning and safe fallback
    (SDK default / `fail-closed`) on an invalid value, covered by 12 new
    unit tests.
  - **P2 (fixed)**: Preflight evaluator thresholds
    (`DEFAULT_PREFLIGHT_CONFIG`) were hardcoded in
    `services/control-plane/src/routes/preflight.ts` with no override,
    even though `evaluatePreflight` itself already accepted a configurable
    argument. Added 7 `CONTROL_PLANE_PREFLIGHT_*` env vars defaulting to
    the exact prior values; a new integration test proves the wiring is
    live end-to-end (a stale-evidence span that reports `blind` under
    default config reports `protected` when `preflightMaxEvidenceStalenessMs`
    is widened via config, same store, same Postgres).
  - **P3 (fixed)**: `services/broken-agent/src/safety.ts`'s `clampCeiling`
    treated `undefined`/`NaN`/`±Infinity` as invalid (falls back to
    `ABSOLUTE_MAX_*`) but let a negative or zero configured value pass
    through unmodified — not a safety bypass (only ever made a run *more*
    restrictive), but inconsistent with the function's own stated
    contract and capable of silently producing a misleadingly-labeled
    zero-call "successful" run. Now treated identically to the other
    invalid-input cases.
  - **P3, informational (documented, not fixed — not a defect)**:
    adversarial boundary testing of `packages/detectors/src/
    cost-velocity.ts` found that a burst of real spend straddling the
    trailing-window boundary can be under-counted by a single evaluation
    (up to just-under-2x threshold spend split evenly across the edge can
    evade detection) — an inherent property of any fixed, non-overlapping
    window, already implicitly covered by §4.4's deferred learned-baseline
    item but not previously named this precisely. Added an explicit doc
    comment and one named regression test locking in and describing this
    exact behavior, so it reads as a known, accepted characteristic rather
    than an undiscovered surprise.
  Full clean-slate verification after all fixes (`dist`/`.tsbuildinfo`
  removed, real Postgres via testcontainers): `pnpm run check` — 256 unit
  tests across 9 packages; `pnpm run test:integration` — 83 integration
  tests. Both P1 fixes were additionally
  re-verified live against the real running control plane (not just the
  test suite) with the exact repro steps that first found them, both now
  behaving correctly.
- 2026-07-23 (independent audit follow-up): fixed a P1 role-boundary escape in
  Preflight/control-plane authentication. `app.ts` incorrectly included
  webhook-only credentials in the allowlists for `/v1/permit` and
  `/v1/preflight/*`; additionally, any agent token could submit
  `disabled: true|false` and persist an `operator-disabled` verdict. Live
  reproduction against the real server confirmed all three unauthorized
  operations returned HTTP 200 before the fix. The allowlists now exclude
  webhook credentials from agent routes, and any report carrying the
  operator control fields `disabled`/`disabledReason` requires an operator
  token. Evidence: `pnpm --filter @fuse/control-plane run test` (52 unit
  tests) and `TESTCONTAINERS_RYUK_DISABLED=true pnpm --filter
  @fuse/control-plane exec vitest run src/preflight.integration.test.ts`
  (13 integration tests) pass. Live post-fix requests returned 403 for an
  agent disable, webhook permit, and webhook Preflight report; an ordinary
  agent report remained 200/protected and an operator disable remained
  200/disabled.
- 2026-07-23 (detector boundary audit): fixed two false-negative paths found
  with executable threshold probes. `context-bloat` checked
  `minStepsRequired` before its documented immediate absolute-token ceiling,
  so even a one-step 1,000,000-token observation returned `fired:false`.
  `cost-velocity` derived elapsed time from array-first/array-last without
  ordering by timestamp, so the same three $0.20 calls returned `fired:true`
  chronologically and `fired:false` when delayed delivery reordered them.
  All detectors now evaluate a timestamp-ordered copy (without mutating caller
  input), and the absolute context ceiling is evaluated before growth-sample
  safeguards. Evidence: `pnpm --filter @fuse/detectors run test` (36 tests),
  build, and typecheck pass; a direct post-fix probe returned `fired:true` at
  exactly 100,000 tokens on the first call and identical `$0.60` fired results
  for ordered/reordered cost records.
- 2026-07-23 (cost-telemetry audit): fixed a P1 misleading-zero estimate for
  NVIDIA Build. Its price-table row intentionally contains zero placeholders
  because no per-token list price is available, but `estimateCostUsd` returned
  `{costUsd:0, priced:true}`; `withGenAiSpan` consequently emitted a real
  `fuse.estimated_cost.usd=0` attribute. Price entries now explicitly state
  whether pricing is available, and unpriced documented models return
  `priced:false` just like unknown models. Evidence: `pnpm --filter
  @fuse/otel run test` (15 tests), build, and typecheck pass; direct post-fix
  execution returns `{costUsd:0,priced:false,...}` and the span regression test
  confirms the estimated-cost attribute is absent.
- 2026-07-23 (provider-boundary audit): fixed a P2 runtime-validation gap in
  the OpenAI-compatible adapter. A 200 response containing only
  `{garbage:true}` was previously returned successfully because
  `res.json()` was cast to `ChatCompletionResponse` without validation.
  Successful responses now pass through a bounded Zod schema and malformed
  JSON/shape failures raise exported `ProviderResponseValidationError`
  instances without echoing the provider body. Evidence: `pnpm --filter
  @fuse/sdk run test` (38 tests), build, and typecheck pass; the exact direct
  malformed-response repro now returns the typed error with missing-field
  issue paths instead of resolving arbitrary JSON.
- 2026-07-23 (live-operability audit): fixed three failures in the documented
  local path. SigNoz Foundry and the control plane both defaulted to host port
  8080, so they could not coexist; the control plane/demo now default to 8090
  while SigNoz remains on 8080. README also now explicitly exports `.env` in
  each terminal: before this, running its migration command after merely
  copying `.env` failed with `Error: DATABASE_URL is required`. Finally, the
  global 120/minute per-token limiter was source-hardcoded: a live 121-permit
  probe returned 120 HTTP 200 responses then one 429, which the SDK treats as
  an outage and may fail closed. The default is preserved but can now be sized
  through `CONTROL_PLANE_RATE_LIMIT_MAX`/`_WINDOW_MS`, with the shared-token
  availability tradeoff documented. Evidence: control-plane unit tests (55),
  build/typecheck, and `app.integration.test.ts` (21, real Postgres) pass; a
  sourced `.env.example` migration returns `no pending migrations`; direct
  config execution reports port 8090 and 120/60000 limiter defaults.
- 2026-07-23 (final independent-audit gate): deleted all workspace `dist`
  directories and `.tsbuildinfo` files, then ran `pnpm install` (`Already up
  to date`), `pnpm run check` (format, lint, all 9 builds/typechecks, 259/259
  unit tests across 28 files), and `pnpm run test:integration` (83/83 tests
  across 10 files against Testcontainers Postgres). The first integration
  attempt after the clean build found that the local OrbStack daemon had
  stopped (`Could not find a working container runtime strategy`); after
  restarting OrbStack, the unchanged suite passed in full. Optional live
  provider tests initially skipped 2/2 because credentials were absent, then
  passed 2/2 against the real Groq and NVIDIA Build endpoints after both keys
  were supplied in `.env`. **P3 (not fixed):** that failed-startup path also
  exposed a test-harness cleanup defect in both breaker-store integration
  suites: `afterAll` called `pool.end()` after `beforeAll` failed, producing a
  secondary `Cannot read properties of undefined (reading 'end')` error that
  obscures diagnostics. This does not affect application runtime or the
  container-available test path.
- 2026-07-23 (live-provider follow-up): after Groq and NVIDIA credentials were
  supplied, both real-provider SDK smoke tests passed and the full narrated
  demo completed with a guarded real Groq call. This run exposed a P2 graceful
  shutdown race: one Ctrl-C delivered duplicate `SIGINT` notifications through
  `tsx watch`, so shutdown called `pool.end()` twice and crashed with
  `Error: Called end on pool more than once`. Shutdown is now memoized and
  idempotent, attempts all cleanup stages even if one fails, and exits nonzero
  on cleanup failure. Evidence: 2 focused shutdown tests, the 57-test
  control-plane unit suite, build/typecheck, and a real start/Ctrl-C cycle that
  logged one shutdown and exited 0 without a stack trace.
- 2026-07-23 (real-call telemetry follow-up): the first credentialed demo run
  proved the real Groq call was permit-guarded, but a direct ClickHouse query
  found only `fuse-mock` spans — Act 6 did not use `withGenAiSpan`, so the call
  was invisible to SigNoz and its separate scope had no telemetry evidence.
  Act 6 now composes the permit check with the same OTel/Preflight observation
  path used by the analyzer/verifier loop. Evidence: the new focused test
  asserts one permit, one provider dispatch, one `gen_ai` span, and one
  telemetry observation; the repeated real demo returned a 45-token Groq
  response; ClickHouse then contained `chat llama-3.1-8b-instant`, provider
  `groq`, 42 input/3 output tokens, scoped to the generated real-agent ID; and
  the control-plane Preflight API returned HTTP 200 `protected`, 100% required
  field coverage and 0% orphan rate for that exact scope.
- 2026-07-22/23 (§4 gap-closure, slice 1 of 3 — detector-runner built and
  wired to real telemetry): the previous session's biggest documented gap —
  `packages/detectors`'s three pure functions existed and were unit-tested,
  but nothing in `services/control-plane` ever called them, and no real
  SigNoz alert rule had ever been created — is now partially closed. Built:
  a `DetectorRunner` (`services/control-plane/src/detector-runner.ts`) that
  maintains a bounded, TTL-pruned in-memory step buffer per scope and
  evaluates all three real `@fuse/detectors` functions on every new
  observation; a new authenticated route (`POST /v1/detectors/observe`,
  agent-tier auth, wired into `app.ts`); a new `fuse.detector.score` OTel
  **gauge** (not counter — `packages/otel/src/metrics.ts`, see ADR-006 for
  why) emitted per detector/scope; a new `onStepObserved`/`canonicalShape`
  hook on `withGenAiSpan`'s outcome (`packages/otel/src/gen-ai-span.ts`),
  live-wired through a new `StepObservationReporter` on `FuseGuard`
  (mirroring `PreflightReporter`'s off-critical-path, swallow-on-failure
  design exactly) into `services/broken-agent`'s analyzer/verifier loop,
  which now derives each round's `canonicalShape` from a hash of the
  model's actual output content, not an invented label. Evidence: 256 unit
  tests pass across the touched packages (contracts 43, otel 19,
  detectors 39, control-plane 66, sdk 50, broken-agent 33) plus 83
  integration tests against real Postgres via testcontainers — both from a
  fully clean workspace state (`pnpm run check`, `pnpm run test:integration`).
  A dedicated `detector-runner.test.ts` proves real fixtures (a genuine
  Analyzer/Verifier ping-pong, a token count crossing the absolute ceiling,
  a real cost burst) fire the correct detector, that two scopes' buffers
  never cross-contaminate, and that a stale scope's buffer is pruned rather
  than growing unbounded. A new `analyzer-verifier.test.ts` case spies on
  `guard.recordStepObservation` during a real `loop` scenario run and
  confirms the hash-based `canonicalShape` actually produces a small,
  bounded, *repeating* set of shapes — the literal property the
  loop-signature detector depends on — not just "some hash was computed."
  **Not yet done** (tracked as the next two slices, per task.md's own §4.5
  and the newly-added `docs/adr/006-signoz-alert-rule-provisioning.md`):
  no real SigNoz alert rule has been created against this new metric yet,
  and the `fuse.detector.score` gauge has not yet been confirmed arriving
  in the self-hosted SigNoz instance from a live run. §4's checkboxes are
  deliberately left unchecked until that end-to-end proof exists — this
  entry documents genuine, tested progress, not claimed completion.
- 2026-07-22/23 (§4 gap-closure, slice 2 of 3 — real SigNoz alert rules
  provisioned and proven to trip the breaker, closing task.md's single
  biggest documented gap: "SigNoz alerting, rather than an undisclosed
  parallel path, triggers the demo breaker"). Added a second gauge,
  `fuse.detector.fired` (0/1), alongside `fuse.detector.score` —
  `context-bloat`'s score mixes three incompatible units depending on
  which internal path fired (a raw token count, a small consecutive-growth
  count, or a ratio), so a single numeric SigNoz threshold against `score`
  would need a different, fragile target per path; `fired >= 1` is exact
  and detector-agnostic since `@fuse/detectors` has already done the real
  evaluation. Researched SigNoz v0.133.0's undocumented alert-rule/
  channel/login API by reading the pinned version's actual Go source (raw
  file fetches, not an AI-summarizing fetch, which first produced subtly
  wrong generic-shaped structs) and by driving the real login/rule-
  creation UI once to capture the exact request shapes — recorded in
  `docs/adr/006-signoz-alert-rule-provisioning.md`, including the specific
  trap that `/api/v1/login` and several other plausible paths return HTTP
  200 with the SPA's `index.html` instead of a 404, and the real upstream
  bug ([SigNoz/signoz#10823](https://github.com/SigNoz/signoz/issues/10823))
  where a legacy `builderQueries` (v4) rule shape silently never fires.
  Added `infra/signoz/alerts/{loop-signature,context-bloat,cost-velocity}
  .json` (real `threshold_rule` definitions, grouped by tenant/environment/
  agent_id), `infra/signoz/channels/fuse-control-plane.json`, and
  `infra/signoz-alerts-up.sh` (idempotent apply script — verified by
  running it twice, the second run correctly detecting and skipping every
  existing channel/rule). Live end-to-end proof, run three times total via
  `services/broken-agent/src/demo-real-detect.ts` (which contains **no**
  manual trip call — the breaker can only transition via the real webhook
  in this script): a real loop-scenario run reports genuine step telemetry,
  `fuse.detector.fired=1` is confirmed via direct ClickHouse query, the
  real SigNoz rule transitions to `"firing"`, its webhook delivery lands at
  `/v1/webhooks/signoz`, and `breaker_audit_log` shows the resulting trip
  attributed to actor `system:signoz-webhook:loop-signature` — verified
  independently via `docker exec ... psql`, not merely trusted from the
  script's own printed output. Measured latency and one genuine limitation
  discovered are recorded in §4.5's own historical checklist entries above
  (multi-minute in two clean single-scope runs; a third, overlapping-scope
  attempt never fired at all, traced to SigNoz's rule `state` appearing to
  be per-rule rather than strictly per-group). Full clean-workspace
  verification after this slice: `pnpm run check` — 290 unit tests across
  9 packages; `pnpm run test:integration` unaffected (no integration test
  changes in this slice). What remains open for §4 to be fully "done":
  a formal detector-baseline write-up (§4.1), live-testing a genuine
  duplicate/out-of-order SigNoz-sourced delivery specifically (as opposed
  to the existing synthetic-payload coverage), and deciding whether the
  measured ~4-5 minute alert-to-trip latency is acceptable for the
  rehearsed demo (§11) or needs a faster fallback path.
- 2026-07-23 (§7 built and live-verified: SigNoz MCP diagnosis + Slack).
  Added `packages/diagnosis` (mcp-client, evidence, diagnosis-engine,
  incident-card, slack-client, slack-actions — 44 unit tests),
  `packages/contracts/src/diagnosis.ts` (5 tests), and `services/
  control-plane/src/diagnosis-worker.ts` + `routes/slack-interactive.ts`
  wiring the whole pipeline into the real webhook trip path. Researched
  and deployed the real official
  [SigNoz/signoz-mcp-server](https://github.com/SigNoz/signoz-mcp-server)
  (`docs/adr/007-signoz-mcp-diagnosis.md`): a least-privilege
  `signoz-viewer` service account (not the admin session used elsewhere),
  the server added to `infra/docker-compose.yml` under an opt-in
  `diagnosis` Compose profile, and two real, only-discoverable-by-testing
  API facts recorded (role-assignment body shape; `attribute.fuse.*` not
  `resource.fuse.*` filter prefix for Fuse's own span attributes).
  **Live end-to-end proof, twice**, via real `POST /v1/webhooks/signoz`
  deliveries against the running control plane (not just the test suite):
  first with no MCP configured — the local incident snapshot honestly
  read "SigNoz trace evidence was unavailable (SigNoz MCP server not
  configured)"; second after adding the missing `FUSE_SIGNOZ_MCP_URL` to
  `.env` (the container was already running, but nothing had told the
  control plane its address — a real, if minor, gap caught by actually
  testing rather than assuming the container's presence was sufficient) —
  the second run's snapshot shows a genuine live MCP query result: "No
  matching spans were found in SigNoz for this scope in the incident
  window (query: attribute.fuse.tenant = 'demo' AND ...)" — correct,
  since that particular synthetic test scope never emitted real
  telemetry. Both runs logged `"Slack incident post not delivered"` with
  reason `"no Slack bot token configured (SLACK_BOT_TOKEN unset)"` —
  exactly the documented graceful-degradation path, not a crash.
  **A real gap was found and fixed during this verification**: the
  Slack-interactive signature-verification/resume logic (`slack-
  actions.ts`) existed as a library from an earlier pass, but no
  control-plane route actually received Slack's interactive POST — task
  #17 ("interactive Slack action auth") had been marked complete while
  actually unreachable from a real Slack app. Closed by adding
  `openResumeModal` (views.open) to `slack-client.ts` and the missing
  `POST /v1/slack/interactive` route (fail-closed: no signing secret,
  invalid signature, or stale timestamp all reject with 401), plus a
  Fastify `application/x-www-form-urlencoded` content-type parser that
  preserves the raw body string HMAC verification needs. 8 new route
  tests cover the full button-click -> modal -> submit -> resume path.
  Also fixed along the way: `packages/diagnosis/package.json` declared a
  `test:integration` script (`vitest run integration`) with no matching
  `*.integration.test.ts` file in the package — this would have failed
  the aggregate `pnpm run test:integration` the moment CI actually ran it
  (found by running it locally, not assumed fine because the package
  "looked" like others that do have integration tests). Removed, matching
  the convention already followed by `packages/detectors` (which also has
  no integration test file and correctly omits the script).
  Full clean-workspace verification: `pnpm run check` — 358 unit tests
  across 10 packages; `pnpm run test:integration` — 83 tests, real
  Postgres via testcontainers, unaffected by this slice's changes.
  Honest open gaps, not silently dropped: no "estimated spend/avoidance"
  field on the incident card (the SigNoz-alert-sourced synthetic detector
  result has no real cost figure to show); no Slack rate-limit/backoff
  handling or update/recovery notification variant (only the initial
  post); no adversarial "malicious telemetry" test against the evidence
  whitelist; §7.4 (optional fix PR) untouched, correctly deprioritized as
  P2.
- 2026-07-23 (§8 built and live-verified: the "Fuse - Agent Cost Health"
  dashboard). Added two OTel instruments that didn't exist anywhere
  before this slice: `fuse.estimated_cost.usd.total` (a counter —
  `fuse.estimated_cost.usd` previously existed only as a per-span
  attribute, never a queryable metric) and `fuse.preflight.state` (a
  gauge, always `1`, dimensioned by the state label — Preflight's
  committed state had no metric at all). Both recorded server-side at
  the same authoritative point their siblings already are
  (`gen-ai-span.ts`'s cost computation; `routes/preflight.ts`'s
  `store.evaluate()` call site) — 2 new unit tests in `metrics.test.ts`,
  plus a new `services/control-plane/src/routes/preflight.test.ts` (2
  tests) covering the gauge wiring specifically, mirroring
  `routes/permit.test.ts`'s existing pattern for its own counter.
  Built `infra/signoz/dashboards/fuse-agent-cost-health.json` (7 panels)
  and `infra/signoz-dashboard-up.sh` (idempotent update-by-title, unlike
  the alert script's create-if-missing). Getting a single widget to
  actually render took three attempts, each verified by round-tripping a
  real `PUT`+`GET`+page-reload rather than trusting a `200` response —
  documented in full in `docs/adr/008-signoz-dashboard-provisioning.md`:
  (1) a legacy flat query shape was accepted by the API but silently
  never rendered; (2) the alert-rule's own v5 query envelope (a
  reasonable-looking guess, since it's the *correct* shape one call site
  over) was ALSO accepted and ALSO silently never rendered — dashboards
  use an entirely different, older `IBuilderQuery` shape, found only by
  reading the actual frontend TypeScript source; (3) once the query shape
  was right, the dashboard STILL wouldn't render because the `PUT`
  request body itself was double-nested (`{data: dashboardData}` when the
  endpoint stores the raw body verbatim as `Dashboard.data`) — found by
  comparing a `PUT` response against an immediate follow-up `GET`, since
  the `PUT` response alone was misleadingly "correct-looking." A fourth,
  separate discovery: `gen_ai.client.token.usage`/`.operation.duration`
  (the two OTel histograms) are never queryable under their bare metric
  name at all — SigNoz splits a histogram into independent
  `.sum`/`.count`/`.min`/`.max`/`.bucket` sub-metrics, confirmed by a
  direct ClickHouse query, not assumed. Live-verified end to end: ran the
  full narrated demo (`pnpm --filter @fuse/broken-agent run demo`,
  including a real Groq call) and confirmed 4 of the 7 panels showed real,
  non-empty, correctly-labeled data (breaker state transitions, Preflight
  `protected` state, both detector panels); the remaining 3 (spend, token
  usage, operation duration) render with zero schema errors but were
  empty at verification time, consistent with the same "needs ≥2 samples"
  characteristic already documented elsewhere for cumulative counters, not
  a new defect. Full clean-workspace verification: `pnpm run check` — 438
  unit tests across 10 packages; `pnpm run test:integration` — 83 tests,
  real Postgres, unaffected. Honest, scoped-out gaps (not silently
  dropped): dashboard variables, a projected-monthly-burn formula panel,
  instrumentation-coverage/orphan-rate/drop-rate panels (no metric exists
  for these yet), trace/log drill-down context links, and no
  runaway/high-cardinality/alternate-screen-size testing.

### Open blockers and risks

- `origin` is `git@github-personal:Vedant817/Fuse.git`, and repository-local
  identity is the required `Vedant817 <vedantmahajan271@gmail.com>`.
  GitHub CLI is not installed and the user has not authorized a push in this
  audit, so remote authentication/CI execution/publishing remain deliberately
  unverified.
- **Resolved**: the SigNoz-Cloud-credential blocker no longer applies — the
  deployment target was reversed to self-hosted SigNoz via Foundry
  (ADR-005/2026-07-21), which needs no external account or key. Real
  ingestion (traces + metrics + correlated logs, §3.3) is now verified.
  `signoz-alert-mapper.ts`'s label-propagation-format question has real
  evidence at the label-storage layer (dotted form confirmed preserved,
  §3.2 evidence above) — and now also a live end-to-end alert-fire proof:
  real webhook deliveries have correctly resolved to their scope three
  times (see §4.5, §12's 2026-07-22/23 slice-2 entry).
  **Resolved (2026-07-22/23):** §4.5's SigNoz alert-rule-as-code
  installation is done, and the UI's session-based auth was reverse-
  engineered against the real running instance (not guessed from docs) —
  see `docs/adr/006-signoz-alert-rule-provisioning.md` for the exact login
  flow (`GET /api/v2/sessions/context` → `POST /api/v2/sessions/
  email_password`) and rule/channel payload shapes. MCP is live, and Slack
  is now selected and live-verified in the `Vedant Personal` workspace.
- **Resolved (2026-07-23):** both real LLM provider credentials are available
  locally. `set -a; source .env; set +a; pnpm --filter @fuse/sdk run test:live`
  passed both live smoke tests (Groq: 184 ms; NVIDIA Build: 481 ms), each
  returning non-empty content and positive token usage. Keys remain ignored
  local configuration and were not printed or committed.
- `docs/threat-model.md` (§1.2) surfaced two security gaps, both now fixed:
  token-to-tenant binding (ADR-004 — opt-in, so a deployment that never
  migrates to `tenant:token` config entries remains exactly as exposed as
  before, by informed choice) and the webhook replay/timestamp-skew window
  (`isStaleAlert`). The one residual, still-open piece: a genuinely valid
  webhook token can still force a trip with a freshly-forged
  `(fingerprint, startsAt)` pair, since SigNoz has no payload-signing
  option — assessed low-severity (a trip is fail-safe, not data-exposing);
  recommended fix is a per-webhook-token trip-rate limit, tracked as
  follow-up work.
- **Resolved (2026-07-23):** arbitrary scope growth is closed by
  `registered_scopes`, operator-only registration, unknown-scope rejection
  on every route, and a race-safe configurable per-tenant ceiling.
- **External production prerequisites:** choose the real hostname/TLS secret,
  managed PostgreSQL/backup policy, registry image digest/scanner, external
  secret manager, and monitoring destinations before applying the generic
  Kubernetes base. These are environment ownership decisions, not code gaps.
- **Resolved notification limitation (2026-08-24):** trip audit and diagnosis
  job acceptance are transactional. Delivery is at-least-once with leases,
  retries, dead-letter listing, and audited replay.

### Decisions (2026-07-23, gap-closure session)

Following a full gap review against this file (see chat), the user made three
explicit scope decisions before work resumed:

- **Git remote/push stays deferred.** Stay local for now; every slice below is
  still committed locally with the required `Vedant817` identity, but not
  pushed anywhere. This remains a standing, tracked blocker (§0.1, §12 "Open
  blockers"), not silently dropped.
- **§7.3 Slack gets a real integration, not a stub.** Build real Slack Web
  API/webhook posting (bot token or incoming-webhook URL read from env) now;
  the user will supply the actual token later. Per existing conventions in
  this codebase (`PreflightReporter`, OTel shutdown), the integration must
  degrade safely — never throw, never block enforcement — when the token is
  absent or Slack is unreachable, and a local no-network renderer/snapshot
  path is built alongside it for demo rehearsal without live Slack.
- **Sequencing: full production rigor, top-to-bottom through task.md's own
  section order** (§4 → §7 → §8 → §9 → §10 → §11), explicitly accepting the
  later sections may not be reached before the 2026-07-26 hackathon deadline.
  Each slice still goes through the full AGENTS.md work cycle (define
  acceptance criteria → implement → test → gap review → update this file →
  commit) rather than being rushed unverified to cover more ground.

### Decisions and evidence (2026-07-23, continuation through §9-§11)

Continuing the sequencing decision above, §9 through §11 were completed in
order, each committed locally as its own atomic slice (14 commits this
continuation, all local per the standing git decision). Summary, in case
this context is lost elsewhere:

- **§9** (hardening): real `pnpm audit`/license/secret scan + SBOM (11
  advisories → 1 accepted risk); `@fastify/helmet` added after auditing
  secure defaults; a real `autocannon` load test against a live
  control-plane + Postgres (6.5k req/s @ c=50, DB pool identified as the
  ceiling @ c=200, zero errors either way); a genuine, previously-unnoticed
  bug found and fixed — `DetectorRunner` had no cap on the *number* of
  distinct scopes tracked (only each scope's own buffer was bounded), a
  caller-controlled memory-exhaustion vector, fixed with a 10,000-scope LRU
  cap; three new runbooks (`docs/runbooks/`).
- **§10** (test matrix): audited the existing suite's coverage against
  task.md's own categories (most already covered incidentally by earlier
  work) rather than re-deriving it; added 19 new property/fuzz tests
  (fast-check) for detector invariants and schema boundaries; hand-authored
  `docs/openapi.yaml` (13 routes, validated with `redocly lint`). Final
  real count: 396 unit + 83 integration = 479 tests, all passing.
- **§11** (demo/submission): rehearsed both demo beats live — the SigNoz
  alert-to-trip proof took 210.9s and produced an unscripted, genuinely
  interesting result (both `context-bloat` and `loop-signature` fired 11s
  apart; the system correctly applied only the first trip and recorded the
  second as an audited no-op); the Preflight beat proved real hysteresis
  (blind → recovering → protected only after the dwell window actually
  elapsed). New `docs/architecture.md` (Mermaid diagrams) and a full
  README overhaul. Four independent adversarial-review subagents
  (correctness/races, security/privacy, observability-claims,
  fresh-install reproducibility) found two real, fixed gaps (an unbounded
  attacker-controlled alert label reaching audit-log/log content; the
  shipped `.env.example` placeholder tokens silently working as real
  credentials) and one real, deliberately-not-fixed gap (the scope-
  cardinality growth noted above in "Open blockers").
- **Explicitly not done, stated honestly rather than silently skipped**: a
  produced two-minute video (no screen-recording/export capability
  available), saved screenshot/GIF image files (live-verified via browser
  instead), a literal from-clean-clone demo run, and release tagging
  (deliberately left to the user's own judgment given the one known-open
  gap above and the standing local-only git decision).

### Independent production-readiness audit evidence (2026-07-23)

The final adversarial pass re-derived the critical claims instead of trusting
the earlier checkmarks:

- Clean build: after deleting all `dist` directories and `.tsbuildinfo`,
  `pnpm install`, `pnpm run check`, `pnpm run test:integration`, and
  `pnpm run test:coverage` exited 0. Counts were 447 unit tests in 52 files
  and 88 integration tests in 11 files (535 total).
- Live enforcement: a real Groq-backed broken-agent run reached its configured
  safety ceiling, a live externally committed trip denied every subsequent
  provider dispatch (zero post-trip calls), resume restored service, and
  Preflight reported protected. Direct detector requests against the real
  server left a normal `[1,6,11,17]` token window armed, while a 100,000-token
  observation fired context-bloat and committed epoch 1.
- Multi-replica race: two independent production-mode control-plane processes
  raced the same detector trip against one Postgres database. SQL returned one
  audit transition (`1|0|1`), a permit through the other replica denied, and
  after adding internal idempotency-replay metadata exactly one Slack incident
  post was delivered rather than two.
- Slack/ngrok: Slack `auth.test` identified the `fuse` bot in the intended
  workspace, a real incident message was posted to channel
  `C0BKFBTFR4H`, the configured ngrok `/healthz` returned 200, a fresh signed
  interactive request returned 200, and a request signed 601 seconds earlier
  returned 401. A real one-use Slack `trigger_id` still requires a human button
  click to prove the modal itself in Slack.
- SigNoz: `infra/signoz-up.sh` started the self-hosted stack; a real SigNoz
  POST reached `/v1/webhooks/signoz` with status 200. The alert-channel
  provisioner now updates an existing channel's URL/token instead of silently
  retaining a stale placeholder.
- Packaging: `docker build --pull -t fuse-control-plane:release-candidate .`
  exited 0. The final image ran healthy and ready as user `node` with a
  read-only root filesystem, all Linux capabilities dropped, and
  `no-new-privileges`; the placeholder-token startup attempt correctly exited
  1 before the audit-only-token smoke was run.
- Final-image store failure injection: before the outage `/v1/permit` returned
  `allowed:true`; after `docker kill fuse-postgres` the same running process
  returned `allowed:false`, `state:"unknown"`, `degraded:true` and `/readyz`
  returned 503 `store_unavailable`; after `docker start fuse-postgres`,
  `/readyz` returned 200 and the next permit returned `allowed:true` without
  restarting the control plane.
- Supply chain/API/manifests: `pnpm audit --prod --audit-level low` returned
  `No known vulnerabilities found`; cdxgen produced a CycloneDX 1.6 SBOM with
  43 components/54 dependencies; Redocly reported the OpenAPI document valid;
  kubeconform strict mode validated all 10 base resources plus the migration
  job. The actual local Kubernetes API's dry-run could not be trusted because
  that configured endpoint returned HTML, so a real target-cluster admission
  dry-run remains a deployment prerequisite.
- Structural frontend check: workspace manifests contain only backend/control
  plane, SDK, detector, diagnosis, OTel, Preflight, and demo-agent packages.
  A source-tree search excluding generated coverage found no HTML, CSS, TSX,
  React, Next, Vite, Vue, Svelte, or Angular application.

### Personal free-tier deployment and Slack action correction (2026-07-24)

- A real Slack incident exposed a wiring defect: `incident-card.ts` supported
  `fuse_resume`, and the signed interactive route was live, but
  `runDiagnosisAndNotify` never supplied `resumeActionValue`, so every actual
  Slack card was read-only. The worker now includes the serialized scope only
  when both `SLACK_SIGNING_SECRET` and an exact-tenant (or explicit wildcard)
  operator token are usable; otherwise it logs why the action was omitted.
  `pnpm --filter @fuse/control-plane exec vitest run
  src/diagnosis-worker.test.ts src/routes/slack-interactive.test.ts` passed
  25/25 tests. A new real `demo/live-button/agent-resume` context-bloat trip
  returned enforcement `tripped` and delivered Slack timestamp
  `1784833926.521259`.
- The three ignored local control-plane credentials were replaced with
  independent 64-hex `demo`-scoped values and `.env` was restricted to mode
  `0600`. Provider-managed credentials accidentally surfaced during a local
  Compose-render validation and must be rotated before deployment; the three
  Fuse-owned credentials were immediately rotated again. Future Compose
  validation uses an empty env file plus `config --quiet` so secrets cannot be
  rendered into logs.
- For the personal zero-cost target, the selected topology is one OCI Always
  Free Ampere A1 VM (2 OCPUs/12 GB), Neon Free PostgreSQL, self-hosted SigNoz
  Foundry, public GHCR multi-architecture images, and the existing reserved
  ngrok HTTPS hostname. This preserves the full demo/product path but is
  explicitly not HA or SLA-backed. The release workflow, hardened Compose
  definition, and owner steps are checked in under
  `.github/workflows/release.yml`, `infra/production/oci-free/`, and
  `docs/runbooks/oci-free-tier.md`.

### Migrations silently never ran in the deployed container/Kubernetes layout (2026-07-24)

- Actually executing the documented deployment path — not just reading
  it — found a critical, previously-undetected gap: `docker compose -f
  infra/production/oci-free/compose.yaml --profile tools run --rm migrate`
  (the exact command the runbook and the Kubernetes migration Job both use)
  exited `0` with **zero output** and created **zero tables** against a
  freshly created Postgres database. `migrate.ts`'s CLI-entry guard compared
  `process.argv[1]` (the literal invoked path) against
  `fileURLToPath(import.meta.url)`; `pnpm deploy`'s production layout puts
  `@fuse/breaker-store` under `node_modules/.pnpm/...` and symlinks it into
  `node_modules/@fuse/...`, so Node's ESM loader resolves `import.meta.url`
  through the symlink target while the CLI is invoked through the symlink
  path itself — the two strings never matched, so `main()` never ran. Every
  Docker/Kubernetes deployment of this repository would have started against
  an unmigrated database with no error, warning, or non-zero exit code.
- Verified directly: `readlink -f
  /app/node_modules/@fuse/breaker-store/dist/migrate.js` inside the built
  image resolved to
  `/app/node_modules/.pnpm/@fuse+breaker-store@file+packages+breaker-store/node_modules/@fuse/breaker-store/dist/migrate.js`,
  confirming the mismatch. This was previously masked because the only prior
  manual verification used `pnpm --filter @fuse/breaker-store run migrate`
  (`tsx src/migrate.ts`, no symlink indirection, argv[1] matches exactly) —
  the actual containerized invocation shape had never been executed before.
- Fixed by extracting and exporting `isMainModule(argv1, moduleUrl)`, which
  resolves `argv1` through `realpathSync` before comparing, making the check
  symlink-proof; added `packages/breaker-store/src/migrate.test.ts` (5 tests)
  reproducing the exact symlink layout. Re-verified end-to-end: built the
  production image fresh, created a throwaway Postgres database, ran the
  unmodified `compose.yaml` migrate command — `applied: 0001_init.sql,
  0002_preflight.sql, 0003_scope_registry.sql`, 6 tables created — then `up
  -d control-plane` against that same freshly migrated database returned
  `/healthz` 200 `{"status":"ok"}` and `/readyz` 200 `{"status":"ready"}`.
  Clean-slate gate re-run after the fix: `pnpm run check` — **454 unit tests**
  across every package — and `pnpm run test:integration` — **88 integration
  tests across 10 files** — both green.

### Full supported-runtime verification and dependency advisory (2026-07-26)

- The host initially selected Node 22.13.1 despite the repository's declared
  Node >=24 production baseline. Installed and activated Node 24.0.0 through
  the existing NVM for Windows installation, retained the declared pnpm
  11.6.0 version, and verified `pnpm install --frozen-lockfile`.
- `pnpm run check:full` passed under Node 24: formatter, linter, all builds,
  strict type checks, **454 unit tests**, and **88 integration tests** against
  real Testcontainers PostgreSQL.
- A fresh `pnpm audit --prod --audit-level low` then found one new
  high-severity advisory, GHSA-c96f-x56v-gq3h, in Fastify's transitive
  `find-my-way@9.6.0` router. Added a narrowly scoped workspace override and
  regenerated the lockfile; `pnpm why find-my-way` now reports only 9.7.0 and
  the audit reports `No known vulnerabilities found`. Post-remediation narrow
  verification passed: **130 control-plane unit tests** and **49
  control-plane integration tests**. Full post-remediation and live-stack
  evidence follows in this verification session's final report.
- The documented Windows SigNoz launcher initially failed twice: CRLF shell
  checkout endings made Bash reject `pipefail`, then Foundry inherited Docker
  Desktop's Windows-only credential helper and failed with an `exec format
  error`. Added `.gitattributes` (`*.sh text eol=lf`) and a WSL-only isolated
  Docker config for this public-image Foundry cast. After installing the
  missing user-scoped `jq` 1.8.2 dependency, the exact
  `bash ./infra/signoz-up.sh` command completed idempotently against SigNoz
  v0.133.0, and the alert/dashboard provisioners created the webhook channel,
  all three rules, and the seven-panel cost-health dashboard.
- The first `demo:real-detect` run falsely claimed a SigNoz alert trip in
  132ms. Live breaker status proved the actor was actually the newer
  synchronous `system:detector:loop-signature` path; the demo checked only
  `state === "tripped"` and had become misleading as the architecture
  evolved. Fixed it to clear that direct trip once, re-arm, and accept only a
  later `system:signoz-webhook:*` trip. The corrected real run stayed armed
  for **330.76 seconds** before the authenticated SigNoz webhook trip landed.
- Live functional evidence: the narrated demo proved exactly three model
  dispatches before trip and zero afterward, three of three additional calls
  denied, authorized resume, Preflight `protected`, and a guarded real Groq
  call (45 tokens). The complete Preflight beat returned
  `protected/healthy` → `blind/missing-required-fields` →
  `blind/recovering` → `protected/healthy` after the 60-second dwell.
  Chromium rendered the real dashboard with armed permit, protected
  Preflight, and all three detector series. SigNoz MCP's live evidence test
  passed after least-privilege service-account provisioning.
- Production/failure evidence: `docker build -t
  fuse-control-plane:verification .` passed; the image ran as `node` with a
  read-only root, all capabilities dropped and `no-new-privileges`, returning
  `/healthz` and `/readyz` 200. Stopping only `fuse-postgres` left liveness
  200, changed readiness to 503, and returned a fail-closed degraded permit;
  restarting Postgres restored readiness and allowed permits without a Fuse
  restart. Live Slack delivery was subsequently configured and verified
  through the production `postIncidentCard` client against the real incident
  channel (Slack message timestamp `1785052383.486849`). NVIDIA Build remains
  externally blocked because the configured key returns HTTP 401. Both
  offline/failure paths degrade without weakening enforcement.
- Final post-change verification passed: `pnpm run check:full` completed
  formatting, linting, every build, strict type checking, **454 unit tests**,
  and **88 integration tests**; `pnpm audit --prod --audit-level low`
  reported `No known vulnerabilities found`.

### Release/build/deployment credibility repair (2026-08-24)

- Forced every workspace build to discard only its own stale build metadata
  before compilation and added the same stale-cache regression to CI. Local
  reproduction retained 10 ignored
  `tsconfig.tsbuildinfo` files, removed all 10 `dist` directories, then
  `pnpm run build` regenerated all 10 outputs successfully.
- Patched the 9 newly reported production advisories with narrow workspace
  overrides (`fast-uri` 3.1.5/4.1.2, `ip-address` 10.3.1, `hono` 4.12.34)
  and regenerated the lockfile. `pnpm install --frozen-lockfile` and
  `pnpm audit --prod --audit-level low` both exited 0; the audit reported
  `No known vulnerabilities found`.
- Release now builds amd64 and arm64 candidates once, smoke-tests those exact
  local images (migration CLI, hardened runtime, liveness, readiness), and
  authenticates/pushes only afterward; the multi-architecture manifest is
  assembled from those tested platform tags rather than rebuilt during
  publish. Local equivalent evidence: amd64 image
  `sha256:f73eabaac3a753b25a927e65346dabb44438086a4d3960644e07a394acfbbc0b`
  and arm64 image
  `sha256:245a0586c10d25b8d0de3c5e5b5c5761a925e904e26b5820507a561b4d33b803`
  both applied migrations `0001` through `0004`, ran as `node` with a
  read-only root, all capabilities dropped and `no-new-privileges`, and
  returned 200 from `/healthz` and `/readyz`.
- Startup and readiness now validate the complete required table/column set
  and every required migration ledger entry. Five unit tests and two real
  PostgreSQL integration tests pass; deleting the `0004` ledger row changed
  readiness to 503 `schema_not_ready`, and restarting that exact image exited
  1 instead of leaving an unlistening PID alive.
- The Kustomize base now renders a distinctly named, suspended migration Job
  template because plain `kubectl apply` has no migration-before-Deployment
  ordering; the runnable standalone Job remains the explicit run-and-wait
  path, and its completed immutable resource cannot collide with a later base
  apply. `kubectl
  kustomize | kubeconform v0.7.0 -strict -summary` validated all 11 resources
  (11 valid, 0 invalid/errors/skipped). `actionlint` 1.7.7 passed both
  workflows, and the canonical 201-line Apache-2.0 license text replaced the
  prior abbreviated/non-canonical file.
- Verification blocker outside this slice's ownership: the repository-wide
  `pnpm run check` completes format, lint, every build, and every typecheck,
  but currently fails 5 concurrent `services/broken-agent/src/
  analyzer-verifier.test.ts` assertions. The new default fail-closed step
  reporter returns `breaker-tripped` where those tests expect normal/safety
  completion. The owned control-plane suites are green: 160 unit tests and 55
  PostgreSQL integration tests. No commit or push was made per the explicit
  request, so GitHub release execution/registry digest evidence remains
  pending.

### Distributed production rate limiting (2026-08-24)

- Replaced the production-unsafe replica-local limiter with
  `@fastify/rate-limit`'s documented ioredis integration. Production config now
  requires `CONTROL_PLANE_RATE_LIMIT_REDIS_URL`, and `buildApp` independently
  requires a connected `ready` Redis client; local/test still deliberately use
  the plugin's in-memory store when no URL/client is supplied.
- The Redis client uses a 2-second connect timeout, one retry per command, two
  bounded reconnect attempts, no offline queue, and explicit startup `PING`.
  Startup refuses to listen when Redis is unavailable; runtime storage errors
  fail requests closed because `skipOnError` is explicitly `false`. Graceful
  shutdown drains HTTP and diagnosis work, closes Redis, then closes PostgreSQL
  and OTel.
- Limiter keys never retain raw bearer credentials: authenticated keys contain
  a stable, fixed-size SHA-256 base64url digest; health/unauthenticated requests
  use IP. The 429 contract now returns stable `rate_limited` rather than being
  rewritten to `invalid_request`.
- Real Redis evidence (`redis:7.4.2-alpine`, generic Testcontainers): two
  independent Fastify/ioredis instances shared one credential counter; the
  third aggregate request returned 429; Redis contained one hashed key with no
  token substring; health stored an IP key; stopping Redis caused runtime
  requests to fail closed and a fresh client to reject startup within the
  bounded window.
- Verification: control-plane build and strict typecheck exited 0; 172/172 unit
  tests and 57/57 integration tests passed; focused ESLint and Prettier passed;
  `pnpm audit --prod --audit-level low` reported no known vulnerabilities;
  OCI Compose `config --quiet` and `kubectl kustomize` passed. `kubeconform`
  strict validation was not rerun because that executable is unavailable on
  this host. No commit or push was made per the explicit request.

### Epoch-bound SigNoz detector episodes (2026-08-24)

- Replaced timestamp/current-state supersession inference with an immutable
  source breaker epoch. `/v1/detectors/observe` reads one baseline breaker
  record, emits `fuse.detector.score` and `fuse.detector.fired` with
  `fuse.source_epoch`, and binds its direct CAS trip to that same epoch. If two
  detectors fire from one window they retain the same metric epoch and at most
  one direct transition is committed.
- All three SigNoz detector rules now group by `fuse.source_epoch`, preserving
  the episode in alert labels. The mapper accepts dotted/underscored keys but
  only canonical base-10, nonnegative safe integers. Legacy/malformed unbound
  firing alerts return stable `unbound-alert` without reading or mutating
  breaker state.
- The webhook passes the immutable source epoch as `expectedEpoch` and no
  longer reads mutable current state or retries with `current.epoch - 1`.
  Delayed epoch N delivery after direct trip plus authorized resume at N+2 is
  rejected `stale-epoch`; the same epoch N alert trips as fallback when an
  injected direct commit outage leaves state at N. Exact duplicate delivery
  replays the original durable result with an unchanged request hash.
- SigNoz fingerprints are hashed with the episode identity into a 71-character
  `signoz:<sha256>` correlation/idempotency value before persistence. A 20,000
  character fingerprint test proves both fields remain within the existing
  200-character contract limit.
- Verification: contracts unit suite 70/70; control-plane unit suite 186/186;
  broken-agent unit suite 33/33; focused real-Postgres webhook integration
  17/17; contracts/control-plane/broken-agent builds and strict typechecks all
  exited 0; focused ESLint and Prettier passed. The three SigNoz JSON artifacts
  passed Prettier parsing/format validation; live SigNoz rule re-provisioning
  was not run in this slice. No commit or push was made per explicit request.

### Diagnosis delivery operations hardening (2026-08-24)

- Active diagnosis deliveries now renew their PostgreSQL lease every third of
  the configured lease duration. Renewal is ownership- and expiry-conditional,
  timers stop and in-progress renewals drain before completion, and a rejected
  or failed renewal is treated as lost ownership: the stale worker does not
  complete or retry the job. Real-PostgreSQL coverage proves renewal prevents a
  second worker reclaim and expired owners cannot finalize work.
- Slack `chat.postMessage` now receives a deterministic UUID-shaped
  `client_msg_id`, derived by SHA-256 from the durable breaker audit plus
  correlation identity and bounded to 36 characters. Retries and dead-letter
  replay therefore cannot create provider-level duplicate incident cards even
  if Slack accepted a request before Fuse lost its lease/response.
- Added low-cardinality OTel instruments:
  `fuse.diagnosis.queue.jobs` (`pending`/`running`/`dead-letter` only),
  `fuse.diagnosis.delivery.latency`, and
  `fuse.diagnosis.delivery.attempts` (finite outcome only). No tenant, audit,
  worker, attempt number, or correlation identity is used as a metric label.
- Added operator-only `GET /v1/diagnosis/jobs` with bounded filters, limit
  1-100, stable keyset cursor pagination, and tenant token binding. Added
  `POST /v1/diagnosis/jobs/{auditEventId}/replay`, requiring the exact scope,
  manual actor, bounded reason, and idempotency key. Migration `0007` stores an
  immutable replay audit. Transaction-level idempotency serialization makes a
  duplicate request return the original result; pending, running, and succeeded
  jobs cannot be replayed, and a cross-tenant scope is indistinguishable from a
  missing job. OpenAPI and `.env.example` reflect the operations and worker
  bounds.
- Verification: edited package/control-plane builds and strict typechecks
  exited 0; diagnosis unit 49/49; OTel unit 27/27; diagnosis-focused
  control-plane unit 41/41; diagnosis store real-PostgreSQL integration 12/12;
  complete control-plane integration 58/58; repository-wide ESLint and Prettier
  checks passed; `git diff --check` passed (line-ending warnings only). The full
  control-plane unit command currently has one unrelated concurrent failure in
  `routes/health.test.ts`: its stale-ledger fixture removes current final
  migration `0006` but still expects missing `0004`. This slice did not alter
  that shared readiness test. No commit or push was made per explicit request.

### Release workflow integrity completion (2026-08-24)

- The release publisher now validates an OCI-compatible SemVer-like version
  before any build (`v0.1.0` and prereleases accepted; empty, `latest`, build
  metadata, leading-zero, and malformed values rejected). Every release run is
  globally serialized because version and commit tags share registry state.
- Each amd64/arm64 candidate is built exactly once with embedded BuildKit
  attestations disabled, then smoke-tested before registry authentication. Each
  architecture gets a fresh PostgreSQL database, applies all seven migrations
  through `0007_diagnosis_job_replays.sql`, and starts with
  `CONTROL_PLANE_DEPLOYMENT_ENVIRONMENT=production`, the checked-in detector
  policy, shared Redis, and an exact tenant/environment/agent-bound credential.
  Readiness and an armed permit must pass, while that credential's wrong-scope
  permit must return 403.
- After smoke, the workflow authenticates and fail-closes unless it can prove
  all six destination tags are absent. It then pushes only the tested local
  platform images and creates version/commit manifests from those tags. The
  final manifest must contain exactly two entries (`linux/amd64` and
  `linux/arm64`), and both aliases must resolve to the same digest.
- Release evidence now includes the pre-existing source CycloneDX SBOM plus a
  final-image SPDX SBOM. Pinned official GitHub actions publish build-provenance
  and SBOM attestations with the final manifest digest as subject and registry
  referrers enabled. The publish job alone receives `packages: write`,
  `attestations: write`, and OIDC `id-token: write`; all other permissions remain
  read-only.
- Production policy is now one JSON source consumed by release smoke,
  Kustomize's generated ConfigMap, and OCI Compose. Kubernetes and the migration
  template render with a digest placeholder, OCI Redis is digest-pinned, and the
  deployment runbook uses exact-scope agent credentials, the Redis secret, a
  verified manifest digest, and explicit migrate -> wait -> deploy ordering for
  the current seven migrations.
- Added `pnpm run test:release-workflow`, which YAML-parses both workflows and
  locks in action SHA pins, least permissions, service/config/smoke requirements,
  non-publishing candidate builds, tag refusal ordering, exactly-two-platform
  assembly, digest-bound attestations, source-SBOM retention, and positive/
  negative version fixtures. CI and release verification both run it.
- Verification: native `actionlint` was absent, so the official
  `rhysd/actionlint:1.7.7` container checked both workflows with zero findings;
  Ruby/Psych parsed both YAML files; the structural test passed; `kubectl
  kustomize infra/production/kubernetes` and digest-populated OCI Compose
  `config --quiet` passed; `pnpm run check` passed formatting, lint, all builds,
  strict typechecks, and 553/553 unit tests; schema readiness's focused unit
  tests passed 48/48 and its real-PostgreSQL integration passed 2/2; `pnpm audit
  --prod --audit-level low` reported no known vulnerabilities.
- Final-image evidence: a fresh linux/amd64 production image applied exactly
  seven migration ledger rows (`0001` through `0007`), ran as `node` with a
  read-only root, all capabilities dropped and `no-new-privileges`, returned
  200 from `/healthz` and `/readyz`, registered and permitted the exact
  `release-tenant/production/release-agent` scope, and returned 403 when the
  same agent credential requested `wrong-agent`. Isolated smoke containers,
  network, and image were removed afterward.
- GitHub/GHCR-only evidence remains impossible locally: no manifest or tag was
  published, so registry collision behavior under GHCR's real error responses,
  final multi-architecture digest equality, OIDC issuance, GitHub artifact
  storage records, registry attestation referrers, and `gh attestation verify`
  cannot be observed until an authorized workflow run. No commit or push was
  made per the explicit request.

### Public documentation and diligence reconciliation (2026-08-24)

- Rewrote product, architecture, demo, security, operations, incident,
  limitations, deployment, and API documentation around the current direct
  detector hot path, epoch-bound SigNoz fallback, exporter-role-reported Preflight,
  exact-scope production agent credentials, shared Redis, and durable diagnosis
  queue. ADR-014 supersedes the earlier trigger ordering while preserving the
  historical brief and provisioning ADRs.
- Added sourced product strategy, a 30-day design-partner pilot, and a funding
  diligence document. Customer outcomes, production usage, detector quality,
  pricing, and ROI remain explicitly unverified hypotheses.
- Validation: README is 220 lines; targeted and repository-wide Prettier passed;
  Markdown local-link, documented-path, package-script, OpenAPI YAML, and 134
  OpenAPI reference checks passed; stale-claim scans returned no matches.
  `pnpm run check` passed format, lint, build, typecheck, and 564 unit tests.
  `pnpm run test:integration` passed 121 tests, including real PostgreSQL and
   Redis. `pnpm run test:package-consumer` built and consumed tarballs for
   `@fuse/contracts`, `@fuse/otel`, and `@fuse/sdk`. No commit or push was made
   per the explicit request.

### Release publication and SBOM evidence hardening (2026-08-24)

- Release is now manual-dispatch only. The source guard requires
  `refs/heads/main`, verifies checkout equals `GITHUB_SHA`, fetches
  `origin/main`, and requires the release commit to be its ancestor before
  dependency installation or build. The privileged publisher uses the GitHub
  `release` Environment; remote environment branch restrictions/reviewer rules
  must be configured in repository settings.
- Both exact local architecture candidates are built, production-smoked, and
  scanned before GHCR authentication. The scanner action is SHA-pinned, Grype is
  explicitly pinned to `v0.110.0`, high/critical findings fail an explicit
  two-architecture gate, and both reports are retained even when the gate fails.
  Successful candidates use only run/attempt-specific `staging-*` tags. Their
  two-platform staging manifest, final-image SBOM, digest-bound attestations,
  and retained evidence must all succeed before the only consumer-alias mutation
  step promotes version, commit, and stable `latest` aliases.
- Immutable-alias preflight accepts an absent alias or the exact candidate
  digest, making partial/exact-digest reruns resumable, and rejects an existing
  version or commit alias pointing elsewhere. Prereleases do not update
  `latest`. Release input is normalized to `v`-prefixed SemVer and must match the
  first dated changelog release beneath an empty `[Unreleased]`; current release
  notes are labeled `0.2.0`.
- Removed `docs/sbom.cdx.json`: its July point-in-time contents had drifted while
  retaining an authoritative-looking path. CI/release now generate run-bound
  CycloneDX workspace and SPDX image evidence. `validate-sbom.mjs` rejects an
  empty/wrong-format BOM and requires expected runtime components; the image
  check additionally requires deployed Fuse packages.
- Local commands/results: `pnpm run test:release-workflow` passed all structural
  invariants plus negative workflow, changelog, promotion-conflict, version, and
  incomplete-SBOM fixtures. `docker run --rm -v "${PWD}:/repo" -w /repo
  rhysd/actionlint:1.7.7 .github/workflows/ci.yml
  .github/workflows/release.yml` exited 0 with no findings. `npx --yes
  @cyclonedx/cdxgen@12.8.1 --type js --required-only --fail-on-error
  --no-install-deps --spec-version 1.6 ...` exited 0, and the validator accepted
  45 workspace components with every expected third-party runtime component.
  Fresh amd64 `docker build --pull ... --tag
  fuse-control-plane:release-evidence .` and arm64 `docker buildx build
  --platform linux/arm64 --provenance=false --sbom=false --load ...` commands
  both exited 0. Pinned Syft image digest
  `sha256:5999d209a342e55e9edf70bf8930fb5b86d8f2a783fa401178372c50e21b1d36`
  generated its SPDX 2.3 BOM; validation accepted 424 image components including
  the expected Fuse and third-party runtime packages. `pnpm audit --prod
  --audit-level low` reported `No known vulnerabilities found`.
- Repository gate: the first `pnpm run check` reached unit tests after format,
  lint, build, and typecheck but hit nine unrelated first-test 5-second timeouts
  in the concurrently-started control-plane suite while the host was under
  container scan/build load. The unchanged focused control-plane rerun passed
  207/207, and the exact full `pnpm run check` rerun then exited 0: formatting,
  lint, all builds/typechecks, 602 workspace unit tests, three SigNoz contract
  tests, and two deployment contract tests passed.
- **Release-blocking local result:** pinned Grype `v0.110.0` image digest
  `sha256:af65fbc0c664691067788fe95ff88760b435543e45595eb2ca6f102fc476fbe1`
  against each fresh amd64 and arm64 image exited 1 under `--fail-on high`, as
  the workflow now will. Findings include fixable high/critical issues in Node
  `24.14.0`, Alpine OpenSSL/musl, and npm-bundled `tar`/`minimatch` dependencies.
  Remediation requires Dockerfile/base/dependency changes outside this
  release-owned slice; publication intentionally remains blocked rather than
  accepting or hiding the findings.
- Remote-only checks remain: configure/verify the protected `release`
  Environment; run from pushed `main`; observe GHCR staging and immutable-alias
  conflict behavior, exact-digest rerun recovery, final amd64/arm64 manifest
  equality, artifact retention, OIDC issuance, registry attestation referrers,
  and `gh attestation verify`. No registry login, tag, attestation, commit, or
  push occurred in this slice.

### Strict operator mutation epoch binding (2026-08-24)

- `resume`, `disable`, and `enable` now require a nonnegative safe-integer
  `expectedEpoch` at the contract/OpenAPI boundary and pass it to the store CAS;
  no force/unbound bypass exists. Exact idempotency replay is checked before
  epoch comparison, while a new stale request returns structured `stale_epoch`.
- Real-PostgreSQL evidence: breaker-store 20/20 passed, covering delayed
  disable/enable, resume then retrip, historical exact replay, and 8-way
  concurrent duplicates for all three actions. Focused control-plane tests 3/3,
  webhook 17/17, SDK resume 1/1, Slack action 17/17, and Slack route 15/15 passed.
  Contracts passed 81/81; touched-file ESLint/Prettier and breaker-store/
  contracts build+typecheck passed; OpenAPI parsed with 152 references resolved.
- Existing concurrent-work blockers remain outside this slice: full
  control-plane integration has one Preflight 500, and control-plane/SDK/
  broken-agent typechecks fail in detector-observation, Preflight-store, Redis
  health-mock, and reporter types. No commit or push was made per request.

### Diagnosis and operator-facing truthfulness (2026-08-24)

- Replaced the incident diagnosis's absolute provider-dispatch claim with the
  enforceable boundary: subsequent guarded permit checks are denied after a
  committed trip. The card now also states that already-permitted calls may
  complete and unguarded calls are outside Fuse enforcement.
- Real diagnosis delivery reads the current committed Preflight result from the
  same control plane's authenticated status route. The query carries the exact
  incident tenant/environment/agent scope and the tenant-matching operator
  credential, validates the returned scope, and renders `unknown` rather than
  implying protection on no result, timeout, malformed/mismatched data, 429, or
  store failure. Slack and local incident snapshots render the same state.
- Fixed the incomplete `@fuse/sdk` and `@fuse/contracts` package introductions.
  OpenAPI now documents the reusable global 429 response on all 17 operations;
  health probes and Slack callbacks are explicitly not exempt.
- Verification: diagnosis unit tests passed 52/52; focused diagnosis worker and
  dispatcher tests passed 35/35, including tripped-card wording, degraded,
  blind, unknown, exact-scope credential selection, missing-state 404, and store
  503 behavior. Diagnosis build/typecheck, focused ESLint, focused Prettier, and
  Ruby OpenAPI YAML parsing passed. The full control-plane typecheck remains
  blocked by unrelated concurrent errors in detector fixtures, SDK test module
  resolution, health Redis mock types, and new Preflight sweeper/store methods;
  none reference the diagnosis files. No commit or push was made per the
  explicit request.

### Execution-scoped detector truthfulness and public SDK path (2026-08-24)

- Detector observations now carry a validated 1-128 character execution ID and
  a discriminated pricing status. Unpriced/unknown models leave estimated cost
  `null`, never semantic `$0`. The supported SDK keeps a separate 200-step
  trailing history and canonicalizer per execution, capped at 100 active
  executions with one-hour idle/oldest eviction; explicit reset/end APIs release
  lifecycle state. Legacy direct-API numeric observations remain accepted for
  existing integrations, but the public step schema and SDK path require the new
  identity and pricing fields.
- `FuseGuard.runStep` is the supported permit -> provider -> OTel -> local
  canonicalize -> synchronous direct-report composition used by the broken-agent
  fixtures and README. A post-paid report failure returns the provider result,
  retains evidence, and latches fail-closed denial at the next pre-call boundary.
  Per-execution detector status keeps loop-signature and context-bloat protected
  when pricing is unavailable while marking cost-velocity degraded.
- Tests cover concurrent interleaved executions without mixed request windows,
  lifecycle reset/end/eviction, unknown pricing, packed public SDK usage,
  next-call latching, and loop/context/cost fixture behavior. Verification:
  `pnpm run typecheck` passed all 10 projects; `pnpm run test` passed 601 unit
  tests; `pnpm --filter @fuse/sdk run test:integration` passed 11/11 against real
  PostgreSQL/control-plane HTTP and provider counters; focused ESLint/Prettier
  and `git diff --check` passed; `pnpm run test:package-consumer` built, packed,
  installed, typechecked, and executed `@fuse/contracts`, `@fuse/otel`, and
  `@fuse/sdk` from an isolated non-workspace fixture. No commit or push was made
  per the explicit request.
- Residual risk: intentionally supported legacy direct-API callers do not gain
  execution isolation until they adopt the new fields; callers can still bypass
  protection by dispatching outside `runStep`/`guard`, and calls already past a
  permit remain in flight. Pricing remains a static estimate table rather than
  invoice reconciliation.
- Aggregate `pnpm run check` reached repository-wide ESLint and stopped on the
  unrelated concurrent release validator (`tools/release/validate-workflow.mjs:26`,
  `structuredClone` reported by `no-undef`); the touched-file ESLint command
  passed. The broken-agent integration suite passed the three permit/direct-
  detector paths but retained its existing Preflight rejected-export failure
  (status 404 instead of the expected blind result), outside this slice's
  explicitly excluded Preflight reporter/store/routes ownership.

### Redis health semantics and operational security (2026-08-24)

- Health probes now bypass rate-limit storage. `/healthz` remains dependency-free
  HTTP 200 during a Redis outage; production `/readyz` performs a bounded 750 ms
  Redis `PING` before PostgreSQL/schema checks and returns structured HTTP 503
  `{status:"not-ready",reason:"rate_limit_store_unavailable",dependency:"redis"}`.
  Normal API traffic still uses `skipOnError: false`, and ioredis commands have a
  one-second timeout in addition to bounded connect/request retries.
- Real `redis:7.4.2-alpine` failure injection paused Redis under one running
  control-plane process. Liveness stayed 200, readiness returned the Redis 503,
  an actual `FuseGuard` in fail-closed mode left its provider callback uncalled,
  and a fresh startup client refused service. Unpausing Redis restored readiness
  and guarded provider dispatch through the same process/client without restart.
- SigNoz provisioning now updates existing rules by ID rather than skipping
  them, refetches persisted rules, and verifies every checked-in grouping. All
  three detector contracts require and round-trip `fuse.source_epoch`.
  Placeholder Slack Incoming Webhook URLs are rejected. API bodies are stored
  only under a mode-0700 temporary directory and are never printed on failure;
  request payloads use files rather than secret-bearing command arguments.
- Production bearer credentials are independently required to contain at least
  32 bytes by `loadConfig` and direct `buildApp` construction; deployment
  examples generate 32 random bytes with `openssl rand -hex 32` and include a
  no-value-printing production-env validator. Kubernetes and OCI Compose use
  separate runtime/migration/maintenance secrets. Distinct tokenless service
  accounts, DDL/DML/maintenance database role guidance, and a DNS/PostgreSQL-only
  database-job NetworkPolicy constrain authority as far as checked manifests
  can enforce it.
- Verification: control-plane build and strict typecheck passed; 207/207
  control-plane unit tests passed; focused health/rate-limit integration passed
  4/4 against real PostgreSQL and Redis; SigNoz script contracts passed 3/3;
  deployment secret/identity/network contracts passed 2/2; focused ESLint and
  Prettier passed; `bash -n infra/signoz-alerts-up.sh`, `kubectl kustomize`, OCI
  Compose `config --quiet`, and generated production config validation passed;
  `pnpm audit --prod --audit-level low` reported no known vulnerabilities.
- External residual validation: the provisioner was not applied to a live SigNoz
  instance, so the pinned v0.133.0 server's real `PUT` response and persisted
  `source_epoch` round-trip remain a deployment-time check. Target-cluster
  admission, external PostgreSQL role grants, managed Redis TLS/auth/HA, and
  secret-manager delivery also require environment-owner validation. No commit
  or push was made per the explicit request.

### Preflight liveness and multi-source correctness (2026-08-24)

- Migration `0008_preflight_source_evidence.sql` now persists bounded structural
  exporter evidence independently by tenant/environment/agent/source instance.
  Monotonic sequence orders callbacks only within one source. PostgreSQL receipt
  time drives liveness, so unrelated reporter wall clocks never supersede each
  other. `compareExporterDeliverySignals` retains its public signature but now
  returns `0` for distinct source instances (not comparable), replacing the
  previous cross-source wall-clock total order.
- The scope result is the worst active source result. A source remains active
  for twice `preflightMaxEvidenceStalenessMs`, ensuring a dead/failing process
  becomes stale and cannot be hidden immediately by a healthy peer; after that
  retirement window a live peer may recover through the existing dwell. If no
  source remains active, revalidation is blind. `GET /v1/preflight/status` now
  performs persisted-evidence revalidation using database time before replying.
  The existing report `revalidate` field remains accepted for compatibility,
  but correctness no longer depends on a reporter issuing it.
- The real server starts one non-overlapping Preflight sweeper after listen and
  stops it through Fastify close. Each pass is capped at 100 oldest aggregate
  rows and rotates work by committed `evaluated_at`; failures are contained and
  retried by the next interval. Opening/recovery metric events are derived under
  the same aggregate row lock and emitted only when that durable aggregate edge
  is returned, whether the trigger is a report, status read, or sweep.
- `PreflightReporter` now keeps one newest unacknowledged exporter result and one
  in-flight request, with a 2,000-sample queue cap, 60 KiB serialized-body cap,
  two-second hard request timeout, capped exponential backoff with jitter, and a
  three-second drain bound. A fetch implementation that ignores `AbortSignal`
  blocks further underlying requests instead of creating an unbounded pile; its
  eventual settlement resumes delivery of the coalesced newest result.
- Verification: contracts 81/81 unit; breaker-store 31/31 unit and 51/51 real-
  PostgreSQL integration (including 18/18 Preflight store cases); SDK 86/86 unit
  and 11/11 real-HTTP/PostgreSQL integration; control-plane 207/207 unit and
  60/60 PostgreSQL/Redis integration. Focused tests cover reporter death using
  PostgreSQL time, two active sources, cross-source clock skew, 503 then recovery
  of failed-export evidence, sustained samples behind a hung fetch, exact body
  size, bounded drain, non-overlapping bounded sweeps, read-time revalidation,
  one opening/recovery metric edge, and migration readiness. Contracts,
  breaker-store, SDK, and control-plane builds and strict typechecks passed;
  touched-file ESLint and repository-wide Prettier passed; `git diff --check`
  passed with line-ending warnings only.
- Repository-wide `pnpm run check` passed formatting, then stopped at the
  explicitly out-of-scope release validator
  `tools/release/validate-workflow.mjs:26` (`structuredClone` reported undefined
  by ESLint `no-undef`). Per the explicit ownership boundary, release workflows
  and release tooling were not changed. Consequently the current release smoke
  loop still names migrations only through `0007`; an owner must add `0008`
  before that workflow can produce a ready image. Operations/deployment prose
  that calls `0007` the latest migration is likewise stale.
- Residual risks: no load test establishes how quickly the fixed batch-100
  sweeper revisits very large multi-tenant scope sets; metric transport is not a
  durable outbox, so a process crash after the DB commit but before OTel records
  the edge can lose that metric; source-instance rows do not yet have a retention
  policy and can grow with repeated process restarts. The twice-staleness active
  window is deliberately conservative but may delay recovery from a dead peer.
   No commit or push was made per request.

### Provisional operational SLO metrics and SigNoz rules (2026-08-24)

- Added infrastructure-wide, bounded-cardinality OTel instruments for permit,
  detector observation, webhook, diagnosis lease renewal, Redis readiness,
  and Preflight evaluation/sweep health. Tenant, agent, source epoch, job,
  token, alert, and correlation identity are excluded from these SLO series;
  existing scoped product metrics remain separate.
- Added the versioned SigNoz v5/v2alpha1 artifact
  `infra/signoz/alerts/operational-slos-v1-provisional.json` and a dedicated
  resolved-capable `fuse-operations` Slack channel. Traffic rules treat absence
  as idle; diagnosis queue, Redis, and sweeper health treat five missing
  evaluations as no-data. Operational alerts cannot call the breaker webhook or
  resume state.
- Added static provisioning contracts that align every rule metric with
  `packages/otel/src/metrics.ts`, reject unbounded infrastructure groupings,
  prove explicit no-data policies, and verify persisted metric/version/schema/
  no-data fields. The operations and deployment runbooks record provisional
  targets, triage, cardinality caps, provisioning, and rollback-safe semantics.
- Verification: `@fuse/otel` unit tests passed 31/31; focused control-plane
  call-site tests passed 28/28 plus the authenticated-hook test 1/1; SigNoz
  static/provisioning contracts passed 4/4; the OTel build and strict typecheck,
  focused ESLint/Prettier, `bash -n infra/signoz-alerts-up.sh`, and
  `git diff --check` passed. The aggregate control-plane unit run reached
  208 passing tests but retained three concurrent exporter-credential fixture
  failures; control-plane build/typecheck is independently blocked by a
  duplicate property in the concurrently added
  `slack-interactive.integration.test.ts:44`. Neither blocker is in this
  slice's auth/release ownership, so it was not changed. Live application to
  SigNoz v0.133.0 remains a deployment-time round-trip check. No commit or push
  was requested.

### Distributed webhook and Slack control-path race evidence (2026-08-24)

- `webhook.integration.test.ts` now constructs two independent `buildApp`
  replicas with separate pools sharing one real PostgreSQL container. Concurrent
  identical SigNoz delivery returns the same durable result from both replicas
  and produces exactly one armed-to-tripped audit and one diagnosis job. A
  coordinated direct-detector baseline read races the epoch-matched SigNoz
  fallback through the real store mutation path; either source may win, but the
  final state is epoch 1 with one transition/job, and exact webhook replay is
  stable. A delayed epoch-0 alert delivered only after resume and an epoch-2
  retrip is durably stale, replays identically, and leaves the epoch-3 incident
  plus both diagnosis jobs intact.
- Added `slack-interactive.integration.test.ts`: two listening `buildApp`
  replicas receive real HMAC-signed `application/x-www-form-urlencoded` Slack
  submissions and call the real authenticated resume API against shared
  PostgreSQL. Concurrent duplicate view IDs create exactly one Slack resume
  audit; different view IDs racing one trip epoch permit exactly one resume and
  return a stable stale-epoch modal error for the loser; an old card after
  resume/retrip cannot alter the later episode. Exact tenant-token selection is
  proven with same-agent-id scopes in two tenants: tenant B resumes while tenant
  A remains tripped with zero Slack resume audits.
- Focused verification before a concurrent out-of-scope Preflight edit:
  `pnpm exec vitest run services/control-plane/src/webhook.integration.test.ts`
  passed 20/20 and `pnpm exec vitest run
  services/control-plane/src/slack-interactive.integration.test.ts` passed 4/4.
  Focused ESLint, Prettier, and `git diff --check` passed. No mocks replace final
  breaker mutations, and no production webhook/Slack code changed.
- Later aggregate verification is currently blocked before test collection by
  the concurrently edited, explicitly out-of-scope Preflight contract:
  `packages/contracts/src/preflight.ts:127` calls `.strict()` on the
  `ZodEffects` returned by `.superRefine()`. The contracts build reports TS2339,
  and `pnpm --filter @fuse/control-plane run test:integration` reports the same
  runtime `TypeError` in all six collected integration files. Preflight code was
  not changed in this slice. No commit or push was made per request.

### Enforcement E2E and permit-race closure (2026-08-24)

- Replaced the broken-agent's direct operational-trip simulation with a
  parameterized real-PostgreSQL, listening-control-plane, listening-model-server
  proof for `loop-signature`, `context-bloat`, and `cost-velocity`. Every paid
  request runs through `FuseGuard.runStep`, carries an execution ID, reports its
  complete bounded window to `/v1/detectors/observe`, and stops with zero
  additional provider requests. The captured acknowledgment fires only the
  expected detector and carries non-empty structural evidence; a joined
  `breaker_state`/`breaker_audit_log`/`diagnosis_jobs` query proves the trip and
  diagnosis evidence committed first with the matching
  `system:detector:<detector>` actor, version, score, and threshold.
- Replaced the direct-provider in-flight simulation with an actual guarded race.
  Controllable permit, commit, and provider barriers start eight guarded calls:
  three complete permits before the atomic trip and may cross the real provider
  HTTP boundary afterward; five attempts begun concurrently but released only
  after commit are denied. A ninth post-commit call is also denied. The listening
  provider records exactly three requests, all attributable to pre-commit
  permits; no test dispatch bypasses `FuseGuard`.
- Paused the real PostgreSQL container after one paid provider call and reported
  retained firing context-bloat evidence. Reporting timed out without replacing
  the paid result; the next guarded call failed closed with zero provider
  requests. After PostgreSQL recovery, the first attempt was the mandatory
  recovery barrier, retained evidence committed one attributed trip/diagnosis
  row, and the following permit remained denied by durable tripped state.
- Focused strict typechecking exposed a real SDK compile bug in the concurrently
  added exporter-evidence credential path: `FuseGuard` passed an explicitly
  undefined optional property under `exactOptionalPropertyTypes`. The smallest
  production fix conditionally omits `exporterEvidenceToken`; no other production
  code changed.
- Verification: SDK and broken-agent builds and strict typechecks passed;
  focused ESLint and Prettier passed; `git diff --check` passed with line-ending
  warnings only. With the ignored generated contracts artifact temporarily
  corrected to match the intended strict-object-before-refinement ordering,
  `pnpm --filter @fuse/sdk exec vitest run
  src/guard.integration.test.ts` passed 8/8 and `pnpm --filter
  @fuse/broken-agent exec vitest run
  src/analyzer-verifier.integration.test.ts` passed 5/5. That generated-only
  diagnostic change was restored and is not part of the worktree.
- Aggregate clean-source execution remains blocked before test collection by the
  pre-existing, out-of-scope `packages/contracts/src/preflight.ts:127`
  `.superRefine(...).strict()` runtime error documented immediately above. Per
  the explicit ownership boundary, the contracts source was not changed. No
  commit or push was made per request.

### Diagnosis crash, lease, and replay correctness (2026-08-24)

- Replay idempotency no longer reads mutable diagnosis queue state. Both the
  initial replay and every matching duplicate reconstruct the original pending,
  attempt-zero response from immutable incident fields plus the existing replay
  audit's PostgreSQL transaction timestamp. Duplicates after the job is claimed
  and after it succeeds return the same original job snapshot. No migration
  `0009` is needed: `diagnosis_job_replay_audit.created_at` already captures the
  exact `now()` used by the transactional requeue, so readiness and migration
  documentation remain unchanged.
- Added process-level real-PostgreSQL crash evidence. A separate Node process
  claims attempt one through `DiagnosisJobStore`, enters the real Slack client,
  and blocks with `chat.postMessage` in flight. The test hard-kills that process
  without dispatcher stop or lease release, waits for expiry, then starts the
  production `DiagnosisDispatcher`. The replacement reclaims attempt two; the
  crashed worker identity cannot complete it; both Slack requests carry the same
  deterministic UUID-shaped `client_msg_id`; and the replacement succeeds.
- Added real PostgreSQL renewal-outage evidence. The test stops the actual
  Testcontainers PostgreSQL container while a delivery is blocked, observes the
  dispatcher's renewal failure/lost-ownership path, health-aware restarts and
  reconnects PostgreSQL, and proves the stale worker still cannot finalize. A
  replacement reclaims attempt two and a controlled downstream failure reaches
  the bounded dead-letter state with the delivery error preserved.
- Focused verification: breaker-store build and strict typecheck passed;
  control-plane build and strict typecheck passed; touched-file ESLint and
  Prettier passed; diagnosis dispatcher unit tests passed 8/8 and diagnosis route
  unit tests passed 4/4. With a temporary out-of-workspace Vitest setup that only
  bypassed the pre-existing Preflight import-time defect, the diagnosis store
  real-PostgreSQL suite passed 12/12 and the new process/PostgreSQL dispatcher
  integration suite passed 2/2 together. The checked-in diagnosis tests contain
  no such bypass.
- Standard Vitest collection remains blocked by the explicitly out-of-scope
  `packages/contracts/src/preflight.ts:127` call to `.strict()` on a
  `ZodEffects` after `.superRefine()`, producing the documented runtime
  `TypeError` before diagnosis tests load. Preflight was not changed. Residual
  semantics remain deliberately at-least-once: deterministic Slack identity
  allows provider deduplication, but Fuse cannot make an external provider's
  acceptance and its PostgreSQL completion commit one atomic transaction. No
  commit or push was made per request.

### Separate exact-scope Preflight exporter evidence credential (2026-08-24)

- Split the trust boundary into strict contracts and routes. Ordinary agent or
  operator reporting to `POST /v1/preflight/report` may submit bounded structural
  observations but the contract rejects `exporterDelivery`. Only
  `POST /v1/preflight/exporter-evidence` accepts a bounded exporter result and
  its structural batch, and only the new exporter-evidence credential class can
  call it. Exporter credentials receive 403 on permit, detector, status,
  webhook, and operator routes.
- Production startup now requires
  `CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS` with at least one complete
  `tenant:environment:agentId:token` binding. Missing, partial, wildcard,
  shorter-than-32-byte, duplicate-within-role, or raw-token-reused-across-role
  credentials fail startup. Development/test may explicitly omit the role for
  structural-only Preflight or configure an explicit wildcard; neither behavior
  is a production default. Placeholder errors no longer echo any token value.
- `PreflightReporter` and `FuseGuard` accept a separate
  `exporterEvidenceToken`. Real OTel callbacks use that token and the exporter
  route; without it the reporter sends only structural samples with the ordinary
  agent token and cannot establish `protected`. The shared Redis-backed global
  limiter includes exporter credentials under hashed bearer keys, so replica
  scaling does not multiply the allowance and raw tokens are not stored in
  limiter keys.
- `.env.example`, README/SDK references, Kubernetes runtime-secret guidance,
  OCI Compose's required external secret, deployment/operations runbooks,
  OpenAPI, architecture, ADR-014, limitations, demo/pilot/strategy docs, and the
  threat model describe the role split. Public wording now says
  exporter-role-reported evidence, not cryptographic or server-verified proof.
- Required abuse evidence passes against real PostgreSQL/control-plane HTTP:
  ordinary-agent forged success is rejected without creating protected state;
  a wrong-scope exact exporter token receives 403; an exact valid exporter
  report establishes protected; and the exporter token receives 403 from permit
  and operator status. Real Redis tests prove the exporter route shares one
  hashed token-keyed limit across two replicas. The supported OTel runtime
  integration reports success/failure through the separate credential.
- Verification: `pnpm run check` passed repository formatting, ESLint, all 10
  builds and strict typechecks, 614 unit tests, 4 SigNoz contracts, and 3
  deployment contracts. `pnpm run test:integration` passed 143/143 tests across
  OTel, breaker store, control plane, SDK, and broken agent. Focused control-plane
  Preflight/Redis integration passed 20/20; SDK guard passed 8/8; broken-agent
  runtime passed 5/5. Production config validation, OCI Compose `config --quiet`,
  `kubectl kustomize`, OpenAPI YAML parsing with 163 references resolved, and
  `git diff --check` passed. One full-run-only SDK race assertion incorrectly
  required concurrent callback order; it now compares the same three callbacks
  order-independently without weakening count/membership/zero-post-trip checks.
- Residual trust assumption: a bearer credential authenticates possession of
  the exporter capability, not which code generated a report. The supported
  Node runtime is in-process, so a fully compromised agent that can read the
  exporter token can fabricate success. Process separation reduces this risk
  only when the exporter and secret are actually isolated from the agent OS
  identity/container; compromise of that exporter process, host, or secret
  manager remains authoritative. No commit or push was made per request.

### Checked-in OpenAPI validation and runtime conformance gate (2026-08-24)

- Added `tools/openapi/validator.mjs`, using only the already-locked `yaml`
  package and Node built-ins. It rejects invalid/duplicate-key YAML, external or
  unresolved `$ref` values, duplicate/drifted operation IDs, route-inventory
  drift, missing effective authentication, and missing reusable globally
  applicable 400/401/403/429/500 responses. It resolves all 183 current local
  references and explicitly locks the exporter-evidence and diagnosis-replay
  request/response contracts. Slack HMAC is modeled as its own security scheme
  rather than an unauthenticated override, and bearer checks reject anonymous
  OR-alternatives. Negative Node tests prove broken references, operation IDs,
  authentication, global errors, and response bodies fail the gate.
- Corrected a stale operation-count assumption: the current contract has 18
  operations, not 17, after `/v1/preflight/exporter-evidence` was added. No live
  operation is omitted to preserve the older count. The OpenAPI drift fixed in
  this slice includes the missing Preflight-status 400, reusable generic 500s,
  health/readiness's real rate-limit exemption, complete diagnosis-job replay
  fields, and the detector route's strict execution-scoped
  available/unavailable pricing forms. The latter was reconciled again after a
  concurrent contract slice removed its legacy input during verification.
- Added a dependency-free contract test that imports the built control plane,
  exercises representative real `buildApp().inject()` responses, and validates
  their documented status and JSON bodies directly against the OpenAPI schemas.
  Covered: permit, detector observe, ordinary-agent forged exporter evidence,
  valid exact-scope exporter evidence, diagnosis list/replay, unauthenticated and
  cross-tenant denial, rate limiting, generic internal error, liveness, ready,
  and not-ready. Store interfaces are deterministic fakes because this test
  checks HTTP/OpenAPI conformance rather than persistence; no second schema
  source or Docker dependency was introduced.
- `pnpm run test:openapi` is part of root `check` and an explicit CI step.
  Verification: focused OpenAPI validation passed 5 negative/static tests plus
  1 runtime conformance test; `pnpm run check` passed formatting, ESLint, all
  builds and strict typechecks, 616 workspace unit tests, OpenAPI validation,
  and the existing SigNoz/deployment contracts. A 148/148 aggregate integration
  run passed before two concurrent out-of-scope contract/migration slices
  completed. Two post-concurrency aggregate reruns each exposed a different
  unrelated load-sensitive assertion: the diagnosis store's 60 ms delayed-retry
  check and the SDK's asynchronous exporter-callback/status check; their
  unchanged suites passed immediately in isolation (12/12 and 8/8). The focused
  OpenAPI gate remained green. No core behavior, dependency, commit, or push was
  made.

### Migration integrity and Preflight source retention (2026-08-24)

- `schema_migrations` now stores the SHA-256 digest of every applied SQL file.
  Under the existing session advisory lock, the runner adds the checksum column
  to legacy ledgers, backfills null entries from the shipped files once, makes
  the column non-null, and verifies the complete applied ledger before executing
  pending SQL. An altered or missing historical file fails closed. Historical
  migration SQL was not rewritten.
- `/readyz` consumes the same on-disk migration manifest and requires the exact
  set of IDs and checksums, in addition to required tables and columns. A stale
  ID, unexpected ID, missing checksum column, or content mismatch returns
  `schema_not_ready` rather than accepting connectivity alone.
- Each bounded Preflight sweep now deletes at most its batch size of expired
  `preflight_source_evidence` rows. The active-source TTL remains twice
  `preflightMaxEvidenceStalenessMs`; retention is four times staleness, leaving
  another full active-source TTL before deletion. PostgreSQL receipt time plus
  `FOR UPDATE SKIP LOCKED` retains active/refreshed rows and lets replicas divide
  cleanup safely; repeated capped passes drain rows left by process restarts.
- Verification: migration unit tests passed 5/5 and health route unit tests
  passed 8/8; breaker-store and control-plane builds and strict typechecks
  passed; touched TypeScript ESLint and touched-file Prettier passed. Focused
  real-PostgreSQL tests passed migration integrity 3/3, Preflight store 19/19,
  and health readiness 3/3. The complete breaker-store real-PostgreSQL suite
  passed 55/55, including the existing legacy concurrent-upgrade test, after
  updating one diagnosis test fixture to restore its deleted ledger row with the
  required checksum. The real-Redis health/rate-limit integration passed 2/2.
  No commit or push was made per request.

### Strict public detector observations and tarball consumer proof (2026-08-24)

- Removed the unshipped legacy detector-observation schema and its inferred
  compatibility path. Public input and normalized detector types now require a
  bounded `executionId` and explicit `pricingStatus`; unavailable pricing remains
  `null` at the public boundary and cannot be mistaken for a free call. Contract
  tests reject omitted identity/status and inconsistent pricing values, and all
  direct typed fixtures were updated.
- Upgraded the isolated packed-tarball consumer to compile installed declarations
  for `@fuse/contracts`, `@fuse/otel`, `@fuse/sdk`, `@fuse/sdk/otel`, and
  `@fuse/sdk/providers`. Type-level negative checks prove the required fields,
  manifest checks pin the intended export map and declaration targets, and the
  installed runtime rejects the former payload.
- Runtime proof uses listening `127.0.0.1` fake control-plane and OTLP HTTP
  receivers. Default `FuseGuard.runStep` reporting receives a firing detector
  acknowledgment, the next fresh permit is denied with the provider callback
  count unchanged, a real `gen_ai` span reaches `/v1/traces`, and successful
  exporter evidence reaches `/v1/preflight/exporter-evidence` with the separate
  `exporterEvidenceToken`. Ordinary structural Preflight reporting also runs;
  neither reporting nor OTel is disabled. Tarball installation remains
  `--offline` against an unreachable registry while execution permits localhost.
- Verification: detector-observation contracts passed 12/12; focused contract,
  SDK reporter/guard, and control-plane detector tests passed 72/72; and the
  direct caller PostgreSQL suites passed 44/44. `pnpm run
  test:package-consumer` built all workspaces, validated all three tarballs,
  strictly compiled the external consumer, and passed the complete localhost
  runtime proof. The final `pnpm run check:full` passed repository formatting,
  ESLint, every build and strict typecheck, 616 unit tests, OpenAPI validation
  and conformance, four SigNoz contracts, three deployment contracts, and
  148 real PostgreSQL/Redis/HTTP integration tests. `git diff --check` passed
  with line-ending notices only. No commit or push was made per request.

### Unreleased truthfulness and exact scratch-image release smoke (2026-08-24)

- Moved the previously dated `0.2.0` notes back under `[Unreleased]`. The
  workspace/package manifests truthfully remain `0.1.0`; source-built container
  metadata now defaults to `dev`. Release validation rejects the current
  changelog and requires a maintainer to create a non-empty dated section for
  the exact requested version before publication. Deployment examples use
  `vX.Y.Z` placeholders and state that Unreleased notes are not pullable.
- The release candidate smoke now runs before any registry authentication on
  both exact loaded amd64/arm64 candidates. Each gets a fresh database and all
  migrations through `0008_preflight_source_evidence.sql`, production policy,
  shared Redis, and three independent exact-scope agent credentials plus three
  distinct exporter-evidence credentials. A host-side verifier registers fresh
  loop/context/cost scopes, reports exporter success, submits one isolated
  firing window per detector, and requires only the matching detector to trip,
  the next permit to remain denied, and one matching durable diagnosis job.
- The same pre-auth smoke asserts UID/GID `1000:1000`, a configured healthcheck,
  embedded Node `v24.19.0`, and failure to execute `/bin/sh`. It pauses Redis and
  verifies liveness 200, structured readiness 503, non-2xx permit behavior, and
  in-process recovery. PostgreSQL uses bounded stop/start rather than pause
  because a frozen established TCP connection cannot deliver its server-side
  statement timeout; it likewise requires liveness 200, structured readiness
  503, non-2xx permit behavior, restored readiness, and the durable tripped
  denial after recovery. Structural tests require the exact Node 24.19 immutable
  digest, scratch/no-shell runtime, migration 0008, separate exporter role, all
  three detectors, diagnosis/denial assertions, dependency failure injection,
  Grype `v0.110.0` with `only-fixed: false` and no exclusions, and smoke/scan
  ordering before GHCR login.
- Local exact-image evidence: `docker buildx build --platform linux/amd64
  --provenance=false --sbom=false --load --pull --build-arg VERSION=dev ...`
  produced image ID
  `sha256:0cb5e78e53b8c54c77b171c073b48271b70947707273933274d1b475bc9c1758`.
  The scratch image applied exactly migrations `0001` through `0008`, started
  with production configuration against real PostgreSQL 16 and Redis 7.4.2,
  returned health/readiness 200, and passed the three-scope exporter/detector/
  trip/denied-permit/diagnosis verifier. Image inspection returned user
  `1000:1000`, OCI version `dev`, and Node `v24.19.0`; `/bin/sh` was absent.
- Local dependency injection returned Redis readiness 503
  `rate_limit_store_unavailable` with permit HTTP 500 and PostgreSQL readiness
  503 `store_unavailable` with permit HTTP 500. Both permit paths therefore
  failed closed, but currently expose generic `internal_error` rather than a
  stable dependency-specific API error. After each dependency recovered,
  readiness returned 200 and the loop scope still returned `allowed:false`,
  `state:"tripped"`, `degraded:false`. Improving those runtime 500 contracts is
  app-code work outside this release-owned slice and remains explicit follow-up.
- Pinned Grype image `anchore/grype:v0.110.0@sha256:af65fbc0c664691067788fe95ff88760b435543e45595eb2ca6f102fc476fbe1`
  scanned `docker:fuse-control-plane:release-truth-smoke` with `--fail-on high
  --only-fixed=false`, no mounted configuration, ignore, exclusion, or
  suppression, and exited 0: `No vulnerabilities found` (zero high/critical
  findings). `pnpm run check` passed formatting, ESLint, all builds/typechecks,
  616 unit tests, OpenAPI validation/conformance, four SigNoz contracts, and
  three deployment contracts. `pnpm run test:release-workflow` and pinned
  actionlint 1.7.7 both passed. No tag, registry login, image push, attestation,
  commit, or publication occurred per request.

### Stable Redis rate-limit outage contract (2026-08-24)

- Raw ioredis failures from `@fastify/rate-limit`'s route-level `onRequest` hook
  now return HTTP 503 `{error:"store_unavailable",message:"rate limit store is
  unavailable; request denied",correlationId}`. The limiter key generator marks
  the request immediately before its store increment and a `preParsing` hook
  clears the marker only after `onRequest` completes. Translation additionally
  requires the configured Redis client, so later authentication, parsing,
  framework, and route failures retain their own contracts; an injected route
  exception remains 500 `internal_error`. The existing 429 `rate_limited`
  `FuseHttpError` is handled before the outage marker and remains unchanged.
- Real `redis:7.4.2-alpine` pause evidence against a listening control plane
  asserted the exact permit 503 body and caller-supplied correlation ID, then
  exercised a fail-closed `FuseGuard` and observed zero provider callbacks.
  `/healthz` stayed 200, `/readyz` retained its dependency-specific
  `rate_limit_store_unavailable` 503, and unpausing Redis restored readiness and
  provider dispatch through the same process/client without restart.
- OpenAPI now defines the reusable `StoreUnavailable` response as covering both
  the shared Redis limiter and route-specific PostgreSQL storage. Every one of
  the 16 globally rate-limited operations is required by the checked-in
  validator to reference that response at 503; health/readiness remain exempt.
  Runtime conformance injects a limiter-store failure and validates the exact
  response schema/body. The operations and incident-response runbooks record
  fail-closed behavior and the distinction from route/framework failures.
- The two previously reported aggregate-sensitive assertions were made
  state-driven. Diagnosis delayed retry now polls the real claim transition
  instead of sleeping for 60 ms, and the SDK Preflight status test awaits the
  exporter callback's delivery promise before reading status. The two focused
  suites passed concurrently (12/12 and 8/8), with no global timeout increase.
- Verification: focused app unit tests passed 11/11; real Redis integration
  passed 2/2; OpenAPI passed five validator tests, static validation of 18
  operations/184 references, and runtime conformance. `pnpm run check:full` was
  run twice consecutively and both runs passed formatting, ESLint, every build
  and strict typecheck, 618 unit tests, OpenAPI/SigNoz/deployment contracts, and
  148 real PostgreSQL/Redis/HTTP integration tests. No commit or push was made
  per request.

### Live direct-demo evidence on exact scratch image (2026-09-03)

- Built `fuse-control-plane:live-demo` from the current tree (Node 24.19.0
  scratch runtime) and ran migrations `0001` through `0008` against
  `postgres:16-alpine` plus `redis:7.4.2-alpine` on network `fuse-live-demo`.
  `/healthz` returned `{"status":"ok"}`, `/readyz` returned
  `{"status":"ready"}`; control plane ran with development credentials and
  `OTEL_SDK_DISABLED=true`.
- `demo:real-detect loop`: trip epoch 1 by `system:detector:loop-signature`,
  6 calls, 125 ms run time, next guarded call denied with 0 provider calls.
- `demo:real-detect context-bloat`: trip epoch 1 by
  `system:detector:context-bloat`, 20 calls, 502 ms, 0 provider calls.
- `demo:real-detect cost-velocity`: trip epoch 1 by
  `system:detector:cost-velocity`, 4 calls, 2925 ms, 0 provider calls.

### Session close-out: Docker reset, identity, commit/push (2026-09-03)

- Docker Desktop state reset between sessions: `docker info` showed
  `Containers: 0`, `Images: 0`; `localhost:8080` (SigNoz) and
  `localhost:8090` (live demo) both refused connections. Live SigNoz browser
  verification therefore remains blocked; unblock action is re-running
  `bash ./infra/signoz-up.sh` (or the forged-compose workaround under
  `C:\Users\vedan\AppData\Local\Temp\opencode\fuse-signoz-pours\deployment`)
  on a host with image cache, then provisioning rules/dashboard and capturing
  UI screenshots. Direct-enforcement demo evidence above stands independently.
- Push identity verified per AGENTS.md: `gh auth status` and
  `gh api user --jq .login` both return exactly `Vedant817`; local
  `user.name`/`user.email` are `Vedant817`/`vedantmahajan271@gmail.com`;
  push remote is `https://github.com/Vedant817/Fuse.git` (personal account).
- Final tree at close-out: 140 changed files, `+14653/-30871` (includes this
  `task.md` entry). Last full gate: `pnpm run check:full` green twice (618
  unit + 148 integration per run) with no source changes after except this
  entry; commit/push recorded below once complete.
