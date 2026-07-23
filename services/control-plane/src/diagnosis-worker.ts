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
  /** The operator-tier token used to call the real `/v1/breaker/resume`
   * API on a verified Slack resume submission — a Slack action is just
   * another authorized caller of the existing enforcement API. */
  operatorToken: string | undefined;
}

function firstToken(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const first = raw.split(',')[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

export function loadDiagnosisWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): DiagnosisWorkerConfig {
  return {
    mcpServerUrl: env['FUSE_SIGNOZ_MCP_URL'],
    slackBotToken: env['SLACK_BOT_TOKEN'],
    slackChannel: env['SLACK_INCIDENT_CHANNEL'] ?? '#fuse-incidents',
    localSnapshotDir: env['FUSE_INCIDENT_SNAPSHOT_DIR'] ?? '/tmp/fuse-incidents',
    slackSigningSecret: env['SLACK_SIGNING_SECRET'],
    operatorToken: firstToken(env['CONTROL_PLANE_API_TOKENS']),
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

    // Score/threshold are unknown at this point (this event came from a
    // real SigNoz alert notification, not @fuse/detectors directly, which
    // is the process-local buffer that computed the original score) —
    // 1/1 with `fired: true` is an honest placeholder, not a real
    // measurement; the reason string carries the real detail instead.
    const syntheticDetectorResult: DetectorResult = {
      detector,
      detectorVersion: `${detector}-signoz-alert`,
      scope: trigger.scope,
      fired: true,
      score: 1,
      threshold: 1,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      evidence: [trigger.reason],
      dedupeKey: trigger.correlationId,
    };

    const diagnosis = buildDiagnosis(syntheticDetectorResult, evidence, windowEnd);
    const card = buildIncidentCardBlocks(diagnosis, {
      correlationId: trigger.correlationId,
    });

    await writeLocalSnapshot(diagnosis, trigger.correlationId, config, log);

    const slackResult = await postIncidentCard(card, {
      botToken: config.slackBotToken,
      channel: config.slackChannel,
    });
    if (!slackResult.posted) {
      log('Slack incident post not delivered', { reason: slackResult.reason });
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
