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
  URLs/auth verified against each platform's current docs). No credentials
  are available in this environment, so live verification against the real
  APIs remains blocked (tracked below and in §12); the adapter logic itself
  is fully built and tested against a faithful local mock
  (`openai-compatible-mock.ts`), and a live-optional test
  (`groq.live.test.ts`/`nvidia-build.live.test.ts`) is ready to run the
  moment `GROQ_API_KEY`/`NVIDIA_API_KEY` are exported — no code changes
  needed.
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
  Groq/NVIDIA call would use) through `FuseGuard` against the mock,
  proving the concrete adapter's request/auth/response handling — not just
  the generic dispatch-wrapper contract — respects the breaker. A live run
  against the real Groq/NVIDIA APIs remains blocked on credentials (see
  above); tracked as a deferred P1 in §12, target milestone: whenever
  `GROQ_API_KEY`/`NVIDIA_API_KEY` become available (the test is
  pre-written and gated to run automatically once they are).

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
  end-to-end against a real Postgres + real control-plane process (not
  just `app.inject()`) — output verified to be accurate and legible.
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

### 4.1 Detection framework

- [ ] Define a detector result contract containing detector/version, score,
  threshold, window, evidence references, scope, and deduplication key.
- [ ] Build deterministic fixture/replay tooling from synthetic, non-sensitive
  telemetry.
- [ ] Establish a normal baseline set and evaluate false positive/negative
  behavior before selecting defaults.
- [ ] Keep detector configuration in the versioned policy file and include the
  effective policy version in alerts/trips.

### 4.2 Loop-signature detector

- [ ] Canonicalize repeatable step/span shapes while excluding volatile IDs,
  timestamps, and token counts.
- [ ] Detect consecutive and short-cycle repeats, including Analyzer/Verifier
  ping-pong and retry/replan cycles.
- [ ] Require configurable minimum repetitions/window and distinguish expected
  bounded iteration from pathological progress-free repetition.
- [ ] Test noise, alternating cycles, legitimate loops, retries, missing spans,
  delayed spans, and high-volume cases.

### 4.3 Context-bloat detector

- [ ] Compute input-token growth over a scoped session/task window.
- [ ] Support absolute context ceiling, consecutive growth, slope/ratio, and
  minimum-call safeguards to prevent early noise.
- [ ] Handle model context-window changes, history compaction, cached tokens,
  late data, and session boundaries.
- [ ] Test linear growth, sudden jumps, stable large contexts, normal resets,
  and missing token attributes.

### 4.4 Cost-velocity detector

- [ ] Compute estimated spend per documented time window with low-traffic and
  incomplete-window safeguards.
- [ ] Implement a deterministic static threshold for the demo.
- [ ] Add an optional learned baseline with minimum history, robust outlier
  treatment, seasonality stance, and cold-start fallback.
- [ ] Test spikes, sustained burns, traffic growth, price-table changes, sparse
  workloads, delayed telemetry, and counter resets.

### 4.5 SigNoz rules and delivery

- [ ] Express each supported detector as a SigNoz query/derived metric and alert
  rule, documenting any preprocessing that cannot live in SigNoz.
- [ ] Configure evaluation interval, window, pending duration, recovery, labels,
  annotations, severity, and routing without embedding credentials.
- [ ] Include enough scoped identifiers and evidence in webhook payloads without
  sending sensitive prompt/tool content.
- [ ] Add rule-as-code/export artifacts and a repeatable install/update process.
- [ ] Test firing and recovery against each fixture plus duplicate, delayed, and
  out-of-order notification delivery.
- [ ] Measure alert-to-trip latency and verify it meets the documented budget.

Acceptance criteria:

- each detector catches its intended fixture and stays quiet for the agreed
  normal fixtures;
- SigNoz alerting, rather than an undisclosed parallel path, triggers the demo
  breaker;
- thresholds, windows, limitations, and policy version are inspectable.

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

### 7.1 SigNoz MCP adapter

- [ ] Verify the actual SigNoz MCP capabilities/version and record setup,
  authentication, least-privilege permissions, and query limitations.
- [ ] Implement an adapter that fetches only incident-scoped traces, metrics,
  logs, and relevant time bounds; cap result size and redact sensitive fields.
- [ ] Add timeouts, bounded retries, pagination, unavailable/partial-result
  handling, and mock contract fixtures.
- [ ] Protect diagnosis prompts from telemetry prompt injection by separating
  untrusted evidence, constraining tools/output, and never exposing control
  credentials.
- [ ] Preserve evidence links/IDs so claims can be checked in SigNoz.

### 7.2 Root cause and recommendation

- [ ] Implement a deterministic diagnosis summary from detector evidence before
  adding optional LLM wording.
- [ ] Generate hypothesis, supporting evidence, uncertainty/limitations,
  immediate containment, and targeted fix recommendations.
- [ ] Map loop -> cumulative ceiling/progress guard, context bloat -> history
  deduplication/compaction/caching, velocity -> workload/release/model-price
  investigation without presenting generic advice as certainty.
