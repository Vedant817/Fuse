# ADR-004: Tenant-scoped bearer tokens

- Status: accepted; amended 2026-07-23 to cover grouped webhooks
- Date: 2026-07-21
- Deciders: Vedant817 (via delegated senior-engineer agent)

## Context

`docs/threat-model.md` (task.md §1.2), written against the system as
actually implemented, surfaced a genuine gap: control-plane bearer tokens
(`CONTROL_PLANE_API_TOKENS` / `_AGENT_API_TOKENS` / `_WEBHOOK_TOKENS`) are
flat, global roles with no tenant association. `services/control-plane/src/auth.ts`'s
`requireBearerAuth` only ever checked _role_ (operator vs. agent vs.
webhook), never _which tenant_ the request targets. Every mutating and
read endpoint (`/v1/breaker/*`, `/v1/permit`, `/v1/preflight/*`) reads
`scope.tenant` straight from the request body/query with no check that the
presenting token is associated with that tenant. Concretely: a single
leaked operator token could trip/resume/disable/enable **every** tenant's
breaker on the deployment, and a single leaked agent token could read or
report Preflight status for **any** tenant, not just the one it was issued
to. This is the single most consequential gap the threat-model exercise
found, and is fixed here rather than left open indefinitely.

## Decision

Bearer tokens may now optionally be bound to a single tenant. A token
config entry (`CONTROL_PLANE_API_TOKENS` etc., still a comma-separated
list) is either:

- a **plain token** (unchanged format) — normalizes to the wildcard tenant
  `'*'`, meaning "valid for every tenant," exactly reproducing today's
  behavior; or
- a **`tenant:token` pair** — valid only for requests targeting that
  specific tenant.

`requireBearerAuth` gained an optional third parameter, `extractTenant: (request) => string | undefined`. When a token matches the role check but is bound to a non-wildcard tenant, the request's own target tenant (read from
`request.body.scope.tenant` for POST bodies, `request.query.tenant` for
GET query params — `extractTenantFromRequest` in `auth.ts`) must equal the
token's tenant, or the request gets the same `403 unauthorized` used for a
role mismatch — a role-correct token is not sufficient if it was scoped to
a different tenant.

Wired into `/v1/scopes/*`, `/v1/permit`, `/v1/preflight/*`,
`/v1/detectors/*`, `/v1/breaker/*`, and `/v1/webhooks/*` in
`services/control-plane/src/app.ts`.

Chosen specifically so **every existing config, token, and test continues
to work completely unchanged**: a plain token (the only form that existed
before this ADR) is still accepted for any tenant. Tenant-scoping is
opt-in, verified in `services/control-plane/src/app.integration.test.ts`
("control-plane tenant-scoped tokens: closing the cross-tenant blast
radius" — proves a tenant-A token cannot trip/resume/read tenant B's scope,
and that a wildcard token still can act on any tenant).

## Amendment: grouped SigNoz webhooks

The original decision excluded `/v1/webhooks/*` because one Alertmanager
delivery may group several tenants. Adversarial review showed that silently
ignoring an explicitly tenant-scoped webhook token was more surprising and
dangerous than requiring the operator to choose a topology.

`extractTenantFromWebhookRequest` now returns a tenant only when every alert
in the grouped payload names the same tenant. A `tenant:token` webhook
credential therefore accepts a same-tenant batch and rejects missing,
wrong-tenant, or mixed-tenant batches with 403. A plain token retains the
wildcard behavior required by a deliberately shared multi-tenant SigNoz
channel. This preserves both supported topologies without treating a scoped
credential as unscoped.

This change does not authenticate the alert body itself. The residual
fresh-forgery limitation and its fail-safe-only impact remain documented in
`docs/threat-model.md`.

## Alternatives considered

- **Require every token to declare a tenant, no wildcard.** Rejected: this
  would be a breaking change to every existing config, `.env.example`, and
  the majority of this repo's integration tests (all written against a
  single demo tenant with plain tokens) for a hackathon-scale, currently
  single-tenant deployment. The chosen design gets the real capability
  (tokens _can_ be scoped, and are checked when they are) without forcing
  an unrelated, large-blast-radius migration in the same slice.
- **A JWT/claims-based token instead of a flat bearer string.** Would allow
  richer claims (tenant, role, expiry) in one signed artifact and enable
  real key rotation/expiry. Rejected for now as disproportionate to the
  current single-binary, env-var-configured deployment model; revisit if
  Fuse ever needs true multi-tenant SaaS-style token issuance.
- **Enforce tenant scoping at the store layer instead of the auth layer.**
  The store (`packages/breaker-store`) already filters every query by
  `tenant`/`environment`/`agent_id` — that was never the leak; the leak was
  that _any_ valid token could ask the store to touch _any_ tenant. Fixing
  it at the auth layer (before the store is even reached) is the correct
  layer for an authorization decision, and keeps `breaker-store` unaware of
  the token/role model entirely (ADR-002's boundary).

## Consequences

- `services/control-plane/src/config.ts` exports `ScopedToken` and
  `TokenConfigEntry` types and `normalizeToken(s)` helpers; any future code
  constructing a `ControlPlaneConfig` token list can use either a plain
  string or a `{ tenant, token }` record.
- Operators who want the stronger guarantee must actively migrate their
  `.env` to `tenant:token` pairs — this is documented in `.env.example` and
  `docs/threat-model.md`, but is not the default, so a fresh single-tenant
  deployment is not forced into an unfamiliar token format.
- `docs/threat-model.md` §4's risk-register entry for this gap is updated
  to reflect the fix and its opt-in nature, rather than removed outright —
  a wildcard-token deployment is still exactly as exposed as before, by
  informed choice, not by an unfixable limitation.
