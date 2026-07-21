# ADR-003: Real LLM provider adapters — Groq and NVIDIA Build

- Status: accepted
- Date: 2026-07-21
- Deciders: Vedant817 (explicit choice, via delegated senior-engineer agent)

## Context

`packages/sdk`'s `FuseGuard` (ADR-002-adjacent, built in the breaker-first
slice) wraps an arbitrary `() => Promise<T>` dispatch function and is
already fully provider-neutral. task.md §2.2 additionally calls for "an
initial real provider adapter" so the breaker guarantee is demonstrated
against a faithful real HTTP boundary, not only the in-repo fake-provider
fixture. No provider API keys are available in this build environment, so
per CLAUDE.md's explicit guidance, the adapter is built and verified
against a faithful mock now, with a live-optional smoke test that runs
automatically the moment credentials are supplied.

## Decision

Build two named provider factories — `createGroqProvider` and
`createNvidiaBuildProvider` — both implemented on top of one shared
`OpenAiCompatibleProvider` class, because both target platforms expose an
OpenAI-compatible `POST /chat/completions` API:

- **Groq**: base URL `https://api.groq.com/openai/v1`, `Authorization:
Bearer $GROQ_API_KEY` (verified against Groq's current docs,
  `console.groq.com/docs/openai`, 2026-07-21).
- **NVIDIA Build (NIM)**: base URL `https://integrate.api.nvidia.com/v1`,
  `Authorization: Bearer $NVIDIA_API_KEY` (key format `nvapi-...`, verified
  against `docs.nvidia.com/nim`, 2026-07-21).

Neither factory hardcodes a default model name — model catalogs on both
platforms change frequently, and pinning one here risks silently
targeting a deprecated/renamed model months from now. Every call site must
pass `model` explicitly; the demo agent (task.md §3.1) will pin its own
tested model name in its own configuration, not in this shared adapter.

Provider SDK types stay entirely within `packages/sdk/src/providers/` and
are never imported by `packages/breaker-core` or `packages/breaker-store`,
preserving ADR-002's trust-boundary/layering decision.

## Verification without credentials

- Unit tests mock `fetch` directly (no network) to verify request shaping
  (URL, headers, body) and response parsing for both factories.
- An integration test runs a local, real HTTP server shaped like an
  OpenAI-compatible chat-completions endpoint (`packages/sdk/src/
providers/openai-compatible-mock.ts`) and exercises the full
  `FuseGuard.guard()` → provider adapter path exactly as the dispatch-
  counter proof did for the generic fake provider.
- Live-optional tests (`*.live.test.ts`) call the real Groq/NVIDIA
  endpoints and are skipped via `it.skipIf(!process.env.GROQ_API_KEY)` (and
  the NVIDIA equivalent) when no key is present — they require zero code
  changes to run once a key is exported in the environment.

## Alternatives considered

- **Anthropic or OpenAI directly**: the initially-assumed default before
  this decision; rejected in favor of the explicit choice of Groq +
  NVIDIA Build for this project.
- **A single hardcoded default model per provider**: rejected — see above;
  model name staleness is a real, recurring failure mode for fast-moving
  inference platforms and costs nothing to avoid by requiring an explicit
  `model` argument.

## Consequences

- Real-provider verification remains blocked until `GROQ_API_KEY` and/or
  `NVIDIA_API_KEY` are supplied; this is a documented, tracked gap
  (task.md §2.2, §12), not a silent shortcut.
- The demo/broken-agent fixture (task.md §3.1) will choose one of these
  two providers (or both) for its default non-mocked path and must apply
  its own hard safety ceilings (call/runtime/token/spend limits) on top of
  whichever adapter it uses — this ADR governs the adapter layer only, not
  the fixture's safety envelope.
