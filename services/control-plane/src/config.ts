import { z } from 'zod';
import { OutageModeSchema } from '@fuse/contracts';

/** '*' means valid for every tenant — an explicit, deliberately-visible
 * escape hatch (also what a plain, unscoped token normalizes to), not the
 * recommended shape for a real multi-tenant deployment. See
 * docs/adr/004-tenant-scoped-tokens.md and docs/threat-model.md §4. */
export const ScopedTokenSchema = z.object({
  token: z.string().min(16),
  tenant: z.string().min(1),
});
export type ScopedToken = z.infer<typeof ScopedTokenSchema>;

/** A plain string is accepted for backward compatibility and normalizes to
 * `{ tenant: '*' }` (see `normalizeToken`) — every existing single-tenant
 * config/token continues to work unchanged; tenant scoping is opt-in. */
export const TokenConfigEntrySchema = z.union([z.string().min(16), ScopedTokenSchema]);
export type TokenConfigEntry = z.infer<typeof TokenConfigEntrySchema>;

export function normalizeToken(entry: TokenConfigEntry): ScopedToken {
  return typeof entry === 'string' ? { token: entry, tenant: '*' } : entry;
}

export function normalizeTokens(entries: readonly TokenConfigEntry[]): ScopedToken[] {
  return entries.map(normalizeToken);
}

const ConfigSchema = z.object({
  // SigNoz's Foundry stack publishes its UI on host port 8080. Keep the
  // control-plane default distinct so the documented all-local stack can
  // actually run both processes at once without hidden overrides.
  port: z.coerce.number().int().positive().default(8090),
  host: z.string().min(1).default('0.0.0.0'),
  logLevel: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  /** OTel resource attribute (`deployment.environment.name`) for this
   * control-plane process's own traces/metrics — distinct from a request's
   * per-scope `environment` (breaker-store/contracts `Scope`), which
   * identifies the AGENT's environment, not the control plane's own. */
  deploymentEnvironment: z.string().min(1).default('development'),
  databaseUrl: z.string().min(1),
  /** Postgres pool sizing/timeouts for the pool that gates every /v1/permit
   * check. Defaults below are byte-for-byte the hardcoded values
   * `@fuse/breaker-store`'s `createPool` falls back to on its own — set
   * here only to give operators an env-var override without editing source,
   * not to change default behavior. */
  dbPoolMax: z.number().int().positive().default(10),
  dbPoolIdleTimeoutMs: z.number().int().positive().default(30_000),
  dbPoolConnectionTimeoutMs: z.number().int().positive().default(2_000),
  dbStatementTimeoutMs: z.number().int().positive().default(5_000),
  /** Global authenticated/unauthenticated request limiter. The default is
   * retained for backward compatibility, but production agents can raise
   * it based on measured permit throughput instead of being hard-capped in
   * source at two calls/second per shared token. */
  rateLimitMax: z.number().int().positive().default(120),
  rateLimitWindowMs: z.number().int().positive().default(60_000),
  /** Behavior for the /permit fast path only, when the store cannot be
   * reached. Mutating endpoints (trip/resume/disable/enable) always fail
   * with 503 on store outage regardless of this setting — a control
   * mutation cannot be honestly "applied" if it cannot be persisted. */
  storeOutageMode: OutageModeSchema.default('fail-closed'),
  /** Operator tokens: full access, including the force-trip/resume/
   * disable/enable operational API. Comma-separated in
   * CONTROL_PLANE_API_TOKENS. Least-privilege boundary: only these tokens
   * may override a cooldown via a manual-actor resume, disable
   * enforcement, or force a trip — never an agent-scoped token. */
  apiTokens: z.array(TokenConfigEntrySchema).min(1),
  /** Agent tokens: permit-check only. Meant for the SDK embedded in a
   * customer/agent process — a lower-trust caller that must be able to ask
   * "am I allowed to make this call?" without also being able to resume,
   * disable, or force-trip any breaker. Comma-separated in
   * CONTROL_PLANE_AGENT_API_TOKENS; optional — if empty, only operator
   * tokens can call /v1/permit (still secure, just no separate role). */
  agentApiTokens: z.array(TokenConfigEntrySchema).default([]),
  /** Webhook tokens: SigNoz's alert-webhook channel only. SigNoz has no
   * HMAC-signing option (verified against its current docs — the channel
   * authenticates via HTTP Basic Auth, or a bearer token when the
   * configured username is left empty); a token scoped to only this route
   * means a leaked SigNoz webhook credential still cannot resume, disable,
   * or force-trip anything directly — it can only cause a *trip*, and only
   * for the scope named in the alert's own labels. Comma-separated in
   * CONTROL_PLANE_WEBHOOK_TOKENS. Webhook tokens are NOT tenant-scoped even
   * when given the `tenant:token` form — a single SigNoz instance may
   * legitimately watch multiple tenants, and the alert payload already
   * names its own scope; this is a separate, still-open hardening item
   * (docs/threat-model.md §3). */
  webhookTokens: z.array(TokenConfigEntrySchema).default([]),
  /** Server-controlled defaults applied to every trip the webhook causes.
   * Deliberately NOT read from the alert payload itself — an inbound
   * alert is untrusted input, and letting it dictate its own cooldown
   * would let a forged or misconfigured alert set an arbitrarily short
   * (or long) cooldown. */
  webhookDefaultPolicyVersion: z.string().min(1).default('signoz-webhook-v1'),
  webhookDefaultCooldownSeconds: z.number().int().nonnegative().default(300),
  /** Replay/staleness guard (docs/threat-model.md §3): an alert whose
   * `startsAt` is older than this is rejected per-alert (outcome
   * `stale-alert`) rather than causing a trip. This defends against a
   * captured HTTP request (or a stale re-queued delivery) being replayed
   * long after it stopped being relevant — it does NOT defend against an
   * attacker who holds a valid webhook token minting a brand-new,
   * currently-fresh forged alert, which remains a documented, accepted
   * limitation given SigNoz has no webhook payload-signing option. */
  webhookMaxAlertAgeMs: z.number().int().positive().default(600_000),
  /** Tolerance for `startsAt` claiming to be slightly in the future
   * (clock skew between SigNoz and the control plane) before it is
   * treated as suspicious/malformed rather than merely fresh. */
  webhookMaxClockSkewAheadMs: z.number().int().nonnegative().default(60_000),
  /** Preflight evaluator thresholds for the /v1/preflight/report route.
   * Defaults below are byte-for-byte `@fuse/preflight`'s own
   * `DEFAULT_PREFLIGHT_CONFIG` — set here only to give operators an
   * env-var override (e.g. a legitimately low-traffic/bursty agent needing
   * a wider freshness window) without editing source, not to change
   * default behavior. */
  preflightWindowMs: z
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  preflightBlindCoverageThreshold: z.number().min(0).max(1).default(0.5),
  preflightBlindOrphanRateThreshold: z.number().min(0).max(1).default(0.5),
  preflightBlindTokenMissingRateThreshold: z.number().min(0).max(1).default(0.3),
  preflightHeartbeatGraceMs: z
    .number()
    .int()
    .positive()
    .default(2 * 60_000),
  preflightMaxEvidenceStalenessMs: z
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  preflightMinRecoveryDwellMs: z.number().int().positive().default(60_000),
});
export type ControlPlaneConfig = z.infer<typeof ConfigSchema>;

