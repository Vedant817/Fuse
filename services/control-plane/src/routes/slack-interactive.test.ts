import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosisWorkerConfig } from '../diagnosis-worker.js';
import { registerSlackInteractiveRoute } from './slack-interactive.js';

const openResumeModal = vi.fn();
const executeAuthorizedResume = vi.fn();

vi.mock('@fuse/diagnosis', async () => {
  const actual =
    await vi.importActual<typeof import('@fuse/diagnosis')>('@fuse/diagnosis');
  return {
    ...actual,
    openResumeModal: (...args: unknown[]) => openResumeModal(...args),
    executeAuthorizedResume: (...args: unknown[]) => executeAuthorizedResume(...args),
  };
});

const SIGNING_SECRET = 'test-signing-secret';
const CONTROL_PLANE_URL = 'http://127.0.0.1:8090';
const DEFAULT_SCOPE = { tenant: 't1', environment: 'prod', agentId: 'agent-1' };

function privateMetadata(
  scope = DEFAULT_SCOPE,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    version: 1,
    scope,
    expectedEpoch: 7,
    correlationId: 'incident-1',
    ...overrides,
  });
}

function sign(timestamp: string, rawBody: string): string {
  return (
    'v0=' +
    createHmac('sha256', SIGNING_SECRET)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest('hex')
  );
}

function buildApp(configOverrides: Partial<DiagnosisWorkerConfig> = {}) {
  const app = Fastify();
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  );
  const config: DiagnosisWorkerConfig = {
    mcpServerUrl: undefined,
    slackBotToken: 'xoxb-fake',
    slackChannel: '#x',
    localSnapshotDir: '/tmp/unused',
    slackSigningSecret: SIGNING_SECRET,
    slackAuthorizedUserIds: ['U123'],
    slackTeamId: 'T123',
    operatorToken: 'op-token',
    ...configOverrides,
  };
  registerSlackInteractiveRoute(app, config, CONTROL_PLANE_URL);
  return app;
}

function post(
  app: ReturnType<typeof buildApp>,
  rawBody: string,
  headers: Record<string, string>,
) {
  return app.inject({
    method: 'POST',
    url: '/v1/slack/interactive',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    payload: rawBody,
  });
}

