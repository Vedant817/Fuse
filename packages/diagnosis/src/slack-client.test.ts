import { describe, expect, it, vi } from 'vitest';
import {
  deriveSlackClientMessageId,
  openResumeModal,
  postIncidentCard,
} from './slack-client.js';

const CARD = { blocks: [{ type: 'header' }], text: 'Fuse tripped: loop-signature' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('postIncidentCard', () => {
  it('does not touch the network when no bot token is configured', async () => {
    const fetchImpl = vi.fn();
    const result = await postIncidentCard(CARD, {
      botToken: undefined,
      channel: '#incidents',
      messageIdentity: 'audit-1:corr-1',
      fetchImpl,
    });
    expect(result).toEqual({
      posted: false,
      reason: 'no Slack bot token configured (SLACK_BOT_TOKEN unset)',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts to chat.postMessage with the bot token and card content when configured', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, ts: '169.001' }));
    const result = await postIncidentCard(CARD, {
      botToken: 'xoxb-fake',
      channel: '#incidents',
      messageIdentity: 'audit-1:corr-1',
      fetchImpl,
    });
    expect(result).toEqual({ posted: true, ts: '169.001' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({ method: 'POST' }),
    );
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({
      authorization: 'Bearer xoxb-fake',
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      channel: '#incidents',
      client_msg_id: deriveSlackClientMessageId('audit-1:corr-1'),
      text: CARD.text,
      blocks: CARD.blocks,
    });
  });

  it('degrades to posted:false (never throws) on a Slack API-level error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error: 'channel_not_found' }));
    const result = await postIncidentCard(CARD, {
      botToken: 'xoxb-fake',
      channel: '#nope',
      messageIdentity: 'audit-1:corr-1',
      fetchImpl,
    });
    expect(result.posted).toBe(false);
    expect(result.reason).toContain('channel_not_found');
  });

  it('degrades to posted:false on a non-2xx HTTP response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const result = await postIncidentCard(CARD, {
      botToken: 'xoxb-fake',
      channel: '#incidents',
      messageIdentity: 'audit-1:corr-1',
      fetchImpl,
    });
    expect(result.posted).toBe(false);
    expect(result.reason).toContain('503');
  });

  it('degrades to posted:false (never throws) on a network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      postIncidentCard(CARD, {
        botToken: 'xoxb-fake',
        channel: '#incidents',
        messageIdentity: 'audit-1:corr-1',
        fetchImpl,
      }),
    ).resolves.toEqual({ posted: false, reason: 'Slack post failed: ECONNREFUSED' });
  });

  it('derives the same bounded provider id for retries and a different id for another audit', () => {
    const first = deriveSlackClientMessageId('audit-1:corr-1');
    expect(deriveSlackClientMessageId('audit-1:corr-1')).toBe(first);
    expect(deriveSlackClientMessageId('audit-2:corr-1')).not.toBe(first);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first).toHaveLength(36);
    expect(() => deriveSlackClientMessageId('x'.repeat(501))).toThrow(
      /between 1 and 500/,
    );
  });
});

describe('openResumeModal', () => {
  const VIEW = { type: 'modal', callback_id: 'fuse_resume_submit' };

  it('does not touch the network when no bot token is configured', async () => {
    const fetchImpl = vi.fn();
    const result = await openResumeModal({
      botToken: undefined,
      triggerId: 't1',
      view: VIEW,
      fetchImpl,
    });
    expect(result).toEqual({
      opened: false,
      reason: 'no Slack bot token configured (SLACK_BOT_TOKEN unset)',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('calls views.open with the trigger_id and view when configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const result = await openResumeModal({
      botToken: 'xoxb-fake',
      triggerId: 'trigger-123',
      view: VIEW,
      fetchImpl,
    });
    expect(result).toEqual({ opened: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://slack.com/api/views.open',
      expect.objectContaining({ method: 'POST' }),
    );
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ trigger_id: 'trigger-123', view: VIEW });
  });

  it('degrades to opened:false (never throws) on a Slack API-level error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error: 'expired_trigger_id' }));
    const result = await openResumeModal({
      botToken: 'xoxb-fake',
      triggerId: 'stale',
      view: VIEW,
      fetchImpl,
    });
    expect(result.opened).toBe(false);
    expect(result.reason).toContain('expired_trigger_id');
  });

  it('degrades to opened:false (never throws) on a network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      openResumeModal({ botToken: 'xoxb-fake', triggerId: 't1', view: VIEW, fetchImpl }),
    ).resolves.toEqual({ opened: false, reason: 'views.open failed: ECONNREFUSED' });
  });
});
