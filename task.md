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
- [ ] Connect a remote owned by `Vedant817`, verify personal-account
  authentication, push the initial branch, and record repository URL here.
- [ ] Decide protected default branch and short-lived branch strategy; document
  whether hackathon speed permits direct pushes or requires reviewed PRs.
- [ ] Add issue/PR templates that require acceptance criteria, verification,
  risk, screenshots/telemetry evidence, and rollback notes.

### 0.2 Project structure and tooling

- [ ] Write ADR-001 selecting the language/runtime and justify it for OTel,
  middleware portability, SigNoz integration, and demo speed.
- [ ] Write ADR-002 for the system boundaries and state-store choice.
- [ ] Scaffold the chosen workspace with clear boundaries for:
  - breaker middleware/SDK;
  - control plane and alert webhook;
  - detectors and policy engine;
  - Preflight service;
  - broken demo agent;
  - diagnosis/notification worker;
  - shared contracts and OTel instrumentation;
  - SigNoz dashboards, alerts, and local infrastructure.
- [ ] Pin runtime and package-manager versions and commit the lockfile.
- [ ] Add formatter, linter, strict type checking, unit/integration test runners,
  coverage output, build command, and one aggregate `check` command.
- [ ] Add `.editorconfig`, `.gitignore`, `.env.example`, license, contribution
  guide, code owners, and a concise initial README.
- [ ] Add secret scanning, dependency audit, and license checks.
- [ ] Add CI for clean install, format/lint/type check, tests, build, security
  checks, and artifact retention; protect secrets on forked pull requests.
- [ ] Add reproducible local infrastructure with health checks and pinned image
  versions for SigNoz and the selected state dependencies.
- [ ] Add deterministic seed/reset scripts and document supported host
  prerequisites.

Acceptance criteria:

- a new contributor can clone, configure, start, test, reset, and stop the
  project from documented commands;
- CI performs the same checks as local development;
- no secret or machine-specific path is committed.

## 1. Architecture, threat model, and contracts

### 1.1 System design

- [ ] Draw the end-to-end sequence for Preflight, normal model-call permit,
  SigNoz alert, trip, blocked next call, diagnosis, Slack action, and resume.
- [ ] Define components, trust boundaries, data ownership, deploy topology, and
  supported single-node versus distributed behavior.
- [ ] Define stable identifiers for tenant, environment, agent, session, task,
  trace, alert, policy version, and breaker epoch.
- [ ] Define breaker states and transitions (at minimum protected/armed,
  tripped, disabled, and protection-degraded) with authorized actors and guards.
- [ ] Specify what happens to in-flight calls at trip time and state the exact
  guarantee for calls beginning after a committed trip.
- [ ] Choose and document state consistency, atomic transition mechanism,
  deduplication window, TTL/retention, and recovery after process restart.
- [ ] Decide explicit fail-open/fail-closed policy for SDK/control-plane/store
  outages and allow policy-level overrides with conspicuous status.
- [ ] Define delivery semantics for SigNoz alerts and Slack/MCP work; design all
  handlers for at-least-once delivery.
- [ ] Record capacity targets and budgets for permit-check latency, webhook
  latency, trip propagation, throughput, availability, and telemetry cost.

### 1.2 Threat and privacy model

- [ ] Inventory assets and attackers: control credentials, resume endpoint,
  policy mutation, tenant isolation, alert forgery/replay, malicious prompt/tool
  data, log injection, denial of service, and supply-chain risk.
- [ ] Define webhook authentication/signature verification, timestamp skew,
  replay prevention, key rotation, and least-privilege secret storage.
- [ ] Define human-action authorization and audit requirements for resume,
  disable, policy override, and force trip.
- [ ] Set prompt/tool payload collection defaults, redaction rules, retention,
  deletion, and demo-data constraints.
- [ ] Produce an abuse-case test list and map P0/P1 threats to mitigations.

### 1.3 Versioned contracts

- [ ] Define and validate the policy-file schema: scope, budgets, detectors,
  fail mode, cooldown, notification routes, and manual/policy resume rules.
- [ ] Define versioned alert-webhook input and normalized internal alert event.
- [ ] Define trip/permit/resume API requests, responses, idempotency keys,
  stable error codes, and compatibility rules.
- [ ] Define structured breaker audit event and required correlation fields.
- [ ] Define Preflight result and protection-state reason codes.
- [ ] Define diagnosis output with evidence references, confidence/limitations,
  recommended action, and safe fallback when MCP is unavailable.