- [ ] Bound diagnosis model spend and place diagnosis calls behind their own
  separate safety budget so Fuse cannot become the runaway agent.
- [ ] Test incomplete/conflicting evidence, MCP outage, malicious telemetry,
  unsupported detector, and diagnosis budget exhaustion.

### 7.3 Slack incident workflow

- [ ] Define a compact incident card: state, scope, estimated spend/avoidance,
  reason, evidence, confidence, Preflight status, proposed fix, and authorized
  actions.
- [ ] Sign/verify interactive actions, prevent replay, enforce authorization,
  require a resume reason, and show resulting state or stale-action conflict.
- [ ] Deduplicate initial/update/recovery notifications and handle rate limits,
  retries, expired actions, and channel misconfiguration.
- [ ] Ensure Slack failure cannot affect enforcement and is visible to operators.
- [ ] Add a no-network local renderer/snapshot for reliable demo rehearsal.

### 7.4 Optional fix PR (P2)

- [ ] Restrict automated edits to a demo repository and explicit allowlist.
- [ ] Create a branch and draft PR only; never auto-merge or mutate protected
  branches.
- [ ] Include incident evidence, rationale, tests, limitations, and rollback.
- [ ] Make the demo succeed gracefully when repository credentials are absent.

Acceptance criteria:

- every diagnosis claim links to evidence or is labeled as a hypothesis;
- diagnosis/Slack outages do not weaken the tripped breaker;
- no interactive action bypasses control-plane authorization.

## 8. Agent cost-health dashboard (P1)

- [ ] Define dashboard variables for environment, tenant (if applicable), agent,
  model, task type, and time range with safe defaults.
- [ ] Add current breaker and Preflight protection status panels.
- [ ] Add spend and tokens by agent/user/task/model while respecting privacy and
  cardinality constraints.
- [ ] Add live cost velocity with policy threshold and detector annotations.
- [ ] Add input-token/context-growth and loop-repeat views.
- [ ] Add breaker trip/deny/resume history and alert-to-trip latency.
- [ ] Add projected monthly burn with explicit formula, minimum data requirement,
  confidence/limitations, and `estimated` labeling.
- [ ] Add instrumentation coverage, orphan rate, telemetry freshness/drop rate,
  and build regression views.
- [ ] Link panels to trace/log drill-down and the matching incident.
- [ ] Export/version the dashboard; test empty, partial, normal, runaway, and
  high-cardinality data plus common screen sizes.

Acceptance criteria:

- the live demo story is visible without manual query editing;
- empty or incomplete data is not rendered as zero/healthy;
- every number has a documented unit, source, and aggregation window.

## 9. Production hardening and operability (P1)

### 9.1 Security and supply chain

- [ ] Complete threat-model review and close all P0/P1 findings.
- [ ] Run secret, dependency, license, static-analysis, and container scans;
  remediate critical/high findings or record an explicit accepted risk.
- [ ] Run authorization/tenant-isolation and webhook replay tests.
- [ ] Validate secure defaults for TLS, CORS, headers, credentials, debug output,
  network exposure, and container user/filesystem permissions.
- [ ] Generate an SBOM and document dependency update ownership.

### 9.2 Reliability and performance

- [ ] Load-test permit and trip paths at target concurrency; report p50/p95/p99
  latency, throughput, saturation, and error rate.
- [ ] Run race/stress tests for simultaneous permit/trip/resume and multi-instance
  operation.
- [ ] Inject state-store, queue, SigNoz, MCP, Slack, DNS/network, and clock
  failures; verify declared behavior and recovery.
- [ ] Test clean deploy/restart, schema migration/rollback, backup restore, and
  expired-state cleanup.
- [ ] Define SLOs and alerts for permit errors/latency, webhook failures,
  notification backlog, detector lag, stale Preflight, and dropped telemetry.

### 9.3 Runbooks

- [ ] Document install/configure/upgrade/rollback/uninstall procedures.
- [ ] Document incident response for false positive, missed trip, stuck breaker,
  blind telemetry, state-store outage, leaked webhook secret, and Slack/MCP
  failure.
- [ ] Document key rotation, policy rollout/rollback, data retention/deletion,
  backup/restore, and audit retrieval.
- [ ] Add a limitations/non-guarantees section that matches actual tests.

Acceptance criteria:

- a fresh environment passes smoke tests from documented commands;
- operators can distinguish Fuse failure from agent failure and recover without
  editing the database manually;
- published guarantees are backed by repeatable tests and measurements.

## 10. Test matrix and release gates

### 10.1 Automated test suites

- [ ] Unit: breaker domain, policies, detector math, pricing, Preflight, redaction.
- [ ] Property/fuzz: state transitions, schema/parser boundaries, detector
  invariants, idempotency, and malformed webhook input.
- [ ] Contract: provider adapter, SigNoz webhook/query payloads, MCP, Slack,
  storage, policy schema, and OpenAPI.
- [ ] Integration: middleware/control plane/store/queue, OTel export, alert trip,
  diagnosis fallback, and interactive resume.
- [ ] End-to-end: normal agent, each runaway mode, blocked-next-call proof,
  telemetry regression/recovery, diagnosis, Slack, and authorized resume.
