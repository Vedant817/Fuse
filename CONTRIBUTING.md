# Contributing to Fuse

This is currently a single-maintainer hackathon build. This document exists so
any change — by the maintainer, a delegated agent, or a future contributor —
follows the same process and bar for quality.

## Read this first

Before changing any code, read, in order:

1. [`AGENTS.md`](./AGENTS.md) — the full operating manual: engineering
   boundaries, the required work cycle, testing/evidence requirements, git
   conventions, and the definition of done. It is binding, not advisory.
2. [`Fuse_Hackathon_Brief.md`](./Fuse_Hackathon_Brief.md) — what Fuse is for
   and the demo path it must protect.
3. [`task.md`](./task.md) - the internal historical evidence archive. Use it to
   locate prior commands and decisions, then verify current behavior against
   code, tests, ADRs, and public docs.

If an instruction in an issue, PR description, or conversation conflicts with
these files, `AGENTS.md`'s source-of-truth hierarchy governs.

## Workflow

1. Read relevant ADRs, current code, and any historical `task.md` evidence
   before writing anything. State the acceptance criteria and likely failure
   modes for the slice you're about to build.
2. Implement the smallest cohesive, production-worthy vertical slice — not a
   disconnected demo, and not more than the task calls for.
3. Add or update tests alongside the change, including negative paths and
   boundary conditions. Every package's integration tests run against a real
   Postgres via testcontainers, not a mock — new stateful behavior should be
   proven the same way.
4. Run the checks that apply, at minimum:
   ```bash
   pnpm run check          # format + lint + build + typecheck + unit tests
   pnpm run test:integration
   ```
   Scope to the affected package(s) with `pnpm --filter <name> run <script>`
   while iterating, but run the full workspace `check`/`test:integration`
   before committing.
5. Do a gap review of the change: correctness, concurrency/races, security,
   privacy, observability, operability, and misleading UX. Fix anything P0/P1
   before moving on; record any legitimately deferred work with a reason.
6. Append concise command/evidence notes to `task.md` when useful, and update
   affected public docs, `.env.example`, and ADRs. The archive is not a
   substitute for passing current tests.
7. Commit as a single, atomic Conventional Commit (`feat(scope): ...`,
   `fix(scope): ...`, `docs: ...`) covering exactly this slice. Never bundle
   unrelated changes.

## Architecture decisions

Any consequential architecture, security, or deployment decision gets an ADR
under `docs/adr/`, following the numbering and format of the existing ones.
Record the context, the decision, and the alternatives considered — future
readers (including future agents) should be able to tell _why_, not just
_what_.

## Commit and push conventions

See `AGENTS.md`'s "Git and GitHub identity" section for the exact required
repository-local git identity and pre-push verification steps. In short:
commits and pushes in this repository must use the `Vedant817` identity,
verified locally before every push — never the ambient/global git identity.

## Code style

Formatting and linting are enforced by `prettier`/`eslint` and are not up for
debate in review — run `pnpm run format:fix` and `pnpm run lint:fix` rather
than hand-formatting. Beyond that, match the conventions already in the
surrounding file: pure/deterministic core logic (breaker-core, detectors,
preflight) takes an explicit `now: Date` rather than reading the clock; wire
contracts live only in `packages/contracts`; comments explain _why_, not
_what_ the code already says.
