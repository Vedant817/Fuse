import type { FastifyInstance, FastifyRequest } from 'fastify';
import { FuseHttpError, ScopeSchema } from '@fuse/contracts';
import {
  StoreUnavailableError,
  UnknownScopeError,
  type BreakerStore,
} from '@fuse/breaker-store';
import type { ResolvedDetectorPolicy } from '../policy-loader.js';

function correlationIdOf(request: FastifyRequest): string {
  const header = request.headers['x-correlation-id'];
  return typeof header === 'string' && header.length > 0 ? header : request.id;
}

/** Operator read path for the exact detector policy loaded for a scope. */
export function registerPolicyRoutes(
  app: FastifyInstance,
  store: BreakerStore,
  resolvePolicy: (scope: {
    tenant: string;
    environment: string;
    agentId: string;
  }) => ResolvedDetectorPolicy,
): void {
  app.get('/v1/policies/effective', async (request, reply) => {
    const correlationId = correlationIdOf(request);
    const parsed = ScopeSchema.safeParse(request.query);
    if (!parsed.success) {
      const err = new FuseHttpError(
        'invalid_request',
        parsed.error.message,
        400,
        correlationId,
      );
      return reply.code(err.httpStatus).send(err.toBody());
    }

    try {
      await store.assertScopeRegistered(parsed.data);
      return reply.code(200).send({
        scope: parsed.data,
        policy: resolvePolicy(parsed.data),
      });
    } catch (err) {
      if (err instanceof UnknownScopeError) {
        const httpErr = new FuseHttpError(
          'unknown_scope',
          'scope must be registered before its effective policy can be inspected',
          404,
          correlationId,
        );
        return reply.code(httpErr.httpStatus).send(httpErr.toBody());
      }
      if (err instanceof StoreUnavailableError) {
        const httpErr = new FuseHttpError(
          'store_unavailable',
          'scope registry is unreachable',
          503,
          correlationId,
        );
        return reply.code(httpErr.httpStatus).send(httpErr.toBody());
      }
      const httpErr = new FuseHttpError(
        'internal_error',
        'no active detector policy matches this scope',
        503,
        correlationId,
      );
      return reply.code(httpErr.httpStatus).send(httpErr.toBody());
    }
  });
}
