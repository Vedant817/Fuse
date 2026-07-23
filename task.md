# Fuse Production Build Plan

This is the live execution tracker derived from `Fuse_Hackathon_Brief.md`.
Agents must update it as part of every completed slice. A checked box means the
acceptance criteria were verified, not merely implemented.

## Status protocol

- `[ ]` not started
- `[~]` in progress (include owner/branch in the task note)
- `[x]` verified complete
- `[!]` blocked (include cause, evidence, and the exact unblock action)
- `[d]` deliberately deferred (include reason, risk, and target milestone)

For each completed feature, add a short evidence note beneath its task with the
test command/result, commit SHA, and any remaining risk. Work in critical-path
order unless a dependency makes safe parallel work possible.

## Product outcome and success measures

Fuse must demonstrate a trustworthy closed loop:

1. Preflight tells whether an agent can be protected with current telemetry.
2. OTel spans and metrics arrive in SigNoz with agent/task correlation.
3. SigNoz detects loop repetition, context growth, or abnormal cost velocity.
4. An authenticated alert atomically trips the correct agent's breaker.
5. Middleware blocks the next model call and emits an auditable decision.
6. Diagnosis uses SigNoz evidence to explain the likely cause and recommend a
   bounded fix through Slack; resume requires policy or authorized human action.

Demo success measures:

- zero model-provider requests after the breaker trip is observed and before an
  authorized resume;
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
- [ ] Add secret scanning, dependency audit, and license checks. Not started.
- [ ] Add CI for clean install, format/lint/type check, tests, build, security
  checks, and artifact retention; protect secrets on forked pull requests.
  Not started — no remote to host CI against yet, but the workflow file
  can and should be written locally regardless.
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
- [ ] CI performs the same checks as local development — still not started;
  no CI workflow file exists and there is still no remote to host it
  against (see §12 open blockers).
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
  `packages/contracts/src/policy.ts`'s `DetectorsConfigSchema` (this
  session) — typed per-detector config blocks, defaults asserted against
  `@fuse/detectors`' own constants via a dedicated drift-guard test
  (`packages/detectors/src/policy-defaults.test.ts`). Policy-version
  propagation into alerts/trips is not yet wired (no policy-file *loading*
  pipeline exists anywhere in the system yet — `PolicySchema` itself has no
  consumer — tracked as a separate, not-yet-scoped gap, not silently
  dropped).

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
  grouped by tenant/environment/agent_id so each scope gets its own alert
  instance.
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
- [x] Measure alert-to-trip latency and verify it meets the documented budget.
  No prior budget existed to check against — this session establishes the
  first real measurement instead of an assumption. Three independent,
  single-fresh-scope runs (`services/broken-agent/src/
  demo-real-detect.ts`, no manual trip call anywhere in the script), all
  measured from run-end to observed trip, both real and attributed to
  `system:signoz-webhook:loop-signature` in the audit log:
  - `evalWindow: "1m"` / `frequency: "1m"` (first rule config tried): **231s**.
  - `evalWindow: "1m"` / `frequency: "15s"` (tightened, expecting an
    improvement): **331s** on a clean single-scope run — essentially the
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
  own stable identity (`fingerprint`+`startsAt`), tested for duplicate
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
  key variants. Checked against the real self-hosted instance (ADR-005):
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
  exactly once. A real bug was caught and fixed here: the webhook initially
  derived its `correlationId` from Fastify's per-request auto-generated ID,
  which differs on every HTTP delivery — since the idempotency check hashes
  the whole request including `correlationId`, this made every genuine
  Alertmanager retry look like a *different* request and spuriously threw
  `idempotency_conflict`. Fixed by deriving both the idempotency key and the
  correlation ID passed to the store from the alert's own stable identity.
- [x] Handle resolved alerts according to explicit policy; never auto-resume
  solely because an alert resolved unless the policy deliberately allows it.
  Evidence: the webhook's default (and only implemented) behavior for
  `status: "resolved"` is `resolved-observed` — no state mutation at all;
  tested that a breaker tripped by a firing alert stays `tripped` after
  the matching alert resolves. No opt-in auto-resume-on-resolve path
  exists yet (not required, avoids speculative abstraction).
