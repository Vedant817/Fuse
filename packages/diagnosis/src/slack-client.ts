import { createHash } from 'node:crypto';
import type { IncidentCardBlocks } from './incident-card.js';

export interface SlackPostOptions {
  /** Bot token (`xoxb-...`), read from env by the caller — never hardcoded
   * or committed. Absent means "not configured yet"; this is a normal,
   * expected state for local dev (task.md: the user will supply this
   * later), not an error. */
  botToken: string | undefined;
  channel: string;
  /** Stable audit/correlation identity. Slack uses the derived
   * `client_msg_id` to suppress a provider-level duplicate if a lease is
   * lost after Slack accepted the first request but before Fuse committed
   * completion. */
  messageIdentity: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface SlackPostResult {
  posted: boolean;
  /** Set when `posted` is false: why (no token, network error, Slack API
   * error). Never thrown — see the module doc comment. */
  reason?: string;
  /** Slack's own message timestamp (its de facto message ID), when posted. */
  ts?: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** Slack documents `client_msg_id` as a UUID. Derive a deterministic UUID
 * from the durable incident identity instead of forwarding an unbounded or
 * sensitive correlation string. */
export function deriveSlackClientMessageId(identity: string): string {
  if (identity.length < 1 || identity.length > 500) {
    throw new RangeError(
      'Slack message identity must contain between 1 and 500 characters',
    );
  }
  const bytes = createHash('sha256').update(identity).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Posts an incident card to a real Slack channel via `chat.postMessage`.
 * Mirrors this repo's established off-critical-path conventions
 * (`PreflightReporter`, `StepObservationReporter`): never throws, degrades
 * to `{ posted: false, reason }` on a missing token, network failure, or a
 * Slack API-level error — a diagnosis/Slack outage must never affect
 * enforcement (task.md §7's acceptance criteria), and the trip this card
 * describes has already committed by the time this runs.
 */
export async function postIncidentCard(
  card: IncidentCardBlocks,
  options: SlackPostOptions,
): Promise<SlackPostResult> {
  if (!options.botToken) {
    return {
      posted: false,
      reason: 'no Slack bot token configured (SLACK_BOT_TOKEN unset)',
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let clientMessageId: string;
  try {
    clientMessageId = deriveSlackClientMessageId(options.messageIdentity);
  } catch (error) {
    return {
      posted: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${options.botToken}`,
      },
      body: JSON.stringify({
        channel: options.channel,
        client_msg_id: clientMessageId,
        text: card.text,
        blocks: card.blocks,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { posted: false, reason: `Slack API returned HTTP ${res.status}` };
    }
    const body = (await res.json()) as { ok: boolean; error?: string; ts?: string };
    if (!body.ok) {
      return { posted: false, reason: `Slack API error: ${body.error ?? 'unknown'}` };
    }
    return { posted: true, ts: body.ts };
  } catch (err) {
    return {
      posted: false,
      reason: `Slack post failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface OpenModalOptions {
  botToken: string | undefined;
  triggerId: string;
  view: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface OpenModalResult {
  opened: boolean;
  reason?: string;
}

/**
 * Opens the "resume reason" modal in response to a button click, via
 * Slack's `views.open` — must be called within Slack's ~3s ack window for
 * the `trigger_id` to still be valid. Same never-throws/degrade convention
 * as `postIncidentCard`: a failure here means the operator doesn't see the
 * modal, which is a Slack UX gap, not an enforcement gap (the breaker is
 * already tripped and stays tripped either way).
 */
export async function openResumeModal(
  options: OpenModalOptions,
): Promise<OpenModalResult> {
  if (!options.botToken) {
    return {
      opened: false,
      reason: 'no Slack bot token configured (SLACK_BOT_TOKEN unset)',
    };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://slack.com/api/views.open', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${options.botToken}`,
      },
      body: JSON.stringify({ trigger_id: options.triggerId, view: options.view }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { opened: false, reason: `Slack API returned HTTP ${res.status}` };
    }
    const body = (await res.json()) as { ok: boolean; error?: string };
    if (!body.ok) {
      return { opened: false, reason: `Slack API error: ${body.error ?? 'unknown'}` };
    }
    return { opened: true };
  } catch (err) {
    return {
      opened: false,
      reason: `views.open failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
