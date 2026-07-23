import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  FuseHttpError,
  PreflightReportRequestSchema,
  ScopeSchema,
} from '@fuse/contracts';
import {
  StoreUnavailableError,
  UnknownScopeError,
  type PreflightStore,
} from '@fuse/breaker-store';
import type { PreflightEvaluatorConfig } from '@fuse/preflight';
import { getPreflightStateGauge } from '@fuse/otel';

function correlationIdOf(request: FastifyRequest): string {
  const header = request.headers['x-correlation-id'];
  return typeof header === 'string' && header.length > 0 ? header : request.id;
}

function handleStoreError(
  err: unknown,
  correlationId: string,
  reply: FastifyReply,
): FastifyReply | never {
  if (err instanceof StoreUnavailableError) {
    const httpErr = new FuseHttpError(
      'store_unavailable',
      'preflight store is unreachable',
      503,
      correlationId,
    );
    return reply.code(httpErr.httpStatus).send(httpErr.toBody());
  }
  if (err instanceof UnknownScopeError) {
    const httpErr = new FuseHttpError('unknown_scope', err.message, 404, correlationId);
    return reply.code(httpErr.httpStatus).send(httpErr.toBody());
  }
  throw err;
}

export function registerPreflightRoutes(
  app: FastifyInstance,
  store: PreflightStore,
  config: PreflightEvaluatorConfig,
): void {
  app.post('/v1/preflight/report', async (request, reply) => {
    const correlationId = correlationIdOf(request);
    const parsed = PreflightReportRequestSchema.safeParse(request.body);
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
      const result = await store.evaluate({
        scope: parsed.data.scope,
        spans: parsed.data.spans,
        heartbeat: parsed.data.heartbeat,
        config,
        disabled: parsed.data.disabled,
        disabledReason: parsed.data.disabledReason,
      });
      // Recorded here, not client-side in the SDK's PreflightReporter — the
      // same "authoritative decision point" reasoning as the breaker
      // permit-decision counter (routes/permit.ts): this evaluation is the
      // one place a scope's Preflight state is actually committed,
      // network-wide across every reporting caller.
      getPreflightStateGauge().record(1, {
        'fuse.tenant': parsed.data.scope.tenant,
        'fuse.environment': parsed.data.scope.environment,
        'fuse.agent_id': parsed.data.scope.agentId,
        'fuse.preflight.state': result.state,
      });
      return reply.code(200).send({ result });
    } catch (err) {
      return handleStoreError(err, correlationId, reply);
    }
  });

  app.get('/v1/preflight/status', async (request, reply) => {
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
      const result = await store.getResult(parsed.data);
      if (!result) {
        const err = new FuseHttpError(
          'unknown_scope',
          'no Preflight evaluation has ever been reported for this scope',
          404,
          correlationId,
        );
        return reply.code(err.httpStatus).send(err.toBody());
      }
      return reply.code(200).send({ result });
    } catch (err) {
      return handleStoreError(err, correlationId, reply);
    }
  });
}
