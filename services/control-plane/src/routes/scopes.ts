import type { FastifyInstance, FastifyRequest } from 'fastify';
import { FuseHttpError, RegisterScopeRequestSchema } from '@fuse/contracts';
import {
  ScopeCapacityExceededError,
  StoreUnavailableError,
  type BreakerStore,
} from '@fuse/breaker-store';

function correlationIdOf(request: FastifyRequest): string {
  const header = request.headers['x-correlation-id'];
  return typeof header === 'string' && header.length > 0 ? header : request.id;
}

/**
 * Registers the finite set of scope label tuples agents may use. The app
 * layer must protect `/v1/scopes/*` with operator-only bearer auth and tenant
 * extraction before registering this route.
 */
export function registerScopeRoutes(app: FastifyInstance, store: BreakerStore): void {
  app.post('/v1/scopes/register', async (request, reply) => {
    const correlationId = correlationIdOf(request);
    const parsed = RegisterScopeRequestSchema.safeParse(request.body);
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
      const result = await store.registerScope(parsed.data);
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (err) {
      if (err instanceof ScopeCapacityExceededError) {
        const httpErr = new FuseHttpError(
          'scope_capacity_exceeded',
          err.message,
          409,
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
      throw err;
    }
  });
}
