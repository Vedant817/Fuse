# ADR-009: Dependency, license, and secret scanning (task.md §9.1)

- Status: accepted
- Date: 2026-07-23
- Deciders: Vedant817 (explicit choice, via delegated senior-engineer agent)

## Context

task.md §9.1 asks for dependency vulnerability scanning, license compliance
checking, secret scanning, and an SBOM. None of the usual dedicated CLI
scanners were present on this machine (`gitleaks`, `trufflehog`, `syft`,
`osv-scanner` — all confirmed absent via `which`). Rather than skip this
section, each requirement was met with a tool that either ships with the
package manager already in use (`pnpm audit`) or is fetchable on demand via
`npx` (`license-checker`, `@cyclonedx/cyclonedx-npm`), plus a small
purpose-written script for secret scanning where no npx-fetchable
alternative existed.

## Decision

### 1. Dependency vulnerabilities — `pnpm audit`

Initial run (`pnpm audit --json`) found 11 advisories: 10 against `undici`
(5.29.0, moderate/high/low — decompression DoS, request smuggling, WebSocket
memory exhaustion, header injection, cookie handling) and `uuid` (buffer
bounds check), all `dev: true` and reachable only via
`@testcontainers/postgresql` (used exclusively by `*.integration.test.ts`,
never shipped) — plus one `dev: false` moderate finding in
`@hono/node-server` (path traversal in `serve-static` on Windows,
GHSA-frvp-7c67-39w9), transitive via `@modelcontextprotocol/sdk` in
`packages/diagnosis`.

**Fixed**: added `pnpm-workspace.yaml` `overrides` (pnpm 11 moved dependency
overrides out of `package.json`'s `pnpm` field, which is silently ignored
with only a warning — confirmed by watching for the
`"pnpm" field in package.json is no longer read` warning on install) pinning
`undici@<6.27.0` → `>=6.27.0` and `uuid@<11.1.1` → `>=11.1.1`. Verified
_after_ reinstall, not assumed: `pnpm audit` dropped from 11 advisories to 1;
`pnpm run typecheck`, `pnpm run build`, and `pnpm run test` (286 tests across
all 10 workspace packages) all still pass against the overridden versions.

**Accepted risk, not fixed**: `@hono/node-server`'s path-traversal advisory.
`packages/diagnosis/src/mcp-client.ts` imports only
`@modelcontextprotocol/sdk/client/index.js` and
`.../client/streamableHttp.js` (grepped directly, not assumed) — the
_client_ half of the SDK. `@hono/node-server` backs the SDK's _server_-side
HTTP transport, which this codebase never instantiates (Fuse only ever acts
as an MCP client, connecting outbound to a SigNoz-operated MCP server — see
ADR-007). The vulnerable code path (`serve-static`'s Windows
backslash-encoding bug) is consequently unreachable in this codebase, and
deployment is Linux-only. No compatible pinned-override version was
available without forcing an unrelated major-version bump of the whole SDK.
Tracked here rather than silently ignored.

### 2. License compliance — package.json license fields on disk, not `license-checker` alone

