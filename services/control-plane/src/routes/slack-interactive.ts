import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  buildResumeReasonModalView,
  executeAuthorizedResume,
  isFreshSlackTimestamp,
  openResumeModal,
  parseResumeSubmission,
  verifySlackSignature,
} from '@fuse/diagnosis';
import type { DiagnosisWorkerConfig } from '../diagnosis-worker.js';

interface SlackInteractivePayload {
  type?: string;
  trigger_id?: string;
  actions?: Array<{ action_id?: string; value?: string }>;
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
    const payload = parsed as SlackInteractivePayload;

    if (payload.type === 'block_actions') {
      const action = payload.actions?.[0];
      const triggerId = payload.trigger_id;
      if (action?.action_id === 'fuse_resume' && action.value && triggerId) {
        // Fire-and-forget within Slack's ~3s ack window — the ack itself
        // (the empty 200 below) is what Slack actually waits on.
        void openResumeModal({
          botToken: config.slackBotToken,
          triggerId,
          view: buildResumeReasonModalView(action.value),
        });
      }
      return reply.code(200).send();
    }

    if (payload.type === 'view_submission') {
      const submission = parseResumeSubmission(
        parsed as Parameters<typeof parseResumeSubmission>[0],
      );
      if (!submission) {
        return reply.code(200).send({
          response_action: 'errors',
          errors: { reason_block: 'Missing or malformed submission' },
        });
      }
      const result = await executeAuthorizedResume(submission, {
        controlPlaneUrl,
        operatorToken: config.operatorToken ?? '',
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
