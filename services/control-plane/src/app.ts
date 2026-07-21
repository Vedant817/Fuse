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

  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/v1/')) {
      await requireBearerAuth(deps.config.apiTokens)(request, reply);
    }
  });

  registerPermitRoute(app, deps.store, deps.config.storeOutageMode);
  registerBreakerRoutes(app, deps.store);

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
