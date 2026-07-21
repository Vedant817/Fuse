import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type pg from 'pg';
import { FuseHttpError } from '@fuse/contracts';
import type { BreakerStore } from '@fuse/breaker-store';
import type { ControlPlaneConfig } from './config.js';
import { requireBearerAuth } from './auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPermitRoute } from './routes/permit.js';
import { registerBreakerRoutes } from './routes/breaker.js';
import { registerWebhookRoutes } from './routes/webhook.js';

const MAX_BODY_BYTES = 64 * 1024;

export interface BuildAppDeps {
  store: BreakerStore;
  pool: pg.Pool;
  config: ControlPlaneConfig;
}

export async function buildApp(deps: BuildAppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: deps.config.logLevel },
    bodyLimit: MAX_BODY_BYTES,
    trustProxy: false,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    // Authenticated callers are scoped per-token; unauthenticated ones
    // (health checks) are rate-limited per IP by the plugin default.
    keyGenerator: (request) => {
      const auth = request.headers.authorization;
      return auth ?? request.ip;
    },
  });

  registerHealthRoutes(app, deps.pool);

  const operatorTokens = deps.config.apiTokens;
  const webhookAllowedTokens = [...deps.config.apiTokens, ...deps.config.webhookTokens];
  const allKnownTokens = [
    ...deps.config.apiTokens,
    ...deps.config.agentApiTokens,
    ...deps.config.webhookTokens,
  ];

  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/v1/permit')) {
      // Any known token (operator or agent-scoped) may check a permit.
      await requireBearerAuth(allKnownTokens, allKnownTokens)(request, reply);
    } else if (request.url.startsWith('/v1/webhooks/')) {
      // The SigNoz alert webhook — its own least-privilege tier: this
      // token can only cause a trip for the scope named in an alert's own
      // labels, never resume/disable/force-trip arbitrarily.
      await requireBearerAuth(webhookAllowedTokens, allKnownTokens)(request, reply);
    } else if (request.url.startsWith('/v1/breaker/')) {
      // Force-trip/resume/disable/enable/status require an operator token;
      // an agent-scoped or webhook-scoped token is a valid credential but
      // gets 403, not a silent pass — see auth.ts for why that distinction
      // matters.
      await requireBearerAuth(operatorTokens, allKnownTokens)(request, reply);
    }
  });

  registerPermitRoute(app, deps.store, deps.config.storeOutageMode);
  registerBreakerRoutes(app, deps.store);
  registerWebhookRoutes(app, deps.store, deps.config);

  app.setErrorHandler((err, request, reply) => {
    if (reply.sent) return;
    const correlationId = request.id;
    if (err instanceof FuseHttpError) {
      reply.code(err.httpStatus).send(err.toBody());
      return;
    }
    request.log.error({ err }, 'unhandled error');
    const httpErr = new FuseHttpError(
      'internal_error',
      'internal error',
      500,
      correlationId,
    );
    reply.code(httpErr.httpStatus).send(httpErr.toBody());
  });

  return app;
}
