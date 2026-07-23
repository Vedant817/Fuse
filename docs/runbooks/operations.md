# Fuse operations runbook: install, configure, upgrade, rollback, retention

Status: living document, first written 2026-07-23 (task.md §9.3). Every
step below is the actual command this project's own scripts run — verified
by reading `infra/reset.sh`, `infra/signoz-*.sh`,
`packages/breaker-store/src/migrate.ts`, and `.env.example` directly, not
inferred. Where no automated mechanism exists (rollback, retention), that is
stated plainly rather than assumed away.

## 1. Install (fresh local environment)

1. `pnpm install` — installs the workspace. Node `>=24.0.0`, pnpm
   `>=11.0.0` (`package.json` `engines`).
2. Copy `.env.example` to `.env` and replace every `changeme-...` token with
   a real random value (`openssl rand -hex 32` or equivalent) — the control
   plane refuses to start with a missing `CONTROL_PLANE_API_TOKENS`/
   `DATABASE_URL` (`config.ts`'s `ConfigSchema`, no default for either), so
   a copy-pasted placeholder either fails closed at startup or, worse, is a
   guessable credential if left as-is. Never commit the real `.env`.
3. Bring up local infrastructure:
   ```bash
   docker compose -f infra/docker-compose.yml up -d postgres
   ```
   (add `signoz-mcp` too, via `--profile diagnosis`, only if you're
   exercising task.md §7's diagnosis path — it's optional and the control
   plane degrades to "evidence unavailable" without it, not an error.)
4. Apply migrations: `pnpm --filter @fuse/breaker-store run migrate`
   (`infra/reset.sh` does this for you as part of a full reset — see §4).
5. Start the control plane: `pnpm --filter @fuse/control-plane run dev`
   (or `run build && run start` for the compiled form). Confirm with
   `curl http://localhost:8090/healthz` (expects `{"status":"ok"}`) and
   `/readyz` (expects `{"status":"ready"}` once Postgres is reachable).
6. Self-hosted SigNoz (task.md §5, ADR-005) is a separate stack —
   `infra/signoz-up.sh` — needed for real telemetry/alerts/dashboards but
   not for the breaker's own permit/trip/resume logic, which works against
   Postgres alone.

## 2. Configure

Every runtime knob is an environment variable read by `config.ts`
(control-plane) or the SDK's own config loader — there is no separate
config file format, and every default is documented inline in
`.env.example`. The ones most likely to need tuning for a real deployment,
grounded in this session's actual measurements (not guesses):

- **`CONTROL_PLANE_RATE_LIMIT_MAX`/`_WINDOW_MS`** (default 120/60s, shared
  per bearer token across every route): `docs/adr/011-permit-load-test.md`
  found this exhausts almost immediately under any real load-test
  concurrency — size it above your agents' actual aggregate permit rate,
  or issue separate tokens per agent/tenant so they don't share one bucket.
- **`CONTROL_PLANE_DB_POOL_MAX`** (default 10): the same load test found
  this — not route logic — is the real throughput ceiling at higher
  concurrency (p99 latency roughly quadrupled from 23ms to 85ms between 50
  and 200 concurrent permit checks, with zero errors — it degrades by
  queueing). Raise it if you expect more than ~10 concurrent in-flight
  permit checks per control-plane instance.
- **`CONTROL_PLANE_STORE_OUTAGE_MODE`** / **`FUSE_SDK_OUTAGE_MODE`**: both
  default to `fail-closed` (deny on an unreachable store/control-plane).
  This is the safer default for cost protection but means a Postgres or
  control-plane outage also stops all guarded LLM calls — a deliberate
  tradeoff (see `docs/runbooks/incident-response.md`'s "Postgres (state
  store) outage" entry), not a bug.
- **Token roles** (`CONTROL_PLANE_API_TOKENS` / `_AGENT_API_TOKENS` /
  `_WEBHOOK_TOKENS`): least-privilege by construction (an agent token gets
  403, not a silent pass, on `/v1/breaker/*`) — see
  `docs/adr/004-tenant-scoped-tokens.md` for the `tenant:token` scoping
  form, recommended over a plain wildcard token for any multi-tenant
  deployment.

## 3. Upgrade

There is no versioned release process yet (no CI, no published packages —
task.md §0/§12 scope). Upgrading in place means: pull the new code,
`pnpm install`, `pnpm --filter @fuse/breaker-store run migrate` (safe to
re-run — see below), rebuild (`pnpm run build`), restart the control-plane
process. `createShutdownHandler` (`shutdown.ts`) drains the process on
SIGTERM/SIGINT — closes the Fastify app, the Postgres pool, and OTel export
in that order, idempotently on a duplicate signal (tested,
`shutdown.test.ts`) — so a plain process restart (not a hard kill) is
already graceful.

**Migrations are forward-only and idempotent**
(`packages/breaker-store/src/migrate.ts`): every `*.sql` file in
`packages/breaker-store/migrations/` is applied in filename order exactly
once, tracked in a `schema_migrations` table, each inside its own
transaction. Re-running `pnpm run migrate` after a partial or already-
complete run is safe — already-applied files are skipped.

## 4. Rollback

**Stated plainly: there is no scripted schema rollback.** The migration
runner has no "down" migrations — only forward `*.sql` files
(`0001_init.sql`, `0002_preflight.sql` today). Rolling back a bad schema
change today means either:

- Restoring Postgres from a backup taken before the migration ran (there is
  no automated backup job either — see §8), or
- Hand-writing and applying a reverse `*.sql` migration.

Rolling back the **application code** alone (no schema change involved) is
just redeploying the previous version — the schema is additive/backward-
compatible by construction so far (both existing migrations only add
tables/columns, never drop or rename), but this has not been stress-tested
against a real incompatible schema change and should not be assumed to
generalize.

`infra/reset.sh` is a **destructive full reset** for local dev only (drops
and recreates the entire `public` schema, then re-applies every migration
from scratch) — never run it against anything containing real state you
want to keep.

## 5. Key rotation

No online/graceful rotation exists — tokens are a flat env-var list read
once at process startup (`loadConfig()`), so rotating any of
`CONTROL_PLANE_API_TOKENS`/`_AGENT_API_TOKENS`/`_WEBHOOK_TOKENS` requires:

1. Add the new token alongside the old one (comma-separated) and restart —
   both are now valid, so in-flight agents/operators/SigNoz using the old
   token keep working during the transition.
2. Roll every caller over to the new token.
3. Remove the old token from the list and restart again to actually revoke
   it.

There is no way to revoke a single token without a restart, and no
per-token expiry — a leaked token is valid until manually removed from the
env var and the process restarted. This is a known, documented limitation
(`docs/threat-model.md` §9, risk #4), not an oversight.

## 6. Policy rollout/rollback

**Stated plainly, this is more limited than "policy rollout" implies.**
`packages/contracts/src/policy.ts`'s `DetectorsConfigSchema` (task.md §4)
defines what a versioned per-detector policy file _would_ look like, and
`packages/detectors/src/policy-defaults.test.ts` guards that its defaults
stay in sync with the detectors' own hardcoded constants — but there is no
policy-file _loading_ pipeline anywhere in the running system yet.
`DetectorRunner` (`services/control-plane/src/detector-runner.ts`) always
evaluates every scope against the hardcoded `DEFAULT_LOOP_SIGNATURE_CONFIG`/
`DEFAULT_CONTEXT_BLOAT_CONFIG`/`DEFAULT_COST_VELOCITY_CONFIG` constants,
regardless of any policy file's contents — this was already disclosed when
built (task.md §4's evidence: "Policy-version propagation into alerts/trips
is not yet wired — no policy-file loading pipeline exists anywhere in the
system yet"), not a new finding, but worth restating here since it directly
bounds what "rollout" can mean today.

What **does** exist and can be "rolled out" today: `policyVersion` is a
plain label (`CONTROL_PLANE_WEBHOOK_POLICY_VERSION`) stamped onto every
webhook-driven trip and stored in `breaker_audit_log` — changing it (env
var + restart) changes the label future trips carry, for audit/traceability
purposes, but changes no actual detector behavior. Rolling out a genuine
threshold change today means editing the `DEFAULT_*_CONFIG` constants in
`packages/detectors/src/*.ts` directly and redeploying — there is no
runtime reload, no A/B rollout, and no automated rollback beyond reverting
that code change.

## 7. Audit retrieval

Every breaker state transition (trip/resume/disable/enable, including
no-ops from a duplicate idempotency key) is a row in `breaker_audit_log`
(`packages/breaker-store/migrations/0001_init.sql`), indexed by
`(tenant, environment, agent_id, created_at DESC)`. To retrieve the history
for a specific incident:

```sql
SELECT created_at, from_state, to_state, actor_type, actor_id, reason,
       correlation_id, policy_version, noop
FROM breaker_audit_log
WHERE tenant = 'T' AND environment = 'E' AND agent_id = 'A'
ORDER BY created_at DESC
LIMIT 50;
```

`correlation_id` ties a row back to the triggering request (an alert's
`signoz:${fingerprint}:${startsAt}`, or whatever `correlationId` an operator
call supplied) — use it to cross-reference a specific Slack incident card
or webhook delivery with its exact resulting transition(s).

## 8. Retention

**Real, verified gap, not previously documented as a runbook item:**
neither `breaker_audit_log` nor `idempotency_keys`
(`packages/breaker-store/migrations/0001_init.sql`) has any automated
cleanup. `idempotency_keys` has an `expires_at` column and an index on it
(`idempotency_keys_expires_idx`) — but `expires_at` is only ever _read_ (to
decide whether a stored response snapshot is still valid,
`packages/breaker-store/src/store.ts`), never swept. Both tables grow
without bound as long as the deployment runs. For a real production
deployment, schedule a periodic job (cron, or a Postgres `pg_cron`
extension if available) running:

```sql
DELETE FROM idempotency_keys WHERE expires_at < now();
```

`breaker_audit_log` has no `expires_at` at all — it is the durable
compliance/forensic trail (every trip/resume/disable's actor, reason, and
correlation ID), so any retention policy for it is a business decision (how
long must "who tripped this and why" remain queryable), not a technical
default this runbook can set for you. Decide a retention window and add a
`DELETE ... WHERE created_at < now() - interval '...'` job once you have,
rather than leaving it unbounded indefinitely.

## 9. Uninstall

Stop the control-plane process (SIGTERM — see §3 for why that's already a
graceful drain), then tear down local infrastructure:

```bash
docker compose -f infra/docker-compose.yml down
```

This stops and removes the `fuse-postgres`/`fuse-signoz-mcp` containers but
**does not** delete `infra/data/postgres` (the bind-mounted volume in
`docker-compose.yml`) — the breaker/audit/Preflight state survives a
teardown by default, which is usually what you want. To also delete the
actual state (a genuine, irreversible uninstall — confirm you want this
before running it):

```bash
docker compose -f infra/docker-compose.yml down -v
rm -rf infra/data/postgres
```

There is no separate self-hosted-SigNoz teardown documented here — see
`infra/signoz-up.sh`'s own stack (ADR-005) for its lifecycle, since it is
optional infrastructure independent of the breaker/control-plane's own
state.
