import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DetectorTypeSchema,
  PreflightResultSchema,
  type DetectorResult,
  type Scope,
} from '@fuse/contracts';
import {
  SignozMcpClient,
  buildDiagnosis,
  buildIncidentCardBlocks,
  buildUnavailableEvidenceBundle,
  fetchIncidentEvidence,
  postIncidentCard,
  renderLocalIncidentCardHtml,
  type EvidenceBundle,
  type IncidentCardContext,
} from '@fuse/diagnosis';
import { loadConfig, normalizeTokens, type ScopedToken } from './config.js';

export interface DiagnosisWorkerConfig {
  mcpServerUrl: string | undefined;
  slackBotToken: string | undefined;
  slackChannel: string;
  localSnapshotDir: string;
  /** Same-process authenticated status endpoint used to read the latest
   * committed Preflight result for an incident's exact scope. Optional for
   * manually constructed test configs; absence renders `unknown`. */
  preflightStatusUrl?: string;
  /** Required to verify `POST /v1/slack/interactive` requests really came
   * from Slack (task.md §7.3: "sign/verify interactive actions"). Absent
   * means that route fail-closed rejects every request — unlike outbound
   * Slack posting, an *inbound* unverified action could trigger a real
   * resume, so this one is never allowed to silently no-op-open. */
  slackSigningSecret: string | undefined;
  /** Slack users explicitly allowed to resume breakers. A valid Slack
   * signature proves the request came through Slack, not that its user is
   * authorized for this privileged action. */
  slackAuthorizedUserIds: readonly string[];
  /** Optional workspace binding. When configured, both the button click and
   * modal submission must carry this exact Slack team id. */
  slackTeamId: string | undefined;
  /** Validated operator-tier tokens used to call the real
   * `/v1/breaker/resume` API on a verified Slack resume submission.
   * Selection is deferred until the submission's tenant is known; see
   * `selectOperatorTokenForTenant`. */
  operatorTokens?: readonly ScopedToken[];
  /** @deprecated Compatibility for callers that manually construct this
   * config. `loadDiagnosisWorkerConfig` only exposes an unscoped token
   * here, so the legacy route fails closed rather than sending a
   * `tenant:token` config entry as the bearer credential. */
  operatorToken: string | undefined;
}

function hasAmbiguousTenantBindings(tokens: readonly ScopedToken[]): boolean {
  const tenantsByToken = new Map<string, Set<string>>();
  for (const entry of tokens) {
    const tenants = tenantsByToken.get(entry.token) ?? new Set<string>();
    tenants.add(entry.tenant);
    tenantsByToken.set(entry.token, tenants);
  }
  return [...tenantsByToken.values()].some((tenants) => tenants.size > 1);
}

/**
 * Parses operator tokens through the control plane's own configuration
 * loader instead of maintaining a second, subtly different parser here.
 * Invalid, placeholder, or ambiguously-bound token lists disable Slack
 * resume fail-closed; outbound incident posting remains available.
 */
function parseOperatorTokens(raw: string | undefined): ScopedToken[] {
  if (!raw) return [];
  try {
    const entries = loadConfig({
      DATABASE_URL: 'postgresql://config-validation.invalid/fuse',
      CONTROL_PLANE_API_TOKENS: raw,
    }).apiTokens;
    const tokens = normalizeTokens(entries);
    return hasAmbiguousTenantBindings(tokens) ? [] : tokens;
  } catch {
    return [];
  }
}

const SLACK_USER_ID = /^[UW][A-Z0-9]{1,31}$/;
const SLACK_TEAM_ID = /^T[A-Z0-9]{1,31}$/;
const PREFLIGHT_READ_TIMEOUT_MS = 2_000;

function parseAuthorizedSlackUserIds(raw: string | undefined): string[] {
  if (!raw) return [];
  const ids = raw.split(',').map((value) => value.trim());
  if (ids.some((id) => !SLACK_USER_ID.test(id))) return [];
  return [...new Set(ids)];
}