/** Parses one comma-separated entry. `tenant:token` binds the token to that
 * tenant; a plain token (no colon, or an empty tenant/token part) is left as
 * a bare string and normalizes to the `'*'` (all-tenants) wildcard — see
 * `normalizeToken`. Splits on the FIRST colon only, so a token value itself
 * containing a colon is still handled (as long as no `tenant:` prefix was
 * intended, which is documented as the expected format in .env.example). */
function parseTokenEntry(raw: string): TokenConfigEntry {
  const separatorIndex = raw.indexOf(':');
  if (separatorIndex <= 0) return raw;
  const tenant = raw.slice(0, separatorIndex).trim();
  const token = raw.slice(separatorIndex + 1).trim();
  if (tenant.length === 0 || token.length === 0) return raw;
  return { tenant, token };
}

function parseTokenList(raw: string | undefined): TokenConfigEntry[] {
  return (raw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map(parseTokenEntry);
}

/** `.env.example`'s own placeholder token values (e.g.
 * `changeme-generate-a-strong-random-token`) are 39 characters long — long
 * enough to pass `TokenConfigEntrySchema`'s `min(16)` check, so a fresh
 * `cp .env.example .env` with no edits starts the control plane
 * successfully using a publicly-known string as a live bearer token,
 * rather than failing closed the way an empty/unset token list already
 * does (task.md §11.3 adversarial review — a real fresh-install gap, not
 * a hypothetical one). Every placeholder in `.env.example` starts with
 * `changeme`, so rejecting that literal prefix (case-insensitive) at
 * startup catches the actual copy-paste-without-editing mistake without
 * rejecting any real token an operator would plausibly choose. */
function assertNoPlaceholderTokens(
  envVarName: string,
  entries: readonly TokenConfigEntry[],
): void {
  for (const entry of entries) {
    const token = typeof entry === 'string' ? entry : entry.token;
    if (token.toLowerCase().startsWith('changeme')) {
      throw new Error(
        `${envVarName} still contains a placeholder value from .env.example ` +
          `("${token}") — generate a real random token (e.g. \`openssl rand -hex 32\`) ` +
          'and set it before starting the control plane.',
      );
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControlPlaneConfig {
  const apiTokens = parseTokenList(env['CONTROL_PLANE_API_TOKENS']);
  const agentApiTokens = parseTokenList(env['CONTROL_PLANE_AGENT_API_TOKENS']);
  const webhookTokens = parseTokenList(env['CONTROL_PLANE_WEBHOOK_TOKENS']);
  assertNoPlaceholderTokens('CONTROL_PLANE_API_TOKENS', apiTokens);
  assertNoPlaceholderTokens('CONTROL_PLANE_AGENT_API_TOKENS', agentApiTokens);
  assertNoPlaceholderTokens('CONTROL_PLANE_WEBHOOK_TOKENS', webhookTokens);

  const parsed = ConfigSchema.safeParse({
    port: env['CONTROL_PLANE_PORT'],
    host: env['CONTROL_PLANE_HOST'],
    logLevel: env['LOG_LEVEL'],
    deploymentEnvironment: env['CONTROL_PLANE_DEPLOYMENT_ENVIRONMENT'],
    databaseUrl: env['DATABASE_URL'],
    dbPoolMax: env['CONTROL_PLANE_DB_POOL_MAX']
      ? Number(env['CONTROL_PLANE_DB_POOL_MAX'])
      : undefined,
    dbPoolIdleTimeoutMs: env['CONTROL_PLANE_DB_POOL_IDLE_TIMEOUT_MS']
      ? Number(env['CONTROL_PLANE_DB_POOL_IDLE_TIMEOUT_MS'])
      : undefined,
    dbPoolConnectionTimeoutMs: env['CONTROL_PLANE_DB_POOL_CONNECTION_TIMEOUT_MS']
      ? Number(env['CONTROL_PLANE_DB_POOL_CONNECTION_TIMEOUT_MS'])
      : undefined,
    dbStatementTimeoutMs: env['CONTROL_PLANE_DB_STATEMENT_TIMEOUT_MS']
      ? Number(env['CONTROL_PLANE_DB_STATEMENT_TIMEOUT_MS'])
      : undefined,
    rateLimitMax: env['CONTROL_PLANE_RATE_LIMIT_MAX']
      ? Number(env['CONTROL_PLANE_RATE_LIMIT_MAX'])
      : undefined,
    rateLimitWindowMs: env['CONTROL_PLANE_RATE_LIMIT_WINDOW_MS']
      ? Number(env['CONTROL_PLANE_RATE_LIMIT_WINDOW_MS'])
      : undefined,
    storeOutageMode: env['CONTROL_PLANE_STORE_OUTAGE_MODE'],
    apiTokens,
    agentApiTokens,
    webhookTokens,
    webhookDefaultPolicyVersion: env['CONTROL_PLANE_WEBHOOK_POLICY_VERSION'],
    webhookDefaultCooldownSeconds: env['CONTROL_PLANE_WEBHOOK_COOLDOWN_SECONDS']
      ? Number(env['CONTROL_PLANE_WEBHOOK_COOLDOWN_SECONDS'])
      : undefined,
    webhookMaxAlertAgeMs: env['CONTROL_PLANE_WEBHOOK_MAX_ALERT_AGE_MS']
      ? Number(env['CONTROL_PLANE_WEBHOOK_MAX_ALERT_AGE_MS'])
      : undefined,
    webhookMaxClockSkewAheadMs: env['CONTROL_PLANE_WEBHOOK_MAX_CLOCK_SKEW_MS']
      ? Number(env['CONTROL_PLANE_WEBHOOK_MAX_CLOCK_SKEW_MS'])
      : undefined,
    preflightWindowMs: env['CONTROL_PLANE_PREFLIGHT_WINDOW_MS']
      ? Number(env['CONTROL_PLANE_PREFLIGHT_WINDOW_MS'])
      : undefined,
    preflightBlindCoverageThreshold: env[
      'CONTROL_PLANE_PREFLIGHT_BLIND_COVERAGE_THRESHOLD'
    ]
      ? Number(env['CONTROL_PLANE_PREFLIGHT_BLIND_COVERAGE_THRESHOLD'])
      : undefined,
    preflightBlindOrphanRateThreshold: env[
      'CONTROL_PLANE_PREFLIGHT_BLIND_ORPHAN_RATE_THRESHOLD'
    ]
      ? Number(env['CONTROL_PLANE_PREFLIGHT_BLIND_ORPHAN_RATE_THRESHOLD'])
      : undefined,
    preflightBlindTokenMissingRateThreshold: env[
      'CONTROL_PLANE_PREFLIGHT_BLIND_TOKEN_MISSING_RATE_THRESHOLD'
    ]
      ? Number(env['CONTROL_PLANE_PREFLIGHT_BLIND_TOKEN_MISSING_RATE_THRESHOLD'])
      : undefined,
    preflightHeartbeatGraceMs: env['CONTROL_PLANE_PREFLIGHT_HEARTBEAT_GRACE_MS']
      ? Number(env['CONTROL_PLANE_PREFLIGHT_HEARTBEAT_GRACE_MS'])
      : undefined,
    preflightMaxEvidenceStalenessMs: env[
      'CONTROL_PLANE_PREFLIGHT_MAX_EVIDENCE_STALENESS_MS'
    ]
      ? Number(env['CONTROL_PLANE_PREFLIGHT_MAX_EVIDENCE_STALENESS_MS'])
      : undefined,
    preflightMinRecoveryDwellMs: env['CONTROL_PLANE_PREFLIGHT_MIN_RECOVERY_DWELL_MS']
      ? Number(env['CONTROL_PLANE_PREFLIGHT_MIN_RECOVERY_DWELL_MS'])
      : undefined,
  });
  if (!parsed.success) {
    throw new Error(`invalid control-plane configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
