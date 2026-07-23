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

/** The modal Slack opens when an operator clicks "Resume" on an incident
 * card — collects the required reason as free text rather than letting a
 * bare button click resume anything (task.md: "require a resume reason").
 * `scopeValue` round-trips through Slack's own `private_metadata`. */
export function buildResumeReasonModalView(scopeValue: string): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: 'fuse_resume_submit',
    private_metadata: scopeValue,
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
        },
      },
    ],
  };
}

export interface ParsedResumeSubmission {
  scope: Scope;
  reason: string;
  slackUserId: string;
  /** Slack's own view id — stable per modal instance, used as the
   * idempotency key so a duplicate `view_submission` delivery (Slack
   * retries on slow acks) resumes at most once. */
  viewId: string;
}

interface SlackViewSubmissionPayload {
  type: string;
  user?: { id?: string };
  view?: {
    id?: string;
    private_metadata?: string;
    state?: {
      values?: Record<string, Record<string, { value?: string }>>;
    };
  };
}

/** Parses a verified `view_submission` interactive payload into the data
 * needed to call the real control-plane resume API. Returns undefined
 * (never throws) for a payload missing required fields — the caller
 * should treat that as a malformed/rejected action, not crash. */
export function parseResumeSubmission(
  payload: SlackViewSubmissionPayload,
): ParsedResumeSubmission | undefined {
  if (payload.type !== 'view_submission') return undefined;
  const slackUserId = payload.user?.id;
  const viewId = payload.view?.id;
  const scopeValue = payload.view?.private_metadata;
  const reason = payload.view?.state?.values?.['reason_block']?.['reason_input']?.value;
  if (!slackUserId || !viewId || !scopeValue || !reason || reason.trim().length === 0) {
    return undefined;
  }
  let scope: Scope;
  try {
    scope = JSON.parse(scopeValue) as Scope;
  } catch {
    return undefined;
  }
  if (!scope.tenant || !scope.environment || !scope.agentId) return undefined;
  return { scope, reason, slackUserId, viewId };
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
          reason: submission.reason,
          actor: { type: 'manual', id: `slack:${submission.slackUserId}` },
          correlationId: `slack-resume-${submission.viewId}`,
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