`npx license-checker --json --excludePrivatePackages` from the repo root
only surfaced 11 packages — pnpm's isolated `node_modules` layout (symlinks
into a content-addressed `.pnpm` store) means `license-checker`'s
`node_modules`-walk only sees the root workspace's own direct
`devDependencies`, not the full dependency graph. `pnpm licenses list --json`
(pnpm's own built-in equivalent) failed outright with
`ERR_PNPM_MISSING_PACKAGE_INDEX_FILE` even after a clean `pnpm install
--frozen-lockfile` (a known pnpm/store-index limitation, not something fixable
from this repo).

Fixed by reading `package.json` `license`/`licenses` fields directly off
every installed package under `node_modules/.pnpm/*/node_modules/**` — 533
unique installed package@version pairs (vs. 545 total dependency entries in
`pnpm audit`'s metadata; the gap is optional/platform-specific packages
never installed on this machine, not a scan miss). Result: **all permissive**
— MIT (370), Apache-2.0 (92), ISC (33), BSD-3-Clause (23), BSD-2-Clause (8),
BlueOak-1.0.0 (5), Unlicense (1), Python-2.0 (1). Zero copyleft
(GPL/AGPL/LGPL/MPL), zero `UNKNOWN`.

### 3. Secret scanning — targeted regex sweep, no gitleaks binary available

With no `gitleaks`/`trufflehog` binary installable in this environment, a
purpose-written Python scan (not committed — a one-off check, its patterns
are recorded here for repeatability) walked every `git ls-files`-tracked
file (202 files, excluding binary/lockfile/font/image extensions) for
high-confidence secret shapes: AWS access keys (`AKIA...`), Slack tokens
(`xox[baprs]-...`), GitHub tokens (`gh[pousr]_...`), Google API keys
(`AIza...`), Stripe live keys, PEM private-key blocks, JWT-shaped literals,
`user:pass@host` URLs, and generic
`(secret|password|token|api_key)\s*[:=]\s*"..."` assignments.

15 matches, all reviewed individually and confirmed benign:

- 7 are the documented local-dev Postgres credential `postgres://fuse:fuse@localhost`,
  matching `infra/docker-compose.yml`'s own dev-only `POSTGRES_PASSWORD=fuse`
  — not a production credential, not unique to this repo's exposure.
- 8 are test-fixture tokens in `*.test.ts`/`*.integration.test.ts` files,
  each named descriptively (`test-signing-secret`,
  `demo-threshold-integration-test-token-01234`,
  `sdk-integration-test-token-0123456789`, etc.) — sequential/placeholder
  values, not real credentials.

No real `.env` file, private key, or certificate is tracked (confirmed via
`git ls-files | grep -iE '\.env$|\.env\.|secret|credential|\.pem$|\.key$'` —
only `.env.example` matched).

### 4. SBOM — CycloneDX 1.6 via `@cyclonedx/cyclonedx-npm --ignore-npm-errors`

`npx @cyclonedx/cyclonedx-npm` shells out to `npm ls --all --json`
internally, which fails on pnpm's isolated `node_modules` tree (pnpm does
not flatten transitive dev-dependencies of dependencies into `node_modules`
the way npm does, so `npm ls` reports hundreds of "missing" peer/dev deps of
packages that were never meant to be installed standalone). `--package-lock-only`
does not help either — it looks for `package-lock.json`/`npm-shrinkwrap.json`,
neither of which exists in a pnpm workspace. Fixed with
`--ignore-npm-errors`, which tolerates `npm ls`'s non-fatal errors and still
walks the real `node_modules` tree. Output: `docs/sbom.cdx.json`,
CycloneDX 1.6, 573 components, each with resolved version, declared
license, and package URL (`purl`) — validated by re-parsing the output file
and checking `bomFormat`/`specVersion`/`components.length`, not just a
clean exit code.

## Consequences

- `pnpm-workspace.yaml` now carries two version overrides
  (`undici@<6.27.0`, `uuid@<11.1.1`) that must be revisited if
  `@testcontainers/postgresql` ever bumps its own `undici`/`uuid` floor past
  these pins (they would become redundant, not wrong).
- `docs/sbom.cdx.json` is a point-in-time snapshot, not regenerated in CI —
  no CI pipeline exists yet for this project (out of scope; task.md doesn't
  ask for one). Re-run
  `npx @cyclonedx/cyclonedx-npm --ignore-npm-errors --output-file docs/sbom.cdx.json --output-format json`
  after any dependency change to refresh it.
- The `@hono/node-server` advisory is a real, tracked, accepted risk — not
  silently dropped. If Fuse ever grows an MCP _server_ role (not just a
  client), this must be re-evaluated before that code path ships.
- Not built: a running SAST tool (no `semgrep`/`codeql` binary available or
  npx-fetchable in this environment within the time available) and
  container image scanning (this project builds no container image of its
  own — services run via `pnpm`/`node` directly; only third-party images
  referenced in `infra/docker-compose.yml` are pinned by tag, already
  reviewed) — both real, scoped-out gaps, tracked in task.md §9.1, not
  assumed complete.