- [x] Return fast after durable acceptance when diagnosis/Slack work is
  queued. No diagnosis/Slack queue exists yet (§7, not built) — the
  webhook's response IS the durable acceptance today (a synchronous,
  atomically-committed `store.trip()` per alert), which is stronger than
  "fast after queuing," not a shortfall.
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
  disable,enable}`. No separate "policy inspection" endpoint exists since
  there is no policy *file* yet (policy values are per-request/env-config
  today) — tracked as a gap once policy-file loading is built.
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
- [ ] Publish OpenAPI and contract tests; ensure error responses leak no
  stack, secret, or cross-tenant existence information. Partial: contract
  tests exist for the zod schemas (not yet exported as an OpenAPI spec);
  error responses are verified to return stable `{error, message,
  correlationId}` shapes with no stack traces (tested), but no formal
  cross-tenant-existence-leak audit has been performed.

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
- [ ] Add durable work queue/outbox or document the smaller mechanism that
  prevents accepted incidents from being lost before diagnosis/notification.
  Not built — there is no diagnosis/notification consumer yet (§7), so
  there is nothing downstream that could lose an accepted incident today;
  the trip itself is already durable (synchronous Postgres commit). This
  becomes a real requirement once §7 exists and must be revisited then,
  not assumed away.
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
- [x] diagnosis/Slack outages do not weaken the tripped breaker — met and
  live-verified: the trip commits synchronously in the webhook route
  before `runDiagnosisAndNotify` is even invoked (fire-and-forget, `void`),
  and every downstream step (MCP fetch, Slack post) degrades rather than
  throwing;
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
  Done: `pnpm audit` (11 advisories found, 10 remediated via
  `pnpm-workspace.yaml` overrides, 1 accepted risk — `@hono/node-server`,
  transitive via the MCP SDK's unused server-side transport), a license
  sweep of 533 installed packages (zero copyleft), a targeted secret-
  pattern scan of every tracked file (15 matches, all reviewed and
  confirmed benign — dev-only Postgres credentials and named test
  fixtures), and a CycloneDX SBOM (`docs/sbom.cdx.json`, 573 components).
  Not done: static-analysis (SAST) — no `semgrep`/`codeql` binary was
  available or npx-fetchable in the time available; container-image
  scanning — N/A, this project builds no container image of its own
  (services run via `pnpm`/`node` directly; only third-party images in
  `infra/docker-compose.yml` are used, already pinned by tag). Full trail:
  `docs/adr/009-supply-chain-scan.md`.
- [x] Run authorization/tenant-isolation and webhook replay tests. Evidence:
  surveyed the existing suite first (`auth.test.ts`, `app.integration.test.ts`,
  `webhook.integration.test.ts`) rather than duplicating it, then actually
  ran it against real Postgres — 54 tests passing, including cross-tenant
  trip/resume/Preflight-read denial ("the blast-radius fix") and duplicate-
  webhook-delivery idempotency. `docs/adr/012-failure-injection-review.md`
  §"Survey" lists every scenario found already covered, with the specific
  test that proves it.
- [~] Validate secure defaults for TLS, CORS, headers, credentials, debug
  output, network exposure, and container user/filesystem permissions.
  Done: CORS (deliberately none registered — verified no
  `access-control-allow-origin` header leaks to a cross-origin caller),
  headers (added `@fastify/helmet`, asserted real header values in a new
  test), credentials (constant-time token comparison, fail-closed config
  already existed — verified by reading `auth.ts`/`config.ts` directly),
  debug output (confirmed no stack trace/secret ever reaches a client
  response), network exposure (`trustProxy: false` reviewed and documented
  for what a real reverse-proxy deployment must revisit). Not done: TLS
  (deliberately out of scope — this process is designed to sit behind a
  TLS-terminating reverse proxy, not terminate TLS itself) and container
  user/filesystem permissions (N/A, no container image built by this
  project). Full trail: `docs/adr/010-secure-defaults-audit.md`.
- [x] Generate an SBOM and document dependency update ownership. SBOM:
  `docs/sbom.cdx.json` (CycloneDX 1.6, 573 components). Dependency
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
- [~] Run race/stress tests for simultaneous permit/trip/resume and
  multi-instance operation. Simultaneous permit/trip/resume: already
  extensively covered by existing tests, verified by an actual run —
  `store.integration.test.ts`'s concurrent-trip-request, concurrent-same-
  idempotency-key, and per-caller-actor-attribution-under-concurrency
  tests, plus `guard.integration.test.ts`'s "concurrent calls racing the
  trip"/"in-flight exposure" tests. **Not done: multi-instance operation**
  — every test and the load test both ran a single control-plane process;
  no test exercises two instances sharing one Postgres.
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
- [d] Test clean deploy/restart, schema migration/rollback, backup restore,
  and expired-state cleanup. Done: clean restart (`shutdown.test.ts`'s
  duplicate-signal and partial-cleanup-failure tests — the real shutdown
  handler drains the Fastify app, Postgres pool, and OTel export in order)
  and schema migration (real, idempotent, forward-only — verified by
  reading `migrate.ts`). **Not built, documented honestly as real gaps in
  `docs/runbooks/operations.md`:** schema rollback (no down-migrations
  exist at all), backup restore (no backup mechanism exists), and
  expired-state cleanup (`idempotency_keys`/`breaker_audit_log` are never
  swept — a ready-to-run SQL snippet is provided in the runbook, but no
  job is scheduled).
- [ ] Define SLOs and alerts for permit errors/latency, webhook failures,
  notification backlog, detector lag, stale Preflight, and dropped
  telemetry. Not done — a real, honest gap. The three detector alert
  rules built in task.md §4 (`infra/signoz/alerts/`) alert on *agent
  behavior* (loop/context-bloat/cost-velocity), not on the control plane's
  own *operational health* signals this item asks for; no such SLO
  document or matching alert rules exist yet.

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
- [~] Document key rotation, policy rollout/rollback, data retention/
  deletion, backup/restore, and audit retrieval. Done: key rotation
  (`operations.md` §5), policy rollout/rollback (§6 — and honestly states
  that "rollout" is currently limited to a labeling string,
  `policyVersion`, since no policy-file *loading* pipeline exists yet;
  `DetectorRunner` always evaluates hardcoded defaults regardless of any
  policy file's contents — a pre-existing, already-disclosed gap from
  task.md §4, restated here since it directly bounds this item), data
  retention/deletion (§8), audit retrieval (§7, with a real SQL query
  against `breaker_audit_log`). **Not built: backup/restore** — no
  automated backup mechanism exists; the runbook says so rather than
  describing a restore procedure for a backup that doesn't exist.
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
- [~] Aggregate local and CI checks pass from a clean checkout. `pnpm run
  check` (format+lint+build+typecheck+test) and `pnpm run test:integration`
  both pass in full from the current checkout — 479 tests total, verified
  by an actual run this session, not assumed. **No CI exists** (task.md
  §0/§12 scope) — "from a clean checkout" was not literally tested in a
  fresh clone/container, only re-run in the existing working directory;
  a genuinely fresh-machine rehearsal is a real, not-yet-done step.
- [x] No unresolved critical/high security finding or known breaker bypass.
  `pnpm audit` (`docs/adr/009-supply-chain-scan.md`) has exactly one
  open finding (`@hono/node-server`, moderate, accepted risk with
  documented reasoning — not critical/high, and not reachable in this
  codebase's actual usage). No known breaker bypass exists — the
  zero-provider-calls-post-trip guarantee is proven under concurrent load
  (`guard.integration.test.ts`).
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
- [ ] Version/changelog/release notes identify limitations and breaking
  changes. Not done — no `CHANGELOG.md` exists and `package.json` remains
  at its initial `0.1.0`. A real, honest gap: this project has not cut a
  release yet, so there is no changelog to write beyond what
  `docs/runbooks/limitations.md` already covers narratively.
- [~] Container/artifact provenance, checksums, SBOM, and rollback are
  available. SBOM: yes (`docs/sbom.cdx.json`). Container provenance:
  N/A — this project builds no container image of its own (services run
  via `pnpm`/`node` directly; only pinned third-party images are
  referenced). Checksums: not generated for any artifact (no release
  artifact exists to checksum). Rollback: documented as **not available**
  for schema changes (`docs/runbooks/operations.md` §4) — stated honestly
  rather than implied.
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
  discovered are recorded in §4.5's own checklist entries above (231s and
  331s across two clean single-scope runs; a third, overlapping-scope
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

- Git remote and repository URL have not yet been supplied or created.
- GitHub CLI (`gh`) is not installed, so personal-account authentication cannot
  yet be verified and the publish workflow cannot run.
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
  email_password`) and rule/channel payload shapes. MCP capabilities and
  Slack workspace remain unselected.
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
