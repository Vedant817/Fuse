import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildResumeReasonModalView,
  executeAuthorizedResume,
  isFreshSlackTimestamp,
  parseResumeSubmission,
  verifySlackSignature,
} from './slack-actions.js';

const SIGNING_SECRET = 'test-signing-secret';

function sign(timestamp: string, rawBody: string): string {
  return (
    'v0=' +
    createHmac('sha256', SIGNING_SECRET)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest('hex')
  );
}

describe('verifySlackSignature', () => {
  it('accepts a correctly-signed request', () => {
    const timestamp = '1700000000';
    const rawBody = 'payload=%7B%22type%22%3A%22...%22%7D';
    const signature = sign(timestamp, rawBody);
    expect(
      verifySlackSignature({
        signingSecret: SIGNING_SECRET,
        timestamp,
        rawBody,
        signature,
      }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    const timestamp = '1700000000';
    const signature = sign(timestamp, 'original-body');
    expect(
      verifySlackSignature({
        signingSecret: SIGNING_SECRET,
        timestamp,
        rawBody: 'tampered-body',
        signature,
      }),
    ).toBe(false);
  });

  it('rejects a signature produced with the wrong signing secret', () => {
    const timestamp = '1700000000';
    const rawBody = 'body';
    const wrongSignature =
      'v0=' +
      createHmac('sha256', 'wrong-secret')
        .update(`v0:${timestamp}:${rawBody}`)
        .digest('hex');
    expect(
      verifySlackSignature({
        signingSecret: SIGNING_SECRET,
        timestamp,
        rawBody,
        signature: wrongSignature,
      }),
    ).toBe(false);
  });

  it('rejects a signature of a different length without throwing', () => {
    expect(
      verifySlackSignature({
        signingSecret: SIGNING_SECRET,
        timestamp: '1700000000',
        rawBody: 'body',
        signature: 'v0=short',
      }),
    ).toBe(false);
  });
});

describe('isFreshSlackTimestamp', () => {
  it('accepts a timestamp within the skew window', () => {
    const now = new Date('2026-07-23T00:05:00.000Z');
    const tsSeconds = Math.floor(new Date('2026-07-23T00:03:00.000Z').getTime() / 1000);
    expect(isFreshSlackTimestamp(String(tsSeconds), now)).toBe(true);
  });

  it('rejects a stale (replayed) timestamp', () => {
    const now = new Date('2026-07-23T00:20:00.000Z');
    const tsSeconds = Math.floor(new Date('2026-07-23T00:00:00.000Z').getTime() / 1000);
    expect(isFreshSlackTimestamp(String(tsSeconds), now)).toBe(false);
  });

  it('rejects a non-numeric timestamp fail-closed', () => {
    expect(isFreshSlackTimestamp('not-a-number')).toBe(false);
  });
});

describe('buildResumeReasonModalView', () => {
  it('requires a reason input and round-trips the scope via private_metadata', () => {
    const scopeValue = JSON.stringify({
      tenant: 't1',
      environment: 'prod',
      agentId: 'a1',
    });
    const view = buildResumeReasonModalView(scopeValue);
    expect(view['private_metadata']).toBe(scopeValue);
    expect(JSON.stringify(view)).toContain('reason_input');
  });
});

describe('parseResumeSubmission', () => {
  const scope = { tenant: 't1', environment: 'prod', agentId: 'a1' };

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      type: 'view_submission',
      user: { id: 'U123' },
      view: {
        id: 'V456',
        private_metadata: JSON.stringify(scope),
        state: {
          values: {
            reason_block: { reason_input: { value: 'investigated, safe to resume' } },
          },
        },
      },
      ...overrides,
    };
  }

  it('parses a well-formed submission', () => {
    const parsed = parseResumeSubmission(payload());
    expect(parsed).toEqual({
      scope,
      reason: 'investigated, safe to resume',
      slackUserId: 'U123',
      viewId: 'V456',
    });
  });

  it('returns undefined (not throw) for a non-view_submission payload', () => {
    expect(parseResumeSubmission(payload({ type: 'block_actions' }))).toBeUndefined();
  });

  it('returns undefined when the reason is empty', () => {
    const p = payload();
    p.view.state!.values!['reason_block']!['reason_input']!.value = '   ';
    expect(parseResumeSubmission(p)).toBeUndefined();
  });

  it('returns undefined when private_metadata is not valid scope JSON', () => {
    expect(
      parseResumeSubmission(
        payload({ view: { id: 'V1', private_metadata: 'not-json' } }),
      ),
    ).toBeUndefined();
  });
});

describe('executeAuthorizedResume', () => {
  const submission = {
    scope: { tenant: 't1', environment: 'prod', agentId: 'a1' },
    reason: 'safe to resume',
    slackUserId: 'U123',
    viewId: 'V456',
  };

  it('calls the real resume endpoint with a manual actor and Slack-derived idempotency key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ record: { state: 'armed' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await executeAuthorizedResume(submission, {
      controlPlaneUrl: 'http://cp.internal',
      operatorToken: 'op-token',
      fetchImpl,
    });
    expect(result).toEqual({ resumed: true, state: 'armed' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://cp.internal/v1/breaker/resume');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.actor).toEqual({ type: 'manual', id: 'slack:U123' });
    expect(body.idempotencyKey).toBe('slack-resume-V456');
    expect(body.reason).toBe('safe to resume');
  });

  it('reports a stale-epoch/conflict style error without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'cooldown_active', message: 'cooldown still active' }),
        {
          status: 409,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const result = await executeAuthorizedResume(submission, {
      controlPlaneUrl: 'http://cp.internal',
      operatorToken: 'op-token',
      fetchImpl,
    });
    expect(result.resumed).toBe(false);
    expect(result.reason).toContain('cooldown');
  });

  it('degrades to resumed:false (never throws) on a network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await executeAuthorizedResume(submission, {
      controlPlaneUrl: 'http://cp.internal',
      operatorToken: 'op-token',
      fetchImpl,
    });
    expect(result.resumed).toBe(false);
    expect(result.reason).toContain('ECONNREFUSED');
  });
});