describe('registerSlackInteractiveRoute', () => {
  beforeEach(() => {
    openResumeModal.mockReset();
    executeAuthorizedResume.mockReset();
  });

  it('rejects a request with no signing secret configured (fail-closed)', async () => {
    const app = buildApp({ slackSigningSecret: undefined });
    await app.ready();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = 'payload=%7B%7D';
    const res = await post(app, rawBody, {
      'x-slack-signature': sign(timestamp, rawBody),
      'x-slack-request-timestamp': timestamp,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a request with a missing/invalid signature', async () => {
    const app = buildApp();
    await app.ready();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await post(app, 'payload=%7B%7D', {
      'x-slack-signature': 'v0=deadbeef',
      'x-slack-request-timestamp': timestamp,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a stale timestamp even with a technically-valid signature for it', async () => {
    const app = buildApp();
    await app.ready();
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600); // 10 min old
    const rawBody = 'payload=%7B%7D';
    const res = await post(app, rawBody, {
      'x-slack-signature': sign(staleTimestamp, rawBody),
      'x-slack-request-timestamp': staleTimestamp,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('opens the resume modal on a verified fuse_resume block_actions click', async () => {
    openResumeModal.mockResolvedValue({ opened: true });
    const app = buildApp();
    await app.ready();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyObj = {
      type: 'block_actions',
      user: { id: 'U123' },
      team: { id: 'T123' },
      trigger_id: 'trigger-123',
      actions: [{ action_id: 'fuse_resume', value: privateMetadata() }],
    };
    const rawBody = `payload=${encodeURIComponent(JSON.stringify(bodyObj))}`;
    const res = await post(app, rawBody, {
      'x-slack-signature': sign(timestamp, rawBody),
      'x-slack-request-timestamp': timestamp,
    });
    expect(res.statusCode).toBe(200);
    expect(openResumeModal).toHaveBeenCalledOnce();
    const [args] = openResumeModal.mock.calls[0]!;
    expect(args).toMatchObject({ triggerId: 'trigger-123', botToken: 'xoxb-fake' });
    await app.close();
  });

  it('ignores an unrecognized block_actions action_id without opening a modal', async () => {
    const app = buildApp();
    await app.ready();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyObj = {
      type: 'block_actions',
      user: { id: 'U123' },
      team: { id: 'T123' },
      trigger_id: 'trigger-123',
      actions: [{ action_id: 'something_else', value: 'x' }],
    };
    const rawBody = `payload=${encodeURIComponent(JSON.stringify(bodyObj))}`;
    const res = await post(app, rawBody, {
      'x-slack-signature': sign(timestamp, rawBody),
      'x-slack-request-timestamp': timestamp,
    });
    expect(res.statusCode).toBe(200);
    expect(openResumeModal).not.toHaveBeenCalled();
    await app.close();
  });

  it('executes an authorized resume on a verified view_submission', async () => {
    executeAuthorizedResume.mockResolvedValue({ resumed: true, state: 'armed' });
    const app = buildApp();
    await app.ready();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyObj = {
      type: 'view_submission',
      user: { id: 'U123' },
      team: { id: 'T123' },
      view: {
        id: 'V123',
        private_metadata: privateMetadata(),
        state: { values: { reason_block: { reason_input: { value: 'verified fix' } } } },
      },
    };
    const rawBody = `payload=${encodeURIComponent(JSON.stringify(bodyObj))}`;
    const res = await post(app, rawBody, {
      'x-slack-signature': sign(timestamp, rawBody),
      'x-slack-request-timestamp': timestamp,
    });
    expect(res.statusCode).toBe(200);
    expect(executeAuthorizedResume).toHaveBeenCalledOnce();
    const [submission, options] = executeAuthorizedResume.mock.calls[0]!;
    expect(submission).toMatchObject({
      reason: 'verified fix',
      slackUserId: 'U123',
      slackTeamId: 'T123',
      expectedEpoch: 7,
      correlationId: 'incident-1',
    });
    expect(options).toMatchObject({
      controlPlaneUrl: CONTROL_PLANE_URL,
      operatorToken: 'op-token',
    });
    await app.close();
  });

  it('uses the token bound to the submitted incident tenant', async () => {
    executeAuthorizedResume.mockResolvedValue({ resumed: true, state: 'armed' });
    const app = buildApp({
      operatorToken: undefined,
      operatorTokens: [
        { tenant: 'tenant-a', token: 'token-for-a' },
        { tenant: 'tenant-b', token: 'token-for-b' },
      ],
    });
    await app.ready();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyObj = {
      type: 'view_submission',
      user: { id: 'U123' },
      team: { id: 'T123' },
      view: {
        id: 'V123',
        private_metadata: privateMetadata({
          tenant: 'tenant-b',
          environment: 'prod',
          agentId: 'agent-1',
        }),
        state: { values: { reason_block: { reason_input: { value: 'fixed' } } } },
      },
    };
    const rawBody = `payload=${encodeURIComponent(JSON.stringify(bodyObj))}`;
    const res = await post(app, rawBody, {
      'x-slack-signature': sign(timestamp, rawBody),
      'x-slack-request-timestamp': timestamp,
    });

    expect(res.statusCode).toBe(200);
    expect(executeAuthorizedResume).toHaveBeenCalledWith(
      expect.objectContaining({ scope: expect.objectContaining({ tenant: 'tenant-b' }) }),
      expect.objectContaining({ operatorToken: 'token-for-b' }),
    );
    await app.close();
  });

  it('fails closed when no operator token matches the submitted tenant', async () => {
    const app = buildApp({
      operatorToken: undefined,
      operatorTokens: [{ tenant: 'tenant-a', token: 'token-for-a' }],
    });
    await app.ready();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyObj = {
      type: 'view_submission',
      user: { id: 'U123' },
      team: { id: 'T123' },
      view: {
        id: 'V123',
        private_metadata: privateMetadata({
          tenant: 'tenant-b',
          environment: 'prod',
          agentId: 'agent-1',
        }),
        state: { values: { reason_block: { reason_input: { value: 'fixed' } } } },
      },
    };
    const rawBody = `payload=${encodeURIComponent(JSON.stringify(bodyObj))}`;
    const res = await post(app, rawBody, {
      'x-slack-signature': sign(timestamp, rawBody),
      'x-slack-request-timestamp': timestamp,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ response_action: 'errors' });
    expect(executeAuthorizedResume).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns a Slack modal error response when the resume call fails', async () => {
    executeAuthorizedResume.mockResolvedValue({
      resumed: false,
      reason: 'cooldown_active',
    });
    const app = buildApp();
    await app.ready();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyObj = {
      type: 'view_submission',
      user: { id: 'U123' },
      team: { id: 'T123' },
      view: {
        id: 'V123',
        private_metadata: privateMetadata(),
        state: { values: { reason_block: { reason_input: { value: 'x' } } } },
      },
    };
    const rawBody = `payload=${encodeURIComponent(JSON.stringify(bodyObj))}`;
    const res = await post(app, rawBody, {
      'x-slack-signature': sign(timestamp, rawBody),
      'x-slack-request-timestamp': timestamp,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ response_action: 'errors' });
    await app.close();
  });

  it('never resumes anything on a malformed (unverifiable) view_submission', async () => {
    const app = buildApp();
    await app.ready();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = `payload=${encodeURIComponent(
      JSON.stringify({
        type: 'view_submission',
        user: { id: 'U123' },
        team: { id: 'T123' },
        view: {
          id: 'V123',
          private_metadata: '{not-json',
          state: {
            values: { reason_block: { reason_input: { value: 'fixed' } } },
          },
        },
      }),
    )}`;
    const res = await post(app, rawBody, {
      'x-slack-signature': sign(timestamp, rawBody),
      'x-slack-request-timestamp': timestamp,
    });
    expect(res.statusCode).toBe(200);
    expect(executeAuthorizedResume).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['button user', 'block_actions', { user: { id: 'U999' }, team: { id: 'T123' } }],
    ['button team', 'block_actions', { user: { id: 'U123' }, team: { id: 'T999' } }],
    ['modal user', 'view_submission', { user: { id: 'U999' }, team: { id: 'T123' } }],
    ['modal team', 'view_submission', { user: { id: 'U123' }, team: { id: 'T999' } }],
  ])(
    'rejects an unauthorized %s before any privileged action',
    async (_name, type, actor) => {
      const app = buildApp();
      await app.ready();
      const timestamp = String(Math.floor(Date.now() / 1000));
      const bodyObj =
        type === 'block_actions'
          ? {
              type,
              ...actor,
              trigger_id: 'trigger-123',
              actions: [{ action_id: 'fuse_resume', value: privateMetadata() }],
            }
          : {
              type,
              ...actor,
              view: {
                id: 'V123',
                private_metadata: privateMetadata(),
                state: {
                  values: { reason_block: { reason_input: { value: 'fixed' } } },
                },
              },
            };
      const rawBody = `payload=${encodeURIComponent(JSON.stringify(bodyObj))}`;
      const res = await post(app, rawBody, {
        'x-slack-signature': sign(timestamp, rawBody),
        'x-slack-request-timestamp': timestamp,
      });

      expect(res.statusCode).toBe(403);
      expect(openResumeModal).not.toHaveBeenCalled();
      expect(executeAuthorizedResume).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it('rejects malformed button metadata without opening a modal', async () => {
    const app = buildApp();
    await app.ready();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyObj = {
      type: 'block_actions',
      user: { id: 'U123' },
      team: { id: 'T123' },
      trigger_id: 'trigger-123',
      actions: [{ action_id: 'fuse_resume', value: '{not-json' }],
    };
    const rawBody = `payload=${encodeURIComponent(JSON.stringify(bodyObj))}`;
    const res = await post(app, rawBody, {
      'x-slack-signature': sign(timestamp, rawBody),
      'x-slack-request-timestamp': timestamp,
    });

    expect(res.statusCode).toBe(400);
    expect(openResumeModal).not.toHaveBeenCalled();
    await app.close();
  });
});
