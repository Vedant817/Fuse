import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  buildResumeReasonModalView,
  executeAuthorizedResume,
  isFreshSlackTimestamp,
  openResumeModal,
  parseResumeSubmission,
  verifySlackSignature,
} from '@fuse/diagnosis';
import {
  selectOperatorTokenForTenant,
  type DiagnosisWorkerConfig,
} from '../diagnosis-worker.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuthorizedSlackActor(
  payload: Record<string, unknown>,
  config: DiagnosisWorkerConfig,
): boolean {
  const user = payload['user'];
  if (!isRecord(user) || typeof user['id'] !== 'string') return false;
  if (!config.slackAuthorizedUserIds.includes(user['id'])) return false;

  if (config.slackTeamId) {
    const team = payload['team'];
    if (!isRecord(team) || team['id'] !== config.slackTeamId) return false;
  }
  return true;
}

function correlationIdOf(request: FastifyRequest): string {
  const header = request.headers['x-correlation-id'];
  return typeof header === 'string' && header.length > 0 ? header : request.id;
}

/**
 * Receives Slack's interactive payload (button click -> open the resume
 * modal; modal submit -> execute the resume) — task.md §7.3. Slack's own
 * HMAC signature (`X-Slack-Signature` + `X-Slack-Request-Timestamp`) IS
 * the authentication for this route, not a bearer token: it is registered
 * in `app.ts`'s preHandler hook as a route that skips the normal token
 * check entirely, matching how the SigNoz webhook has its own separate
 * trust tier rather than reusing the operator/agent tiers.
 *
 * Fail-closed by design: unlike outbound Slack posting (which degrades
 * silently when unconfigured, since a missing post can't hurt
 * enforcement), an *inbound* unverified request here could trigger a real
 * `/v1/breaker/resume` call — so a missing signing secret, a missing/
 * invalid signature, or a stale timestamp all reject with 401, never a
 * silent no-op-as-if-verified.
 */
export function registerSlackInteractiveRoute(
  app: FastifyInstance,
  config: DiagnosisWorkerConfig,
  controlPlaneUrl: string,
): void {
  app.post('/v1/slack/interactive', async (request, reply) => {
    const correlationId = correlationIdOf(request);
    const rawBody = typeof request.body === 'string' ? request.body : '';
    const signature = request.headers['x-slack-signature'];
    const timestamp = request.headers['x-slack-request-timestamp'];

    if (
      !config.slackSigningSecret ||
      typeof signature !== 'string' ||
      typeof timestamp !== 'string' ||
      !isFreshSlackTimestamp(timestamp) ||
      !verifySlackSignature({
        signingSecret: config.slackSigningSecret,
        timestamp,
        rawBody,
        signature,
      })
    ) {
      return reply.code(401).send({ error: 'unauthenticated', correlationId });
    }

    const params = new URLSearchParams(rawBody);
    const payloadRaw = params.get('payload');
    if (!payloadRaw) {
      return reply.code(400).send({ error: 'invalid_request', correlationId });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadRaw);
    } catch {
      return reply.code(400).send({ error: 'invalid_request', correlationId });
    }
    if (!isRecord(parsed)) {
      return reply.code(400).send({ error: 'invalid_request', correlationId });
    }
    const payload = parsed;

    if (
      (payload['type'] === 'block_actions' || payload['type'] === 'view_submission') &&
      !isAuthorizedSlackActor(payload, config)
    ) {
      return reply.code(403).send({ error: 'forbidden', correlationId });
    }

    if (payload['type'] === 'block_actions') {
      const actions = payload['actions'];
      const action =
        Array.isArray(actions) && isRecord(actions[0]) ? actions[0] : undefined;
      const triggerId = payload['trigger_id'];
      if (
        action?.['action_id'] === 'fuse_resume' &&
        typeof action['value'] === 'string' &&
        typeof triggerId === 'string'
      ) {
        const view = buildResumeReasonModalView(action['value']);
        if (!view) {
          return reply.code(400).send({ error: 'invalid_request', correlationId });
        }
        // Fire-and-forget within Slack's ~3s ack window — the ack itself
        // (the empty 200 below) is what Slack actually waits on.
        void openResumeModal({
          botToken: config.slackBotToken,
          triggerId,
          view,
        }).then((result) => {
          if (result.opened) {
            request.log.info({ correlationId }, 'Slack resume modal opened');
          } else {
            request.log.warn(
              { correlationId, reason: result.reason },
              'Slack resume modal not opened',
            );
          }
        });
      }
      return reply.code(200).send();
    }

    if (payload['type'] === 'view_submission') {
      const submission = parseResumeSubmission(parsed);
      if (!submission) {
        return reply.code(200).send({
          response_action: 'errors',
          errors: { reason_block: 'Missing or malformed submission' },
        });
      }
      const operatorToken = selectOperatorTokenForTenant(config, submission.scope.tenant);
      if (!operatorToken) {
        return reply.code(200).send({
          response_action: 'errors',
          errors: {
            reason_block: 'No operator credential is configured for this incident tenant',
          },
        });
      }
      const result = await executeAuthorizedResume(submission, {
        controlPlaneUrl,
        operatorToken,
      });
      if (!result.resumed) {
        return reply.code(200).send({
          response_action: 'errors',
          errors: { reason_block: result.reason ?? 'Resume failed' },
        });
      }
      return reply.code(200).send();
    }

    return reply.code(200).send();
  });
}
