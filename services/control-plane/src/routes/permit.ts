import type { FastifyInstance, FastifyRequest } from 'fastify';
import { FuseHttpError, PermitRequestSchema, type OutageMode } from '@fuse/contracts';
import { StoreUnavailableError, type BreakerStore } from '@fuse/breaker-store';

function correlationIdOf(request: FastifyRequest): string {
  const header = request.headers['x-correlation-id'];
  return typeof header === 'string' && header.length > 0 ? header : request.id;
}

export function registerPermitRoute(
  app: FastifyInstance,
  store: BreakerStore,
  storeOutageMode: OutageMode,
): void {
  app.post('/v1/permit', async (request, reply) => {
    const correlationId = correlationIdOf(request);
    const parsed = PermitRequestSchema.safeParse(request.body);
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
      const result = await store.permit(parsed.data.scope, parsed.data.correlationId);
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof StoreUnavailableError) {
        request.log.error(
          { err, scope: parsed.data.scope },
          'store unavailable during permit check',
        );
        const allowed = storeOutageMode === 'fail-open';
        return reply.code(200).send({
          allowed,
          state: 'unknown',
          reason: `store unavailable: applying configured outage mode (${storeOutageMode})`,
          epoch: -1,
          degraded: true,
          correlationId: parsed.data.correlationId,
        });
      }
      throw err;
    }
  });
}
