import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  FuseHttpError,
  PermitRequestSchema,
  type OutageMode,
  type PermitResponse,
  type Scope,
} from '@fuse/contracts';
import { StoreUnavailableError, type BreakerStore } from '@fuse/breaker-store';
import { getBreakerDecisionCounter } from '@fuse/otel';

function correlationIdOf(request: FastifyRequest): string {
  const header = request.headers['x-correlation-id'];
  return typeof header === 'string' && header.length > 0 ? header : request.id;
}

/** Every real permit decision, network-wide across every SDK/agent caller
 * — the actual dimension `fuse.breaker.permit.decisions`'s own doc comment
 * (packages/otel/src/metrics.ts) promises, recorded where the decision is
 * actually authoritative (this route), not client-side per SDK instance. */
function recordDecision(scope: Scope, result: PermitResponse): void {
  getBreakerDecisionCounter().add(1, {
    'fuse.tenant': scope.tenant,
    'fuse.environment': scope.environment,
    'fuse.agent_id': scope.agentId,
    'fuse.breaker.state': result.state,
    'fuse.breaker.allowed': result.allowed,
    'fuse.breaker.degraded': result.degraded,
  });
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
      recordDecision(parsed.data.scope, result);
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof StoreUnavailableError) {
        request.log.error(
          { err, scope: parsed.data.scope },
          'store unavailable during permit check',
        );
        const allowed = storeOutageMode === 'fail-open';
        const degradedResult: PermitResponse = {
          allowed,
          state: 'unknown',
          reason: `store unavailable: applying configured outage mode (${storeOutageMode})`,
          epoch: -1,
          degraded: true,
          correlationId: parsed.data.correlationId,
        };
        recordDecision(parsed.data.scope, degradedResult);
        return reply.code(200).send(degradedResult);
      }
      throw err;
    }
  });
}
