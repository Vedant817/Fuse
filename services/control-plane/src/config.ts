import { z } from 'zod';
import { OutageModeSchema } from '@fuse/contracts';

/** '*' means valid for every tenant — an explicit, deliberately-visible
 * escape hatch (also what a plain, unscoped token normalizes to), not the
 * recommended shape for a real multi-tenant deployment. See
 * docs/adr/004-tenant-scoped-tokens.md and docs/threat-model.md §4. */
const ScopedTokenSchema = z.object({
  token: z.string().min(16),
  tenant: z.string().min(1),
});
export type ScopedToken = z.infer<typeof ScopedTokenSchema>;

const AgentScopedTokenSchema = ScopedTokenSchema.extend({
  environment: z.string().min(1),
  agentId: z.string().min(1),
});
export type AgentScopedToken = z.infer<typeof AgentScopedTokenSchema>;

/** A plain string is accepted for backward compatibility and normalizes to
 * `{ tenant: '*' }` (see `normalizeToken`) — every existing single-tenant
 * config/token continues to work unchanged; tenant scoping is opt-in. */
const TokenConfigEntrySchema = z.union([z.string().min(16), ScopedTokenSchema]);
export type TokenConfigEntry = z.infer<typeof TokenConfigEntrySchema>;

// Strings and tenant-only records remain valid for programmatic development
// configs and legacy tenant:token env entries. Production validation below
// requires the complete AgentScopedToken shape with no wildcard selectors.
const AgentTokenConfigEntrySchema = z.union([
  z.string().min(16),
  AgentScopedTokenSchema,
  ScopedTokenSchema,
]);
export type AgentTokenConfigEntry = z.infer<typeof AgentTokenConfigEntrySchema>;
export type ExporterEvidenceTokenConfigEntry = AgentTokenConfigEntry;
export type NormalizedToken = ScopedToken | AgentScopedToken;

const MIN_PRODUCTION_TOKEN_BYTES = 32;

const RedisUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      const protocol = new URL(value).protocol;
      return protocol === 'redis:' || protocol === 'rediss:';
    },
    { message: 'must use the redis:// or rediss:// scheme' },
  );

export function normalizeToken(
  entry: TokenConfigEntry | AgentTokenConfigEntry,
): NormalizedToken {
  return typeof entry === 'string' ? { token: entry, tenant: '*' } : entry;
}

