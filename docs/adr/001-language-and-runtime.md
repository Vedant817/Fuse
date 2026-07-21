# ADR-001: Language, runtime, and package management

- Status: accepted
- Date: 2026-07-21
- Deciders: Vedant817 (via delegated senior-engineer agent)

## Context

Fuse needs OTel-native instrumentation, a low-latency pre-call breaker
middleware embeddable in agent code, an HTTP control plane (webhook +
operational API), detector/Preflight services, and a demo agent — all inside
one 5-day hackathon build that must also hold up as production-quality
infrastructure. The chosen stack must have first-class OpenTelemetry SDK
support (`gen_ai` semantic conventions), mature HTTP/webhook frameworks,
strong typing for versioned contracts, fast iteration speed, and easy local
reproducibility (Docker Compose alongside SigNoz).

Available on the build machine: Node.js v24.14.0, npm 11, pnpm 11.6.0, Python
3.14.6, Docker 29 with Compose v5. No Go toolchain. No `gh` CLI.

## Decision

Use **TypeScript on Node.js** (pinned `engines.node >= 24.0.0`, matching the
installed v24 line, which is Active LTS as of this build) across the entire
repository, organized as a single **pnpm workspaces** monorepo (pnpm 11.x,
lockfile committed).

Rationale:

- **OTel maturity**: `@opentelemetry/sdk-node` and the JS `gen_ai` semantic
  conventions are actively maintained and are what most real agent stacks
  (LangChain.js, Vercel AI SDK, raw provider SDKs) already emit against —
  directly reusable for the broken-agent fixture's authenticity requirement.
- **One language across every boundary** (contracts, domain logic, HTTP
  services, SDK/middleware, demo agent) removes cross-language contract drift
  risk under hackathon time pressure — the versioned contracts package (zod
  schemas + inferred types) is shared by import, not by regenerating clients.
- **pnpm workspaces** give strict, fast, disk-efficient dependency isolation
  between packages/services without needing a heavier build system (Nx,
  Turborepo) that the project doesn't yet have scale to justify.
- **Fastify** (chosen over Express) for HTTP services: built-in JSON schema
  validation hooks, lower overhead, first-class TypeScript types, better
  default handling of request size limits — relevant for a webhook boundary
  that must reject oversized/malformed input safely.
- **Vitest** for unit/integration/property tests: fast, native ESM/TS support,
  compatible with `fast-check` for property-based tests of breaker state
  transitions.

## Alternatives considered

- **Python**: Excellent OTel and LLM-agent ecosystem (most reference agent
  frameworks are Python-first), but splitting the control plane/middleware
  (naturally a long-running typed HTTP service) from the demo agent into two
  languages doubles contract-maintenance risk in a 5-day build. Rejected for
  this project's timeline; may be revisited if a Python-only consumer needs a
  native SDK later (would become an additional adapter, not a rewrite).
- **Go**: Strong fit for a control plane (concurrency, static binaries,
  predictable performance) but not installed on this machine, weaker
  ecosystem maturity for `gen_ai` OTel conventions today, and would still
  require a second language for the agent fixture. Rejected.
- **npm/yarn workspaces**: pnpm was already present and is strictly faster and
  more disk-efficient with equivalent workspace semantics; no reason to prefer
  npm/yarn.

## Consequences

- All packages/services share one `tsconfig` base, one lint/format
  configuration, and one root aggregate `check` command.
- A future non-Node consumer of the breaker (e.g., a Python agent) integrates
  via the HTTP permit API and the versioned OpenAPI contract, not a shared
  native SDK — this is already the intended production topology, so it is not
  a new limitation.
- Node/pnpm versions are pinned in `package.json` (`engines`) and via
  `packageManager`; CI must fail if these drift from the lockfile.
