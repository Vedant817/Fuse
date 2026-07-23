# ADR-010: Secure-defaults audit (task.md §9.1)

- Status: accepted
- Date: 2026-07-23
- Deciders: Vedant817 (explicit choice, via delegated senior-engineer agent)

## Context

task.md §9.1 asks for a secure-defaults review: CORS, security headers,
credential handling, debug/stack-trace leakage, and network exposure. This
audit read `services/control-plane/src/{app,server,config,auth}.ts` and the
route files directly (not assumed from memory of earlier sessions), then
fixed the one real gap found and added a regression test proving each
claim, rather than asserting it from a code read alone.

## Findings

### Already correct (verified by reading source, not assumed)

- **CORS**: no `@fastify/cors` (or any manual `Access-Control-*` header) is
  registered anywhere. Fastify sets no CORS headers unless a plugin adds
  them, so a browser's same-origin policy already blocks any cross-origin
  page from reading a response — deny-by-default, not an oversight. Proven
  by `app.test.ts`'s `Origin: https://evil.example` test: no
  `access-control-allow-origin` header appears.
- **Auth**: `auth.ts` uses SHA-256 digest + `timingSafeEqual` (constant-time,
  no short-circuit) for token comparison, distinguishes 401
  (unauthenticated) from 403 (valid-but-wrong-role/-tenant), and error
  responses never echo the submitted token — proven by `app.test.ts`'s
  "never echoes the Authorization header value" test.
- **Config fails closed**: `apiTokens` (`z.array(...).min(1)`) and
  `databaseUrl` (`z.string().min(1)`) have no default — `loadConfig()`
  throws at startup if either is unset, rather than silently running with
  an empty/wildcard credential set.
- **No secret logging**: grepped every `request.headers` and `app.log.*`
  call site in `services/control-plane/src` — only named, non-sensitive
  headers (`x-correlation-id`, `x-slack-signature`,
  `x-slack-request-timestamp`) are ever read individually; nothing logs the
  full `request.headers` object (which would include `authorization`).
  Fastify's own default request/response log serializers don't include
  headers or bodies either.
- **No stack-trace/internal-error leakage**: `app.ts`'s `setErrorHandler`
  sends a generic `internal error` (no message, no stack) for any
  non-`FuseHttpError`, non-4xx failure; only genuine 4xx framework errors
  (oversized body, malformed JSON) surface their own message, which
  describes the violated schema, not any submitted secret value. Health
  routes (`/healthz`, `/readyz`) return only a status string and a fixed
  `store_unavailable` reason — the actual Postgres error is logged
  server-side (`app.log.warn`), never sent to the client.

### Fixed

- **No security-headers plugin existed.** Added `@fastify/helmet` (default
  config) to `app.ts`, registered before rate-limiting. For a JSON-only API
  the main value is defense-in-depth (`X-Content-Type-Options: nosniff`,
  `X-Frame-Options`, `X-DNS-Prefetch-Control: off`, etc.) against a caller
  ever rendering a response in a browser context — there is no HTML/inline
  script for a CSP to break, so helmet's defaults are safe to take as-is.
  Verified live (not just "the plugin is registered"): `app.test.ts` asserts
  the actual header values on a real injected response.

## Consequences

- `services/control-plane/src/app.test.ts` (new) is the first non-integration
  test of `buildApp()` itself — every prior full-app test went through
  `app.integration.test.ts` (real Postgres via testcontainers). This one
  uses fake `pool`/`store`/`preflightStore` objects and only exercises
  `/healthz` and the auth preHandler, both of which never touch them —
  deliberately narrow, not a replacement for the integration suite.
- `trustProxy: false` remains unchanged (already correct for the documented
  all-local topology) but is now called out in code comments as something a
  real reverse-proxy deployment must revisit — tracked as a runbook item
  (task.md §9.3), not silently left implicit.
- Not built: TLS termination (deliberately out of scope — this process is
  designed to sit behind a reverse proxy/ingress that terminates TLS, per
  the existing all-local dev topology; task.md does not ask this service to
  terminate TLS itself) and a CSP tuned for an eventual browser-facing
  surface (none exists yet — Fuse has no dashboard/UI of its own beyond the
  provisioned SigNoz dashboard, which SigNoz itself serves).