- [ ] Add JSON/OpenAPI schemas, generated types where appropriate, fixtures,
  contract tests, and malformed-input/fuzz cases.

Acceptance criteria:

- the guarantee and non-guarantees can be explained without marketing ambiguity;
- every external boundary rejects invalid/oversized input safely;
- every state-changing request is scoped, authenticated, idempotent, and logged.

## 2. Breaker-first vertical slice (highest risk, P0)

### 2.1 Breaker core

- [ ] Implement the state model and policy evaluation as deterministic,
  side-effect-free domain logic.
- [ ] Implement atomic `trip`, `permit`, `resume`, `disable`, and status
  operations with tenant/environment/agent scoping.
- [ ] Make trip/resume idempotent and safe under duplicates, reordering,
  concurrent requests, stale breaker epochs, and restarts.
- [ ] Store who/what/why/when for every state transition and policy version.
- [ ] Implement cooldown and authorized manual/policy resume without accidental
  timer-based reopening.
- [ ] Add unit/property tests for every valid and invalid transition.

### 2.2 Pre-call middleware/SDK

- [ ] Define a provider-neutral model-call wrapper and an initial real provider
  adapter; keep provider SDK types out of the domain layer.
- [ ] Check a permit immediately before provider dispatch, after expensive local
  preparation where practical but before network bytes can be sent.
- [ ] Return a typed, actionable breaker error containing incident/correlation
  identifiers without leaking policy secrets.
- [ ] Emit permit/deny latency, decision, state, and correlation telemetry while
  controlling cardinality.
- [ ] Implement configured behavior for control-plane timeout/unavailability and
  expose that degraded protection state.
- [ ] Prove with a fake provider request counter that a tripped breaker results
  in zero provider calls; repeat under concurrency and trip/permit races.
- [ ] Run one controlled integration test against a real provider or a faithful
  HTTP test endpoint and preserve evidence for the demo.

### 2.3 Hardcoded trigger proof

- [ ] Add a temporary deterministic threshold trigger behind a clearly named
  demo/test policy, not the production default.
- [ ] Run an end-to-end slice: threshold -> atomic trip -> next pre-call denied ->
  structured audit event.
- [ ] Measure the maximum additional calls possible due to already in-flight
  work and present this honestly in docs/demo.
- [ ] Perform post-slice review for races, bypass routes, process restarts,
  state-store failure, and misleading status; fix P0/P1 findings.

Acceptance criteria:

- tests provide deterministic proof that the provider dispatch function is not
  invoked after the committed trip;
- all state changes are attributable and replay-safe;
- the configured outage behavior is tested and visible.

## 3. Deliberately broken agent and sensing (P0)

### 3.1 Authentic failure fixture

- [ ] Select and document an authentic Analyzer/Verifier-style workflow with a
  safe, bounded, provider-mocked default mode.
- [ ] Implement normal termination and three opt-in failure modes: repeating
  loop, growing conversation context, and abnormal call/cost velocity.
- [ ] Add hard demo safety ceilings for calls, runtime, tokens, and actual spend
  that cannot be disabled accidentally in a real-provider run.
- [ ] Make the fixture deterministic with seed, scenario, iteration delay, and
  reset controls.
- [ ] Add tests proving the normal workflow does not trip default policies and
  each broken scenario produces its intended telemetry shape.

### 3.2 OTel instrumentation

- [ ] Pin the tested OTel semantic-convention/version assumptions.
- [ ] Emit model/provider, operation, input/output/total tokens, estimated cost,
  agent/session/task, step index, parent chain, retry, and outcome attributes
  using standard `gen_ai` names where available and namespaced extensions where
  necessary.
- [ ] Preserve trace context across agents, tools, queues, and HTTP calls; test
  that there are no unexpected orphan step spans.
- [ ] Emit monotonic token/cost counters, request/error/denial counts, latency
  histograms, active-loop signals, and derived cost velocity with documented
  units and aggregation windows.
- [ ] Define a versioned price table with effective dates and model alias
  handling; label calculated cost as estimated and retain raw token counts.
- [ ] Emit structured breaker logs correlated to trace, alert, agent, task, and
  policy without prompt content or secrets by default.
- [ ] Apply resource attributes for service, version/build, deployment
  environment, and telemetry schema version.
- [ ] Add batching, timeouts, bounded queues, sampling policy, and a visible
  dropped-telemetry metric.

### 3.3 SigNoz ingestion proof

- [ ] Configure OTLP export through environment-driven secure endpoints.
- [ ] Verify traces, metrics, and logs arrive in the targeted SigNoz version and
  can be correlated for one demo run.
