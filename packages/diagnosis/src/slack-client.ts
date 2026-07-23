import type { IncidentCardBlocks } from './incident-card.js';

export interface SlackPostOptions {
  /** Bot token (`xoxb-...`), read from env by the caller — never hardcoded
   * or committed. Absent means "not configured yet"; this is a normal,
   * expected state for local dev (task.md: the user will supply this
   * later), not an error. */
  botToken: string | undefined;
  channel: string;
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
