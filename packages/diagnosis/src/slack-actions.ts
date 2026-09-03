import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Scope } from '@fuse/contracts';

/**
 * Verifies a Slack interactive-request signature (Slack's own documented
 * scheme: `v0:{timestamp}:{rawBody}` HMAC-SHA256'd with the signing
 * secret, compared to the `X-Slack-Signature` header) — task.md §7.3:
 * "Sign/verify interactive actions, prevent replay." Constant-time
 * comparison, same reasoning as this repo's bearer-token check
 * (`services/control-plane/src/auth.ts`): a timing side-channel on an
 * authorization check is a real vulnerability class, not a theoretical one.
 */
export function verifySlackSignature(params: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
  signature: string;
}): boolean {
  const expected =
    'v0=' +
    createHmac('sha256', params.signingSecret)
      .update(`v0:${params.timestamp}:${params.rawBody}`)
      .digest('hex');
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(params.signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/** Slack's own docs recommend rejecting requests whose timestamp is more
 * than 5 minutes old or skewed into the future — the same replay-window
 * discipline this repo's SigNoz webhook already applies
 * (`services/control-plane/src/routes/webhook.ts`'s `isStaleAlert`). */
export function isFreshSlackTimestamp(
  timestampHeader: string,
  now: Date = new Date(),
  maxSkewMs = 5 * 60_000,
): boolean {
  const tsSeconds = Number(timestampHeader);
  if (!Number.isFinite(tsSeconds)) return false;
  const ageMs = now.getTime() - tsSeconds * 1000;
  return Math.abs(ageMs) <= maxSkewMs;
}

const MAX_PRIVATE_METADATA_LENGTH = 2_000;
const MAX_REASON_LENGTH = 2_000;
const MAX_SLACK_ID_LENGTH = 64;
const MAX_VIEW_ID_LENGTH = 187;
const MAX_CORRELATION_ID_LENGTH = 200;

interface ResumePrivateMetadata {
  version: 1;
  scope: Scope;
  expectedEpoch: number;
  correlationId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseResumePrivateMetadata(value: unknown): ResumePrivateMetadata | undefined {
  if (!isBoundedString(value, 1, MAX_PRIVATE_METADATA_LENGTH)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ['version', 'scope', 'expectedEpoch', 'correlationId']) ||
    parsed['version'] !== 1 ||
    !isNonnegativeSafeInteger(parsed['expectedEpoch']) ||
    !isBoundedString(parsed['correlationId'], 1, MAX_CORRELATION_ID_LENGTH)
  ) {
    return undefined;
  }

  const scope = parsed['scope'];
  if (
    !isRecord(scope) ||
    !hasExactKeys(scope, ['tenant', 'environment', 'agentId']) ||
    !isBoundedString(scope['tenant'], 1, 128) ||
    !isBoundedString(scope['environment'], 1, 64) ||
    !isBoundedString(scope['agentId'], 1, 128)
  ) {
    return undefined;
  }

  return {
    version: 1,
    scope: {
      tenant: scope['tenant'],
      environment: scope['environment'],
      agentId: scope['agentId'],
    },
    expectedEpoch: parsed['expectedEpoch'],
    correlationId: parsed['correlationId'],
  };
}

/** The modal Slack opens when an operator clicks "Resume" on an incident
 * card. The action value arrived in a Slack-signed request and is copied to
 * `private_metadata`, which Slack signs again on modal submission. Rejecting
 * it here prevents malformed metadata from entering that round trip. */
export function buildResumeReasonModalView(
  privateMetadata: string,
): Record<string, unknown> | undefined {
  if (!parseResumePrivateMetadata(privateMetadata)) return undefined;
  return {
    type: 'modal',
    callback_id: 'fuse_resume_submit',
    private_metadata: privateMetadata,
    title: { type: 'plain_text', text: 'Resume scope' },
    submit: { type: 'plain_text', text: 'Resume' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'reason_block',
        label: { type: 'plain_text', text: 'Reason for resuming' },
        element: {
          type: 'plain_text_input',
          action_id: 'reason_input',
          multiline: true,
          min_length: 1,
          max_length: MAX_REASON_LENGTH,
        },
      },
    ],
  };
}

export interface ParsedResumeSubmission {
  scope: Scope;
  expectedEpoch: number;
  correlationId: string;
  reason: string;
  slackUserId: string;
  slackTeamId?: string | undefined;
  /** Slack's own view id — stable per modal instance, used as the
   * idempotency key so a duplicate `view_submission` delivery (Slack
   * retries on slow acks) resumes at most once. */
  viewId: string;
}

/** Parses a verified `view_submission` interactive payload into the data
 * needed to call the real control-plane resume API. Returns undefined
 * (never throws) for a payload missing required fields — the caller
 * should treat that as a malformed/rejected action, not crash. */
export function parseResumeSubmission(
  payload: unknown,
): ParsedResumeSubmission | undefined {
  if (!isRecord(payload) || payload['type'] !== 'view_submission') return undefined;
  const user = payload['user'];
  const team = payload['team'];
  const view = payload['view'];
  if (!isRecord(user) || !isRecord(view)) return undefined;

  const slackUserId = user['id'];
  const slackTeamId = isRecord(team) ? team['id'] : undefined;
  const viewId = view['id'];
  const metadata = parseResumePrivateMetadata(view['private_metadata']);
  const state = view['state'];
  const values = isRecord(state) ? state['values'] : undefined;
  const reasonBlock = isRecord(values) ? values['reason_block'] : undefined;
  const reasonInput = isRecord(reasonBlock) ? reasonBlock['reason_input'] : undefined;
  const reason = isRecord(reasonInput) ? reasonInput['value'] : undefined;

  if (
    !isBoundedString(slackUserId, 1, MAX_SLACK_ID_LENGTH) ||
    (slackTeamId !== undefined &&
      !isBoundedString(slackTeamId, 1, MAX_SLACK_ID_LENGTH)) ||
    !isBoundedString(viewId, 1, MAX_VIEW_ID_LENGTH) ||
    !metadata ||
    !isBoundedString(reason, 1, MAX_REASON_LENGTH) ||
    reason.trim().length === 0
  ) {
    return undefined;
  }

  return {
    scope: metadata.scope,
    expectedEpoch: metadata.expectedEpoch,
    correlationId: metadata.correlationId,
    reason,
    slackUserId,
    ...(typeof slackTeamId === 'string' ? { slackTeamId } : {}),
    viewId,
  };
}

export interface ResumeExecutionResult {
  resumed: boolean;
  state?: string | undefined;
  /** Set when `resumed` is false: an HTTP error, a stale-epoch conflict,
   * or a network failure — task.md: "show resulting state or stale-action
   * conflict." */
  reason?: string | undefined;
}

/**
 * Calls the REAL, already-tested `/v1/breaker/resume` operational API
 * (services/control-plane/src/routes/breaker.ts) — a Slack action is just
 * another authorized caller of the existing enforcement API, not a new
 * enforcement path. Never throws.
 */
export async function executeAuthorizedResume(
  submission: ParsedResumeSubmission,
  options: { controlPlaneUrl: string; operatorToken: string; fetchImpl?: typeof fetch },
): Promise<ResumeExecutionResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(
      `${options.controlPlaneUrl.replace(/\/+$/, '')}/v1/breaker/resume`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.operatorToken}`,
        },
        body: JSON.stringify({
          scope: submission.scope,
          expectedEpoch: submission.expectedEpoch,
          reason: submission.reason,
          actor: { type: 'manual', id: `slack:${submission.slackUserId}` },
          correlationId: submission.correlationId,
          idempotencyKey: `slack-resume-${submission.viewId}`,
        }),
      },
    );
    const body = (await res.json().catch(() => undefined)) as
      { record?: { state?: string }; error?: string; message?: string } | undefined;
    if (!res.ok) {
      return {
        resumed: false,
        reason:
          body?.message ?? body?.error ?? `control plane returned HTTP ${res.status}`,
      };
    }
    return { resumed: true, state: body?.record?.state };
  } catch (err) {
    return {
      resumed: false,
      reason: `control plane unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
