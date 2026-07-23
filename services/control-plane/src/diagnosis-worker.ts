import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DetectorTypeSchema, type DetectorResult, type Scope } from '@fuse/contracts';
import {
  SignozMcpClient,
  buildDiagnosis,
  buildIncidentCardBlocks,
  buildUnavailableEvidenceBundle,
  fetchIncidentEvidence,
  postIncidentCard,
  renderLocalIncidentCardHtml,
  type EvidenceBundle,
} from '@fuse/diagnosis';
import { loadConfig, normalizeTokens, type ScopedToken } from './config.js';

export interface DiagnosisWorkerConfig {
  mcpServerUrl: string | undefined;
  slackBotToken: string | undefined;
  slackChannel: string;
  localSnapshotDir: string;
  /** Required to verify `POST /v1/slack/interactive` requests really came
   * from Slack (task.md §7.3: "sign/verify interactive actions"). Absent
   * means that route fail-closed rejects every request — unlike outbound
   * Slack posting, an *inbound* unverified action could trigger a real
   * resume, so this one is never allowed to silently no-op-open. */
  slackSigningSecret: string | undefined;
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
  return {
    mcpServerUrl: env['FUSE_SIGNOZ_MCP_URL'],
    slackBotToken: env['SLACK_BOT_TOKEN'],
    slackChannel: env['SLACK_INCIDENT_CHANNEL'] ?? '#fuse-incidents',
    localSnapshotDir: env['FUSE_INCIDENT_SNAPSHOT_DIR'] ?? '/tmp/fuse-incidents',
    slackSigningSecret: env['SLACK_SIGNING_SECRET'],
    operatorTokens,
    // Never expose a tenant-prefixed config entry as a bearer token. This
    // compatibility field is intentionally wildcard-only.
    operatorToken: operatorTokens.find((entry) => entry.tenant === '*')?.token,
  };
}

export interface DiagnosisTrigger {
  scope: Scope;
  /** The raw `fuse_detector`-style label from the alert — not yet known to
   * be one of the three real detector types. */
  detector: string;
  reason: string;
  correlationId: string;
  startsAt: string;
  /** Present for direct SDK detector enforcement. SigNoz webhook alerts do
   * not carry the original score/threshold, so that path leaves this absent
   * and diagnosis must not invent numeric evidence. */
  detectorResult?: DetectorResult;
}

type Logger = (msg: string, meta?: Record<string, unknown>) => void;

/**
 * Runs the diagnose -> card -> notify pipeline for one real trip (task.md
 * §7). Never throws and is never awaited by the webhook response that
 * triggers it (services/control-plane/src/routes/webhook.ts) — the trip
 * has already committed by the time this runs, so a diagnosis/Slack
 * failure must never look like an enforcement failure or slow down the
 * webhook's own response (task.md: "diagnosis/Slack outages do not weaken
 * the tripped breaker").
 */
export async function runDiagnosisAndNotify(
  trigger: DiagnosisTrigger,
  config: DiagnosisWorkerConfig,
  log: Logger = () => {},
): Promise<void> {
  try {
    const detectorParse = DetectorTypeSchema.safeParse(trigger.detector);
    if (!detectorParse.success) {
      log('diagnosis skipped: unrecognized detector label', {
        detector: trigger.detector,
      });
      return;
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
    const resumeActionValue =
      config.slackSigningSecret && resumeOperatorToken
        ? JSON.stringify(trigger.scope)
        : undefined;
    const card = buildIncidentCardBlocks(diagnosis, {
      correlationId: trigger.correlationId,
      ...(resumeActionValue ? { resumeActionValue } : {}),
    });

    if (config.slackBotToken && !resumeActionValue) {
      log('Slack Resume action omitted: interactive authorization unavailable', {
        hasSigningSecret: Boolean(config.slackSigningSecret),
        hasTenantOperatorToken: Boolean(resumeOperatorToken),
        tenant: trigger.scope.tenant,
      });
    }

    await writeLocalSnapshot(diagnosis, trigger.correlationId, config, log);

    const slackResult = await postIncidentCard(card, {
      botToken: config.slackBotToken,
      channel: config.slackChannel,
    });
    if (!slackResult.posted) {
      log('Slack incident post not delivered', { reason: slackResult.reason });
    } else {
      log('Slack incident post delivered', {
        channel: config.slackChannel,
        ts: slackResult.ts,
      });
    }
  } catch (err) {
    // Belt-and-braces: every awaited step above already degrades on its
    // own, but this is fire-and-forget from the webhook route, so nothing
    // else will ever observe an uncaught rejection here.
    log('diagnosis pipeline failed unexpectedly', {
      err: err instanceof Error ? err.message : String(err),
    });
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
  correlationId: string,
  config: DiagnosisWorkerConfig,
  log: Logger,
): Promise<void> {
  try {
    await mkdir(config.localSnapshotDir, { recursive: true });
    const fileName = `${correlationId.replace(/[^a-zA-Z0-9_-]/g, '_')}.html`;
    await writeFile(
      path.join(config.localSnapshotDir, fileName),
      renderLocalIncidentCardHtml(diagnosis, { correlationId }),
      'utf8',
    );
  } catch (err) {
    log('failed to write local incident snapshot', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
