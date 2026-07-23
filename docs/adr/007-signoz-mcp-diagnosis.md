# ADR-007: SigNoz MCP as the diagnosis evidence source (task.md §7.1)

- Status: accepted
- Date: 2026-07-23
- Deciders: Vedant817 (explicit choice, via delegated senior-engineer agent)

## Context

task.md §7.1 asks Fuse to use SigNoz MCP — not a bespoke REST client — as
"the diagnosis half" (Fuse_Hackathon_Brief.md's closed-loop diagram: "an
agent uses SigNoz MCP to pull the offending traces"). This is also one of
the six named "Best Use of SigNoz" surfaces judges score against, so a real
MCP integration (not a REST call that merely _could_ have gone through MCP)
matters for authenticity, not just function.

A real, official server exists —
[SigNoz/signoz-mcp-server](https://github.com/SigNoz/signoz-mcp-server) —
supporting self-hosted SigNoz (confirmed against its README, not assumed),
exposing 41 tools (verified live via `client.listTools()` against our own
running instance) covering traces/logs/metrics search+aggregation, alert
history, dashboards, and field-key/value discovery.

## Decision

### 1. Authentication: a scoped service account, not the admin session

SigNoz's API-key ("Personal Access Token") UI lives under **Settings →
Service Accounts** in this version (v0.133.0), not a literal "API Keys"
page. A dedicated service account (`fuse-diagnosis-mcp`) was created and
assigned the **`signoz-viewer`** managed role — read-only across
traces/logs/metrics/dashboards/alert-rules, no write/delete permissions —
rather than reusing the admin session token everywhere else in this repo
uses. This is a deliberate least-privilege choice: a compromised diagnosis
adapter can read incident evidence but cannot mutate alert rules, channels,
or dashboards.

Two non-obvious API facts, found only by testing the real endpoints (the
UI itself was unreliable to drive via automation for this flow — see the
"probably not worth automating" note below):

- Role assignment is `POST /api/v1/service_accounts/{id}/roles` with body
  `{"id": "<roleId>"}` — singular `id`, not `roleId`/`roleIds`/`ids` (all
  of which return a real, structured `invalid_valuer` 400, distinguishable
  from the SPA-fallback trap ADR-006 already documents).
- The resulting key authenticates via the `SIGNOZ-API-KEY` header (not
  `Authorization: Bearer`), per the signoz-mcp-server's own documented
  convention — confirmed by a real 403 (`authz_forbidden`, before the role
  was assigned) turning into a real 200 after assigning `signoz-viewer`.

The key itself is passed to the MCP server as `SIGNOZ_API_KEY` (server-side
env var, per the server's own config) — never handled by `packages/
diagnosis` directly, and never committed (`.env`-only, matching every other
credential in this repo).

### 2. Deployment: official Docker image, HTTP transport, opt-in profile

`infra/docker-compose.yml` adds a `signoz-mcp` service using
`signoz/signoz-mcp-server:v0.9.0` (pinned by tag, not `:latest`, per
AGENTS.md) under Compose profile `diagnosis` — it does **not** start with a
bare `docker compose up`, only `docker compose --profile diagnosis up`,
since most local dev/test work (including this repo's entire CI-equivalent
`pnpm run check`/`test:integration`) has no need for live SigNoz evidence
and `packages/diagnosis` has its own documented offline fallback (§3
below).

Configuration required real investigation, not the first guess: the
server's env vars are `SIGNOZ_URL`, `SIGNOZ_API_KEY`, `TRANSPORT_MODE`
(not `MCP_TRANSPORT`), `MCP_SERVER_HOST`/`MCP_SERVER_PORT` (not
`MCP_HOST`/`MCP_PORT`) — found by reading `internal/config/config.go` in
the pinned version's actual source after a first guess silently defaulted
to stdio mode instead of erroring. The image is distroless (no shell, no
`wget`/`curl` inside it), so no Compose-level `healthcheck` is possible;
`packages/diagnosis`'s own connection layer owns retry/availability
detection instead.

### 3. Client architecture: `@modelcontextprotocol/sdk` over Streamable HTTP

`packages/diagnosis` uses the official TypeScript SDK
(`@modelcontextprotocol/sdk@1.29.0`) with `StreamableHTTPClientTransport`
pointed at `http://localhost:8020/mcp` (configurable), calling
`signoz_search_traces` (and, where useful, `signoz_get_trace_details`)
scoped to an incident's tenant/environment/agent_id and a bounded time
window around the trip.

One filter-syntax fact only discoverable by calling the tool for real: a
`resource.fuse.agent_id = '...'` filter 400s with "key not found" —
`fuse.*` attributes on Fuse's own spans are span **attributes**, not
resource attributes (`fieldContext: "attribute"`, confirmed via
`signoz_get_field_keys`), so the correct filter prefix is
`attribute.fuse.agent_id`, not `resource.fuse.agent_id`. Guessing the wrong
prefix here would have silently returned zero evidence rather than an
obvious error in some cases — worth stating explicitly since it is exactly
the kind of thing that reads as "it demoed once, so it must be right"
without ever having produced a real query error to catch.

### 4. Bounded, redacted evidence — no raw prompt/tool content

`packages/diagnosis`'s evidence fetcher whitelists a fixed set of span
fields (trace ID, span ID, name, timestamp, duration, error flag, and the
server's own `webUrl` deep link back into the SigNoz UI) rather than
passing through the tool's raw response object — defensive against a
future span attribute carrying more than this repo's threat model assumes
today (`docs/threat-model.md` §5: no prompt/completion content is ever
emitted by this codebase's own instrumentation, but the adapter should not
_rely_ on that remaining true forever). Result count is capped (a handful
of traces, not "all matching spans since epoch"), and every call goes
through a bounded timeout + limited retry, never raw/unbounded.

### 5. Offline fallback is not optional

Per task.md §7's acceptance criteria ("diagnosis/Slack outages do not
weaken the tripped breaker"), the evidence fetch is never on the
enforcement path (the trip already committed before diagnosis ever runs)
and must degrade to a clearly-labeled "evidence unavailable" result rather
than throwing, when the MCP server is unreachable or SigNoz has no data
for the incident window yet.

## Consequences

- A live demo needs `docker compose --profile diagnosis up -d signoz-mcp`
  and a `SIGNOZ_API_KEY` in `.env` in addition to the already-documented
  control-plane/SigNoz bring-up — recorded in the README update alongside
  this slice.
- The `fuse-diagnosis-mcp` service account's key has no expiration (set at
  creation time, matching this repo's existing "fixed local-dev
  credentials" convention for `infra/signoz-up.sh`'s admin password) — a
  real production deployment would rotate this, tracked as a known
  local-dev-only shortcut, not silently assumed away.
- This ADR's exact env var names, role-assignment endpoint, and filter
  syntax are pinned to `signoz-mcp-server v0.9.0` against SigNoz `v0.133.0`
  and may need re-verification on a future upgrade of either.