- [ ] Security: forged/replayed alerts, stale Slack action, role/scope isolation,
  secret/log leakage, prompt injection, oversized input, and abuse rate limits.
- [ ] Performance/reliability: concurrency races, load, restart, dependency
  outages, delayed/out-of-order telemetry, and recovery.

### 10.2 Release checklist

- [ ] All P0 tasks and agreed P1 tasks are complete with evidence.
- [ ] Aggregate local and CI checks pass from a clean checkout.
- [ ] No unresolved critical/high security finding or known breaker bypass.
- [ ] Dashboard/alert exports and configuration examples match tested versions.
- [ ] README quickstart and operator/developer docs pass a fresh-user rehearsal.
- [ ] Version/changelog/release notes identify limitations and breaking changes.
- [ ] Container/artifact provenance, checksums, SBOM, and rollback are available.
- [ ] Final commit is pushed using verified `Vedant817` authentication and the
  working tree is clean.

## 11. Demo, judging narrative, and submission

### 11.1 Repeatable two-beat demo

- [ ] Script/reset the environment and seed deterministic baseline/runaway data.
- [ ] Rehearse: start healthy -> launch loop -> show cost velocity -> SigNoz alert
  -> authenticated trip -> prove next provider call blocked -> show audit event
  -> receive evidence-backed Slack diagnosis -> authorized resume.
- [ ] Rehearse Preflight beat: intentionally remove required telemetry -> show
  `blind/degraded` and self-alert -> restore instrumentation -> show recovery.
- [ ] Display actual measured numbers; use simulated/estimated spend labels and
  avoid unsupported five-figure claims.
- [ ] Prepare offline-safe fallbacks (recorded telemetry, local Slack-card render,
  screenshots) without disguising them as live behavior.
- [ ] Time the primary story to two minutes and maintain a longer technical path
  for judge questions.

### 11.2 Documentation and evidence

- [ ] README: problem, architecture, SigNoz usage, quickstart, demo, policy,
  security, limitations, troubleshooting, and screenshots/GIF.
- [ ] Architecture diagram and control/data-flow sequence.
- [ ] Explain usage of SigNoz traces, metrics, logs, alerts, dashboards, and MCP
  as one closed loop.
- [ ] Publish detector formulas, thresholds, evaluation fixtures, false-positive
  tradeoffs, and cost-estimation caveats.
- [ ] Publish the breaker guarantee, in-flight-call limitation, outage behavior,
  and Preflight protection semantics in plain language.
- [ ] Produce and verify the two-minute video, repository/submission links, setup
  instructions, license, and attribution.

### 11.3 Final adversarial review

- [ ] Assign independent subagents/reviewers to attack correctness/races,
  security/privacy, observability claims, UX/demo clarity, and fresh-install
  reproducibility; give each a bounded checklist.
- [ ] Triage every finding by severity and resolve all demo-blocking and P0/P1
  issues; record deferred risks transparently.
- [ ] Run the demo repeatedly from a clean reset and once from a clean clone.
- [ ] Freeze the demo configuration, tag the release, and preserve known-good
  artifacts plus rollback instructions.

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
  initially-assumed Anthropic/OpenAI default. No credentials for either are
  available in this environment; the adapters are built and verified
  against a faithful local mock, with live-optional tests
  (`*.live.test.ts`) ready to run the moment `GROQ_API_KEY`/
  `NVIDIA_API_KEY` are exported — no code changes needed. See
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
  to date`), `pnpm run check` (format, lint, all 9 builds/typechecks, 256/256
  unit tests across 26 files), and `pnpm run test:integration` (83/83 tests
  across 10 files against Testcontainers Postgres). The first integration
  attempt after the clean build found that the local OrbStack daemon had
  stopped (`Could not find a working container runtime strategy`); after
  restarting OrbStack, the unchanged suite passed in full. Optional live
  provider tests were also executed and honestly skipped 2/2 because neither
  provider credential is present. **P3 (not fixed):** that failed-startup path
  also exposed a test-harness cleanup defect in both breaker-store integration
  suites: `afterAll` called `pool.end()` after `beforeAll` failed, producing a
  secondary `Cannot read properties of undefined (reading 'end')` error that
  obscures diagnostics. This does not affect application runtime or the
  container-available test path.

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
  §3.2 evidence above) though not a live end-to-end alert-fire proof.
  Still genuinely open: §4.5's SigNoz alert-rule-as-code installation, and
  the SigNoz UI's session-based auth API was not reverse-engineered (tried
  `/api/v1/login` and `/api/v2/sessions`, both fell through to the SPA
  route — only `/api/v1/register` was confirmed reachable), so no alert
  rule was actually created through it. MCP capabilities and Slack
  workspace remain unselected.
- No real LLM provider credentials (`GROQ_API_KEY`/`NVIDIA_API_KEY`) are
  available in this environment; the live-optional provider tests
  (`packages/sdk/src/providers/*.live.test.ts`) are written and will run
  automatically the moment either is supplied — no code changes needed.
  The complete mock path is built and verified in the meantime.
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