export function normalizeTokens(
  entries: readonly (TokenConfigEntry | AgentTokenConfigEntry)[],
): NormalizedToken[] {
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
  maxRegisteredScopesPerTenant: z.number().int().positive().default(10_000),
  /** Global authenticated/unauthenticated request limiter. The default is
   * retained for backward compatibility, but production agents can raise
   * it based on measured permit throughput instead of being hard-capped in
   * source at two calls/second per shared token. */
  rateLimitMax: z.number().int().positive().default(120),
  rateLimitWindowMs: z.number().int().positive().default(60_000),
  /** Shared store used by @fastify/rate-limit. Optional for local/test only;
   * production validation below rejects replica-local in-memory limiting. */
  rateLimitRedisUrl: RedisUrlSchema.optional(),
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
  /** Agent tokens: permit, Preflight, and detector access only. Meant for the SDK embedded in a
   * customer/agent process — a lower-trust caller that must be able to ask
   * "am I allowed to make this call?" without also being able to resume,
   * disable, or force-trip any breaker. Comma-separated in
   * CONTROL_PLANE_AGENT_API_TOKENS; optional — if empty, only operator
   * tokens can call these agent routes (still secure, just no separate role). */
  agentApiTokens: z.array(AgentTokenConfigEntrySchema).default([]),
  /** Exporter-evidence tokens can call only the Preflight exporter evidence
   * endpoint. Production requires at least one exact tenant/environment/agent
   * binding and rejects wildcard or partial entries. These credentials must be
   * held separately from ordinary agent/operator/webhook credentials. */
  exporterEvidenceTokens: z.array(AgentTokenConfigEntrySchema).default([]),
  /** Webhook tokens: SigNoz's alert-webhook channel only. SigNoz has no
   * HMAC-signing option (verified against its current docs — the channel
   * authenticates via HTTP Basic Auth, or a bearer token when the
   * configured username is left empty); a token scoped to only this route
   * means a leaked SigNoz webhook credential still cannot resume, disable,
   * or force-trip anything directly — it can only cause a *trip*, and only
   * for the scope named in the alert's own labels. Comma-separated in
   * CONTROL_PLANE_WEBHOOK_TOKENS. Tenant-scoped entries are enforced across every
   * alert in a grouped delivery; use a plain wildcard token only when one
   * SigNoz instance intentionally spans multiple tenants. */
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
  /** Startup-loaded, immutable policy JSON (one Policy object or an array).
   * Production deployments should always set this; omission retains the
   * documented local-development defaults. */
  detectorPolicyFile: z.string().min(1).optional(),
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
 * tenant; a plain token with no colon normalizes to the `'*'` wildcard.
 * A colon with either side empty is rejected fail-closed: treating an
 * operator typo such as `production:` as a literal wildcard bearer token
 * would silently expand its authorization scope. */
function parseTokenEntry(raw: string): TokenConfigEntry {
  const separatorIndex = raw.indexOf(':');
  if (separatorIndex < 0) return raw;
  const tenant = raw.slice(0, separatorIndex).trim();
  const token = raw.slice(separatorIndex + 1).trim();
  if (tenant.length === 0 || token.length === 0) {
    throw new Error(
      'invalid token entry: tenant:token entries require both a non-empty tenant and token',
    );
  }
  return { tenant, token };
}

function parseTokenList(raw: string | undefined): TokenConfigEntry[] {
  return (raw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map(parseTokenEntry);
}

/** Agent credentials use `tenant:environment:agentId:token`. Development may
 * deliberately use wildcard selectors (for example `*:*:*:token`) or the
 * legacy tenant-only `tenant:token` form. A plain token is rejected because
 * it would create an implicit, easy-to-miss global wildcard. */
function parseExactScopeTokenEntry(
  raw: string,
  credentialKind: 'agent' | 'exporter evidence',
): AgentTokenConfigEntry {
  const first = raw.indexOf(':');
  if (first < 0) {
    throw new Error(
      `invalid ${credentialKind} token entry: use tenant:environment:agentId:token (or an explicit development wildcard such as *:*:*:token)`,
    );
  }
  const second = raw.indexOf(':', first + 1);
  if (second < 0) return parseTokenEntry(raw);
  const third = raw.indexOf(':', second + 1);
  if (third < 0) {
    throw new Error(
      `invalid ${credentialKind} token entry: expected tenant:environment:agentId:token`,
    );
  }

  const tenant = raw.slice(0, first).trim();
  const environment = raw.slice(first + 1, second).trim();
  const agentId = raw.slice(second + 1, third).trim();
  const token = raw.slice(third + 1).trim();
  if (
    tenant.length === 0 ||
    environment.length === 0 ||
    agentId.length === 0 ||
    token.length === 0
  ) {
    throw new Error(
      `invalid ${credentialKind} token entry: tenant:environment:agentId:token entries require every field to be non-empty`,
    );
  }
  return { tenant, environment, agentId, token };
}

function parseExactScopeTokenList(
  raw: string | undefined,
  credentialKind: 'agent' | 'exporter evidence',
): AgentTokenConfigEntry[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseExactScopeTokenEntry(entry, credentialKind));
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
  entries: readonly (TokenConfigEntry | AgentTokenConfigEntry)[],
): void {
  for (const entry of entries) {
    const token = typeof entry === 'string' ? entry : entry.token;
    if (token.toLowerCase().startsWith('changeme')) {
      throw new Error(
        `${envVarName} still contains a placeholder value from .env.example; ` +
          'the value is intentionally omitted from this error. Generate a real random token ' +
          '(e.g. `openssl rand -hex 32`) ' +
          'and set it before starting the control plane.',
      );
    }
  }
}

export function assertSecureAgentTokenConfiguration(
  config: Pick<ControlPlaneConfig, 'deploymentEnvironment' | 'agentApiTokens'>,
): void {
  if (config.deploymentEnvironment !== 'production') return;
  for (const entry of config.agentApiTokens) {
    if (
      typeof entry === 'string' ||
      !('environment' in entry) ||
      entry.tenant === '*' ||
      entry.environment === '*' ||
      entry.agentId === '*'
    ) {
      throw new Error(
        'invalid control-plane configuration: production agent credentials must bind tenant, environment, and agentId without wildcards',
      );
    }
  }
}

export function assertSecureExporterEvidenceTokenConfiguration(
  config: Pick<ControlPlaneConfig, 'deploymentEnvironment' | 'exporterEvidenceTokens'>,
): void {
  if (config.deploymentEnvironment !== 'production') return;
  if (config.exporterEvidenceTokens.length === 0) {
    throw new Error(
      'invalid control-plane configuration: CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS requires at least one exact-scope credential in production',
    );
  }
  for (const entry of config.exporterEvidenceTokens) {
    if (
      typeof entry === 'string' ||
      !('environment' in entry) ||
      entry.tenant === '*' ||
      entry.environment === '*' ||
      entry.agentId === '*'
    ) {
      throw new Error(
        'invalid control-plane configuration: production exporter evidence credentials must bind tenant, environment, and agentId without wildcards',
      );
    }
  }
}

export function assertExporterCredentialSeparation(
  config: Pick<
    ControlPlaneConfig,
    'apiTokens' | 'agentApiTokens' | 'exporterEvidenceTokens' | 'webhookTokens'
  >,
): void {
  const exporterTokens = normalizeTokens(config.exporterEvidenceTokens).map(
    ({ token }) => token,
  );
  if (new Set(exporterTokens).size !== exporterTokens.length) {
    throw new Error(
      'invalid control-plane configuration: each exporter evidence credential must use a unique token value for exactly one scope',
    );
  }
  const ordinaryTokens = new Set(
    normalizeTokens([
      ...config.apiTokens,
      ...config.agentApiTokens,
      ...config.webhookTokens,
    ]).map(({ token }) => token),
  );
  if (exporterTokens.some((token) => ordinaryTokens.has(token))) {
    throw new Error(
      'invalid control-plane configuration: exporter evidence credentials must not reuse operator, agent, or webhook token values',
    );
  }
}

export function assertProductionCredentialConfiguration(
  config: Pick<
    ControlPlaneConfig,
    | 'deploymentEnvironment'
    | 'apiTokens'
    | 'agentApiTokens'
    | 'exporterEvidenceTokens'
    | 'webhookTokens'
  >,
): void {
  if (config.deploymentEnvironment !== 'production') return;
  for (const [envVarName, entries] of [
    ['CONTROL_PLANE_API_TOKENS', config.apiTokens],
    ['CONTROL_PLANE_AGENT_API_TOKENS', config.agentApiTokens],
    ['CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS', config.exporterEvidenceTokens],
    ['CONTROL_PLANE_WEBHOOK_TOKENS', config.webhookTokens],
  ] as const) {
    for (const entry of entries) {
      const token = typeof entry === 'string' ? entry : entry.token;
      if (Buffer.byteLength(token, 'utf8') < MIN_PRODUCTION_TOKEN_BYTES) {
        throw new Error(
          `invalid control-plane configuration: ${envVarName} credentials must be at least ${MIN_PRODUCTION_TOKEN_BYTES} bytes in production; generate each independently with \`openssl rand -hex 32\``,
        );
      }
    }
  }
}

export function assertProductionRateLimitConfiguration(
  config: Pick<ControlPlaneConfig, 'deploymentEnvironment' | 'rateLimitRedisUrl'>,
): void {
  if (
    config.deploymentEnvironment === 'production' &&
    config.rateLimitRedisUrl === undefined
  ) {
    throw new Error(
      'invalid control-plane configuration: CONTROL_PLANE_RATE_LIMIT_REDIS_URL is required when CONTROL_PLANE_DEPLOYMENT_ENVIRONMENT=production; replica-local in-memory rate limiting is not safe for a distributed deployment',
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControlPlaneConfig {
  const apiTokens = parseTokenList(env['CONTROL_PLANE_API_TOKENS']);
  const agentApiTokens = parseExactScopeTokenList(
    env['CONTROL_PLANE_AGENT_API_TOKENS'],
    'agent',
  );
  const exporterEvidenceTokens = parseExactScopeTokenList(
    env['CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS'],
    'exporter evidence',
  );
  const webhookTokens = parseTokenList(env['CONTROL_PLANE_WEBHOOK_TOKENS']);
  assertNoPlaceholderTokens('CONTROL_PLANE_API_TOKENS', apiTokens);
  assertNoPlaceholderTokens('CONTROL_PLANE_AGENT_API_TOKENS', agentApiTokens);
  assertNoPlaceholderTokens(
    'CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS',
    exporterEvidenceTokens,
  );
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
    maxRegisteredScopesPerTenant: env['CONTROL_PLANE_MAX_REGISTERED_SCOPES_PER_TENANT']
      ? Number(env['CONTROL_PLANE_MAX_REGISTERED_SCOPES_PER_TENANT'])
      : undefined,
    rateLimitMax: env['CONTROL_PLANE_RATE_LIMIT_MAX']
      ? Number(env['CONTROL_PLANE_RATE_LIMIT_MAX'])
      : undefined,
    rateLimitWindowMs: env['CONTROL_PLANE_RATE_LIMIT_WINDOW_MS']
      ? Number(env['CONTROL_PLANE_RATE_LIMIT_WINDOW_MS'])
      : undefined,
    rateLimitRedisUrl: env['CONTROL_PLANE_RATE_LIMIT_REDIS_URL'] || undefined,
    storeOutageMode: env['CONTROL_PLANE_STORE_OUTAGE_MODE'],
    apiTokens,
    agentApiTokens,
    exporterEvidenceTokens,
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
    detectorPolicyFile: env['CONTROL_PLANE_DETECTOR_POLICY_FILE'],
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
  if (
    parsed.data.deploymentEnvironment === 'production' &&
    parsed.data.detectorPolicyFile === undefined
  ) {
    throw new Error(
      'invalid control-plane configuration: CONTROL_PLANE_DETECTOR_POLICY_FILE is required when CONTROL_PLANE_DEPLOYMENT_ENVIRONMENT=production',
    );
  }
  assertSecureAgentTokenConfiguration(parsed.data);
  assertSecureExporterEvidenceTokenConfiguration(parsed.data);
  assertExporterCredentialSeparation(parsed.data);
  assertProductionCredentialConfiguration(parsed.data);
  assertProductionRateLimitConfiguration(parsed.data);
  return parsed.data;
}