- [ ] Capture saved queries/screenshots or an automated smoke check as evidence.
- [ ] Validate representative cardinality and ingestion volume; remove
  high-cardinality dimensions from metrics where required.

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

- [ ] Implement strict content type/body size/schema validation.
- [ ] Verify signature/authentication, timestamp freshness, and replay nonce or
  idempotency key before any state change.
- [ ] Map external payloads to the normalized alert contract and reject unknown
  tenant/environment/agent scope.
- [ ] Make duplicate delivery return the original outcome and prevent duplicate
  incidents/notifications.
- [ ] Handle resolved alerts according to explicit policy; never auto-resume
  solely because an alert resolved unless the policy deliberately allows it.
- [ ] Return fast after durable acceptance when diagnosis/Slack work is queued.
- [ ] Rate-limit abusive sources and emit safe audit/operational telemetry for
  accepted and rejected requests.

### 5.2 Operational API

- [ ] Implement authenticated health, readiness, scoped status, force-trip,
  resume, disable/enable, and policy inspection endpoints.
- [ ] Enforce roles and tenant/environment boundaries for all control actions.
- [ ] Require reason and idempotency key for manual mutations; record actor,
  before/after state, and correlation IDs.
- [ ] Provide safe pagination/filtering for incident and audit views.
- [ ] Publish OpenAPI and contract tests; ensure error responses leak no stack,
  secret, or cross-tenant existence information.

### 5.3 Resilience

- [ ] Add health/readiness distinction, graceful shutdown, timeouts, bounded
  retry with jitter, circuit breaking for dependencies, and backpressure.
- [ ] Add durable work queue/outbox or document the smaller mechanism that
  prevents accepted incidents from being lost before diagnosis/notification.
- [ ] Test restart recovery, store/queue outage, partial write, clock skew,
  duplicate delivery, and multi-instance concurrency.
- [ ] Define backup/restore, migration, rollback, and retention procedures.

Acceptance criteria:

- forged, replayed, oversized, malformed, or cross-scope requests cannot trip
  or resume a breaker;
- webhook response and state transition remain correct under retries/restarts;
- core enforcement does not depend synchronously on Slack or MCP availability.

## 6. Preflight telemetry health (P0)

### 6.1 Coverage evaluator

- [ ] Define required versus optional fields for spans/metrics by instrumentation
  schema version: model, token counts, estimated cost inputs, scoped identity,
  parent propagation, and flow timestamps.
- [ ] Evaluate recent coverage percentage, freshness, orphan-span rate,
  cost/velocity flow, exporter drop signals, and build/version changes.
- [ ] Implement state/reason model for `protected`, `degraded`, `blind`, and
  `disabled`, including hysteresis to avoid flapping.
- [ ] Distinguish no traffic from broken telemetry using agent heartbeat or
  another documented signal.
- [ ] Store last-good and last-evaluated times and evidence references.
- [ ] Test missing fields, partial sampling, idle agents, orphan spans, delayed
  data, exporter outage, release regression, and recovery.

### 6.2 Protection semantics and self-alert

- [ ] Expose current Preflight state beside breaker state through API,
  dashboards, Slack, and middleware decision telemetry.
- [ ] Alert when protection degrades, including affected scope, missing signal,
  start time, last known good build, current build, and remediation link.
- [ ] Deduplicate and rate-limit blind-spot notifications; emit a recovery event.
- [ ] Apply/document policy for whether blind status fails open or closed and
  ensure UI wording never implies full protection.
- [ ] Reproduce the demo beat: remove a required token field or propagation,
  detect it, alert, restore it, and show recovery.

Acceptance criteria:

- Fuse never displays `protected` without current evidence;
- an instrumentation regression becomes visible within the declared window;
- idle/no-traffic is not falsely presented as healthy telemetry.

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

### Verification evidence

- 2026-07-21: Brief reviewed; governance/tracker files created; Git initialized
  on `main`; repository-local `user.name` and `user.email` verified as
  `Vedant817` and `vedantmahajan271@gmail.com`. Initial commit evidence is in
  repository history; remote-push evidence remains blocked.

### Open blockers and risks

- Git remote and repository URL have not yet been supplied or created.
- GitHub CLI (`gh`) is not installed, so personal-account authentication cannot
  yet be verified and the publish workflow cannot run.
- Actual SigNoz version, deployment target, MCP capabilities, LLM provider, and
  Slack workspace are not yet selected; these require explicit ADRs/configuration
  before integration assumptions are encoded in production paths.
