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
`npx` (`license-checker`, `@cyclonedx/cdxgen`), plus a small
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

**Follow-up fix (2026-07-23):** a compatible Hono 2.x override does exist.
The first patched path-traversal release (`2.0.5`) was itself affected by a
later WebSocket-handshake memory-leak advisory, so the final override is
`@hono/node-server@2.0.10`. Its peer range remains `hono@^4` and its engine
is Node >=20, both compatible with this repository. After install,
`pnpm why @hono/node-server` reports only `2.0.10`,
`pnpm audit --prod --audit-level low` reports
`No known vulnerabilities found`, and all diagnosis/MCP tests pass.

**Follow-up fix (2026-07-26):** a fresh supported-runtime audit found the new
high-severity GHSA-c96f-x56v-gq3h advisory in Fastify's transitive
`find-my-way@9.6.0` dependency (HTTP/2 denial of service). Added
`find-my-way@<=9.6.0: >=9.6.1` to the workspace overrides; the lockfile
resolved 9.7.0. After reinstall, `pnpm why find-my-way` reports only 9.7.0,
`pnpm audit --prod --audit-level low` reports
`No known vulnerabilities found`, and the 130 control-plane unit plus 49
real-Postgres integration tests pass.

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

### 4. SBOM — CycloneDX 1.6 via `@cyclonedx/cdxgen`

The original `@cyclonedx/cyclonedx-npm --ignore-npm-errors` approach shells
out to `npm ls` and emits thousands of false pnpm-tree errors. CI now uses
`@cyclonedx/cdxgen@12.8.1 --type js --required-only --fail-on-error
--no-install-deps --spec-version 1.6`, which understands the pnpm workspace
and fails instead of suppressing extractor errors. The generated artifact
is reparsed and required to have CycloneDX format/version plus a non-empty
component list. The locally verified run produced 43 required components
and 54 dependency graph entries.

## Consequences

- `pnpm-workspace.yaml` now carries four version overrides
  (`@hono/node-server@2.0.10`, `find-my-way@<=9.6.0`,
  `undici@<6.27.0`, `uuid@<11.1.1`) that must
  be revisited if
  `@testcontainers/postgresql` ever bumps its own `undici`/`uuid` floor past
  these pins (they would become redundant, not wrong).
- `.github/workflows/ci.yml` regenerates and retains the SBOM on every
  change; `docs/sbom.cdx.json` remains a point-in-time human-review snapshot.
- CI now builds the repository's immutable control-plane image and runs it
  non-root/read-only with capabilities dropped. A registry image scanner is
  still a required promotion gate in `docs/runbooks/deployment.md`; it is
  intentionally external because the checked-in workflow does not publish a
  digest.