/**
 * Selects the least-privileged usable operator credential for one tenant:
 * an exact tenant binding wins, with a wildcard accepted only as an
 * explicit fallback. No match, malformed config, and a token value bound
 * to multiple tenants all return undefined.
 */
export function selectOperatorTokenForTenant(
  config: Pick<DiagnosisWorkerConfig, 'operatorTokens' | 'operatorToken'>,
  tenant: string,
): string | undefined {
  if (tenant.length === 0) return undefined;

  // `operatorToken` is retained only for existing manually-constructed
  // configs/tests. Loaded production config always supplies
  // `operatorTokens`, including an empty array on invalid input.
  const tokens =
    config.operatorTokens ??
    (config.operatorToken ? [{ tenant: '*', token: config.operatorToken }] : []);
  if (hasAmbiguousTenantBindings(tokens)) return undefined;

  return (
    tokens.find((entry) => entry.tenant === tenant)?.token ??
    tokens.find((entry) => entry.tenant === '*')?.token
  );
}

export function loadDiagnosisWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): DiagnosisWorkerConfig {
  const operatorTokens = parseOperatorTokens(env['CONTROL_PLANE_API_TOKENS']);
  const configuredTeamId = env['SLACK_TEAM_ID']?.trim();
  const slackTeamId =
    configuredTeamId && SLACK_TEAM_ID.test(configuredTeamId)
      ? configuredTeamId
      : undefined;
  const slackAuthorizedUserIds =
    configuredTeamId && !slackTeamId
      ? []
      : parseAuthorizedSlackUserIds(env['SLACK_AUTHORIZED_USER_IDS']);
  const controlPlanePort = Number(env['CONTROL_PLANE_PORT'] ?? 8090);
  const preflightStatusUrl =
    Number.isSafeInteger(controlPlanePort) &&
    controlPlanePort > 0 &&
    controlPlanePort <= 65_535
      ? `http://127.0.0.1:${controlPlanePort}/v1/preflight/status`
      : undefined;
  return {
    mcpServerUrl: env['FUSE_SIGNOZ_MCP_URL'],
    slackBotToken: env['SLACK_BOT_TOKEN'],
    slackChannel: env['SLACK_INCIDENT_CHANNEL'] ?? '#fuse-incidents',
    localSnapshotDir: env['FUSE_INCIDENT_SNAPSHOT_DIR'] ?? '/tmp/fuse-incidents',
    ...(preflightStatusUrl ? { preflightStatusUrl } : {}),
    slackSigningSecret: env['SLACK_SIGNING_SECRET'],
    slackAuthorizedUserIds,
    slackTeamId,
    operatorTokens,
    // Never expose a tenant-prefixed config entry as a bearer token. This
    // compatibility field is intentionally wildcard-only.
    operatorToken: operatorTokens.find((entry) => entry.tenant === '*')?.token,
  };
}

export interface DiagnosisTrigger {
  /** Durable breaker audit identity. Dispatcher-owned attempts always set
   * this; legacy direct callers fall back to correlation identity. */
  auditEventId?: string;
  scope: Scope;
  /** The raw `fuse_detector`-style label from the alert — not yet known to
   * be one of the three real detector types. */
  detector: string;
  reason: string;
  correlationId: string;
  startsAt: string;
  /** Epoch committed by the trip that created this incident. Optional only
   * while legacy trigger call sites are migrated; its absence always omits
   * the Resume action rather than creating an epoch-unbound action. */
  tripEpoch?: number;
  /** Durable policy decision captured when the trip committed. Defaults to
   * true only for legacy direct callers; dispatcher jobs always set it. */
  notifySlack?: boolean;
  /** Present for direct SDK detector enforcement. SigNoz webhook alerts do
   * not carry the original score/threshold, so that path leaves this absent
   * and diagnosis must not invent numeric evidence. */
  detectorResult?: DetectorResult;
}

type Logger = (msg: string, meta?: Record<string, unknown>) => void;

export type DiagnosisDeliveryResult =
  | { delivered: true; channel: 'slack' | 'snapshot' | 'skipped' }
  | { delivered: false; reason: string };

