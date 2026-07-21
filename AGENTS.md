# Fuse Agent Operating Manual

This file applies to the entire repository. Every agent, including delegated
subagents, must read this file, `Fuse_Hackathon_Brief.md`, and `task.md` before
changing code or project state.

## Mission and product promise

Build Fuse as production-grade, OTel-native infrastructure that detects the
trace shape of runaway AI agents, trips a circuit breaker before the next
expensive model call, explains the incident with SigNoz data, and refuses to
claim protection when required telemetry is missing.

The non-negotiable demo path is:

`Preflight -> Sense -> Detect -> Enforce before the next call -> Diagnose -> Recommend -> Resume`

The breaker is the product's critical path. A dashboard, alert, or diagnosis is
not a substitute for proving that a real model call was prevented.

## Main-agent role

The main agent acts as the senior software engineer and accountable integrator.
It owns architecture, task sequencing, interfaces, production readiness,
security, verification, and the final quality bar. It must:

- challenge unclear requirements and record consequential decisions;
- find gaps and failure modes before implementation, not only during review;
- keep changes small, reversible, tested, and observable;
- integrate and independently validate all delegated work;
- keep `task.md` accurate as the execution source of truth;
- favor the smallest production-worthy vertical slice over disconnected demos.

Do not conceal shortcuts. Demo-only behavior must be explicitly labeled and
must not be on the default production path.

## Required work cycle

Use this cycle for every feature, fix, or infrastructure change:

1. Read the relevant brief and `task.md` section; inspect the current tree and
   working-copy state.
2. Define the intended behavior, acceptance criteria, failure modes, and the
   smallest useful implementation slice.
3. Identify gaps across correctness, concurrency, security, privacy,
   observability, operability, cost, latency, UX, rollback, and demo impact.
4. Use subagents when independent research, implementation, testing, or review
   will materially improve speed or quality. Give each subagent a bounded task,
   explicit inputs/outputs, and non-overlapping file ownership. Never delegate
   final architectural responsibility or accept results without review.
5. Implement one cohesive slice. Avoid speculative abstraction and unrelated
   cleanup.
6. Add or update tests with the change. Include negative paths and boundary
   conditions, not only the happy path.
7. Run the narrow checks first, then all relevant quality gates.
8. Perform a post-implementation gap review. Resolve discovered P0/P1 gaps in
   the same slice; record legitimate deferred work in `task.md` with rationale.
9. Update `task.md`, relevant docs, configuration examples, and runbooks.
10. Commit the verified slice and push it immediately using the personal GitHub
    identity described below. Do not combine unrelated features or fixes.

If the tree already contains user changes, preserve them. Stage only files that
belong to the current slice. Never discard or rewrite another contributor's
work to make a commit clean.

## Git and GitHub identity: personal account only

All repository commits and pushes must use:

- GitHub account: `Vedant817`
- commit name: `Vedant817`
- commit email: `vedantmahajan271@gmail.com`

Use repository-local identity settings so the separate work account remains
untouched:

```bash
git config --local user.name "Vedant817"
git config --local user.email "vedantmahajan271@gmail.com"
git config --local --get user.name
git config --local --get user.email
```

Before the first push in any session:

1. Inspect `git status --short --branch`, the staged diff, the current branch,
   and `git remote -v`.
2. Verify the authenticated GitHub login is exactly `Vedant817` (for example,
   `gh auth status` and `gh api user --jq .login`).
3. Verify the push remote resolves to a repository owned by `Vedant817`. A
   custom personal SSH host alias is acceptable if this machine uses one.
4. If authentication, ownership, or remote selection is ambiguous, stop before
   pushing and ask the user. Never silently switch accounts, create a remote,
   or push through the work account.

Commit after each completed and verified feature, fix, migration, documentation
milestone, or other independently reviewable slice. Use Conventional Commits
such as `feat(breaker): enforce pre-call permit`, `fix(preflight): detect missing
token fields`, or `docs: add project operating plan`. Push each commit before
starting the next slice when the remote is available. Do not commit a known-red
state. Never rewrite published history unless the user explicitly authorizes it.

## Source-of-truth hierarchy

When instructions disagree, use this order:

1. explicit current user instruction;
2. this `AGENTS.md` and `CLAUDE.md`;
3. accepted architecture decision records;
4. `task.md` sequencing and acceptance criteria;
5. `Fuse_Hackathon_Brief.md` product intent;
6. existing implementation conventions.

Do not silently reinterpret the brief. Record any deliberate scope or product
change in `task.md` and an ADR when it affects architecture.

## Engineering boundaries

- Enforce at the pre-call boundary. A trip that only stops work after another
  LLM request is not correct.
- Make breaker transitions explicit, atomic, idempotent, and auditable. Define
  behavior for duplicate/out-of-order alerts and concurrent in-flight calls.
- Use deny-by-default authentication for control actions. Verify webhook
  signatures, protect resume/override operations, redact secrets and prompt
  content, and apply least privilege.
- Scope state and telemetry by tenant/environment/agent. Never allow one
  agent's alert to pause another agent accidentally.
- State and document fail-open/fail-closed behavior. Never imply guaranteed
  protection during control-plane or telemetry failure.
- Preflight protection status must be visible and honest: `protected`,
  `degraded`, `blind`, or `disabled`, with a reason and last verified time.
- Prefer standard OTel `gen_ai` attributes. Keep vendor-specific SigNoz logic
  behind adapters and pin/document tested versions.
- Treat policy parsing and alert payloads as untrusted input. Validate at every
  boundary and return stable, structured errors.
- Use UTC for stored timestamps, structured logs with correlation identifiers,
  health/readiness endpoints, bounded retries with jitter, timeouts, and
  graceful shutdown.
- Never commit credentials, tokens, real customer prompts, or personal data.
  Provide `.env.example` with placeholders and fail clearly when required
  configuration is absent.
- Dependencies must be justified, pinned through the lockfile, and checked for
  licensing and known critical vulnerabilities.

## Testing and evidence

Every feature needs proportionate evidence. The minimum production gates are:

- formatter, linter, type checker, and unit tests;
- contract tests for external payloads and adapters;
- integration tests for breaker state, storage, webhook, and middleware;
- end-to-end proof that the next LLM call is not placed after a trip;
- failure-injection tests for missing telemetry, duplicate alerts, unavailable
  state storage, Slack/MCP failures, and resume races;
- security checks for authentication, authorization, secret leakage, unsafe
  logs, and dependency risk;
- observable evidence: logs, metrics, traces, and an audit event for control
  decisions.

Do not mark a checkbox complete based only on code existing. Record the command
or reproducible evidence used to verify it in the relevant `task.md` notes.

## Definition of done

A task is done only when implementation and tests pass, acceptance criteria are
met, failure modes and security implications were reviewed, operational and
user documentation is current, observability is sufficient to debug it, the
post-change gap review is resolved or documented, `task.md` is updated, and the
slice is committed and pushed with the required personal identity.