/**
 * Runs one bounded delivery attempt. It never throws: the durable dispatcher
 * interprets `delivered:false` as a retry, while enforcement remains entirely
 * independent because the trip and job committed before this function runs.
 */
export async function runDiagnosisAndNotify(
  trigger: DiagnosisTrigger,
  config: DiagnosisWorkerConfig,
  log: Logger = () => {},
): Promise<DiagnosisDeliveryResult> {
  try {
    const detectorParse = DetectorTypeSchema.safeParse(trigger.detector);
    if (!detectorParse.success) {
      log('diagnosis skipped: unrecognized detector label', {
        detector: trigger.detector,
      });
      return { delivered: true, channel: 'skipped' };
    }
    const detector = detectorParse.data;

    const windowEnd = new Date();
    const parsedStartsAt = Date.parse(trigger.startsAt);
    const windowStart = new Date(
      Number.isFinite(parsedStartsAt) ? parsedStartsAt : windowEnd.getTime() - 5 * 60_000,
    );

    const evidence = await fetchEvidence(
      trigger.scope,
      windowStart,
      windowEnd,
      config,
      log,
    );

    const detectorResult: DetectorResult = trigger.detectorResult ?? {
      detector,
      detectorVersion: `${detector}-signoz-alert`,
      scope: trigger.scope,
      fired: true,
      // Required by the shared detector-result shape but never presented as
      // evidence: `measurementAvailable=false` selects wording that states
      // the webhook omitted the original measurement.
      score: 0,
      threshold: 0,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      evidence: [trigger.reason],
      dedupeKey: trigger.correlationId,
    };

    const diagnosis = buildDiagnosis(
      detectorResult,
      evidence,
      windowEnd,
      trigger.detectorResult !== undefined,
    );
    const resumeOperatorToken = selectOperatorTokenForTenant(
      config,
      trigger.scope.tenant,
    );
    const preflightState = await readCommittedPreflightState(
      trigger.scope,
      trigger.correlationId,
      resumeOperatorToken,
      config,
      log,
    );
    const hasTripEpoch =
      Number.isSafeInteger(trigger.tripEpoch) && (trigger.tripEpoch ?? -1) >= 0;
    const hasSlackActorAuthorization = config.slackAuthorizedUserIds.length > 0;
    const resumeActionValue =
      config.slackSigningSecret &&
      resumeOperatorToken &&
      hasSlackActorAuthorization &&
      hasTripEpoch
        ? JSON.stringify({
            version: 1,
            scope: trigger.scope,
            expectedEpoch: trigger.tripEpoch,
            correlationId: trigger.correlationId,
          })
        : undefined;
    const cardContext: IncidentCardContext = {
      correlationId: trigger.correlationId,
      preflightState,
      ...(resumeActionValue ? { resumeActionValue } : {}),
    };
    const card = buildIncidentCardBlocks(diagnosis, cardContext);

    if (config.slackBotToken && !resumeActionValue) {
      log('Slack Resume action omitted: interactive authorization unavailable', {
        hasSigningSecret: Boolean(config.slackSigningSecret),
        hasTenantOperatorToken: Boolean(resumeOperatorToken),
        hasAuthorizedSlackUsers: hasSlackActorAuthorization,
        hasTripEpoch,
        hasConfiguredTeam: Boolean(config.slackTeamId),
        tenant: trigger.scope.tenant,
      });
    }

    const snapshotWritten = await writeLocalSnapshot(diagnosis, cardContext, config, log);

    if (trigger.notifySlack === false) {
      return snapshotWritten
        ? { delivered: true, channel: 'snapshot' }
        : { delivered: false, reason: 'local incident snapshot was not written' };
    }

    const slackResult = await postIncidentCard(card, {
      botToken: config.slackBotToken,
      channel: config.slackChannel,
      messageIdentity: trigger.auditEventId
        ? `${trigger.auditEventId}:${trigger.correlationId}`
        : trigger.correlationId,
    });
    if (!slackResult.posted) {
      log('Slack incident post not delivered', { reason: slackResult.reason });
      return {
        delivered: false,
        reason: slackResult.reason ?? 'Slack incident post was not delivered',
      };
    } else {
      log('Slack incident post delivered', {
        channel: config.slackChannel,
        ts: slackResult.ts,
      });
      return { delivered: true, channel: 'slack' };
    }
  } catch (err) {
    // Belt-and-braces: every awaited step above already degrades on its
    // own, but this is fire-and-forget from the webhook route, so nothing
    // else will ever observe an uncaught rejection here.
    log('diagnosis pipeline failed unexpectedly', {
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      delivered: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function readCommittedPreflightState(
  scope: Scope,
  correlationId: string,
  operatorToken: string | undefined,
  config: DiagnosisWorkerConfig,
  log: Logger,
): Promise<IncidentCardContext['preflightState']> {
  if (!config.preflightStatusUrl || !operatorToken) {
    log('Preflight state unavailable for incident card', {
      reason: config.preflightStatusUrl
        ? 'no tenant-matching operator token'
        : 'status endpoint not configured',
      tenant: scope.tenant,
    });
    return 'unknown';
  }

  const url = new URL(config.preflightStatusUrl);
  url.searchParams.set('tenant', scope.tenant);
  url.searchParams.set('environment', scope.environment);
  url.searchParams.set('agentId', scope.agentId);
  try {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${operatorToken}`,
        'x-correlation-id': correlationId,
      },
      signal: AbortSignal.timeout(PREFLIGHT_READ_TIMEOUT_MS),
    });
    if (!response.ok) {
      log('Preflight state unavailable for incident card', {
        reason: 'status endpoint rejected the read',
        statusCode: response.status,
        tenant: scope.tenant,
      });
      return 'unknown';
    }

    const body: unknown = await response.json();
    const parsed = PreflightResultSchema.safeParse(
      typeof body === 'object' && body !== null && 'result' in body
        ? body.result
        : undefined,
    );
    if (
      !parsed.success ||
      parsed.data.scope.tenant !== scope.tenant ||
      parsed.data.scope.environment !== scope.environment ||
      parsed.data.scope.agentId !== scope.agentId
    ) {
      log('Preflight state unavailable for incident card', {
        reason: 'status endpoint returned an invalid or mismatched result',
        tenant: scope.tenant,
      });
      return 'unknown';
    }
    return parsed.data.state;
  } catch (error) {
    log('Preflight state unavailable for incident card', {
      reason: error instanceof Error ? error.message : String(error),
      tenant: scope.tenant,
    });
    return 'unknown';
  }
}

async function fetchEvidence(
  scope: Scope,
  windowStart: Date,
  windowEnd: Date,
  config: DiagnosisWorkerConfig,
  log: Logger,
): Promise<EvidenceBundle> {
  if (!config.mcpServerUrl) {
    return buildUnavailableEvidenceBundle(
      'SigNoz MCP server not configured (FUSE_SIGNOZ_MCP_URL unset)',
    );
  }
  const mcp = new SignozMcpClient({ serverUrl: config.mcpServerUrl });
  try {
    return await fetchIncidentEvidence(mcp, { scope, windowStart, windowEnd });
  } catch (err) {
    log('evidence fetch threw unexpectedly', {
      err: err instanceof Error ? err.message : String(err),
    });
    return buildUnavailableEvidenceBundle(
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    await mcp.close();
  }
}

async function writeLocalSnapshot(
  diagnosis: Parameters<typeof renderLocalIncidentCardHtml>[0],
  context: IncidentCardContext,
  config: DiagnosisWorkerConfig,
  log: Logger,
): Promise<boolean> {
  try {
    await mkdir(config.localSnapshotDir, { recursive: true });
    const fileName = `${context.correlationId.replace(/[^a-zA-Z0-9_-]/g, '_')}.html`;
    await writeFile(
      path.join(config.localSnapshotDir, fileName),
      renderLocalIncidentCardHtml(diagnosis, context),
      'utf8',
    );
    return true;
  } catch (err) {
    log('failed to write local incident snapshot', {
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
