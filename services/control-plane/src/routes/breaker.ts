import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DisableRequestSchema,
  EnableRequestSchema,
  FuseHttpError,
  ResumeRequestSchema,
  ScopeSchema,
  TripRequestSchema,
  type FuseErrorCode,
} from '@fuse/contracts';
import {
  CasContentionExhaustedError,
  IdempotencyConflictError,
  StoreUnavailableError,
  UnknownScopeError,
  type BreakerStore,
  type TransitionResult,
} from '@fuse/breaker-store';
import type { z } from 'zod';

function correlationIdOf(request: FastifyRequest): string {
  const header = request.headers['x-correlation-id'];
  return typeof header === 'string' && header.length > 0 ? header : request.id;
}

const REJECTION_CODE: Record<
  Extract<TransitionResult, { kind: 'rejected' }>['code'],
  FuseErrorCode
> = {
  invalid_transition: 'invalid_transition',
  cooldown_active: 'cooldown_active',
  stale_epoch: 'stale_epoch',
};

async function respondWithTransition(
  reply: FastifyReply,
  correlationId: string,
  run: () => Promise<TransitionResult>,
): Promise<FastifyReply> {
  try {
    const result = await run();
    if (result.kind === 'rejected') {
      const err = new FuseHttpError(
        REJECTION_CODE[result.code],
        result.message,
        409,
        correlationId,
      );
      return reply.code(err.httpStatus).send(err.toBody());
    }
    return reply
      .code(200)
      .send({ record: result.record, auditEvent: result.auditEvent, noop: result.noop });
  } catch (err) {
    if (err instanceof UnknownScopeError) {
      const httpErr = new FuseHttpError(
        'unknown_scope',
        'scope must be registered before breaker operations are allowed',
        404,
        correlationId,
      );
      return reply.code(httpErr.httpStatus).send(httpErr.toBody());
    }
    if (err instanceof StoreUnavailableError) {
      const httpErr = new FuseHttpError(
        'store_unavailable',
        'breaker store is unreachable; mutating operations fail closed regardless of permit outage mode',
        503,
        correlationId,
      );
      return reply.code(httpErr.httpStatus).send(httpErr.toBody());
    }
    if (err instanceof IdempotencyConflictError) {
      const httpErr = new FuseHttpError(
        'idempotency_conflict',
        err.message,
        409,
        correlationId,
      );
      return reply.code(httpErr.httpStatus).send(httpErr.toBody());
    }
    if (err instanceof CasContentionExhaustedError) {
      const httpErr = new FuseHttpError(
        'contention_exhausted',
        err.message,
        409,
        correlationId,
      );
      return reply
        .header('retry-after', '1')
        .code(httpErr.httpStatus)
        .send(httpErr.toBody());
    }
    throw err;
  }
}

function parseOrReject<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown,
  correlationId: string,
  reply: FastifyReply,
): z.infer<T> | undefined {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const err = new FuseHttpError(
      'invalid_request',
      parsed.error.message,
      400,
      correlationId,
    );
    void reply.code(err.httpStatus).send(err.toBody());
    return undefined;
  }
  return parsed.data;
}

export function registerBreakerRoutes(app: FastifyInstance, store: BreakerStore): void {
  app.post('/v1/breaker/trip', async (request, reply) => {
    const correlationId = correlationIdOf(request);
    const body = parseOrReject(TripRequestSchema, request.body, correlationId, reply);
    if (!body) return reply;
    return respondWithTransition(reply, correlationId, () => store.trip(body));
  });

  app.post('/v1/breaker/resume', async (request, reply) => {
    const correlationId = correlationIdOf(request);
    const body = parseOrReject(ResumeRequestSchema, request.body, correlationId, reply);
    if (!body) return reply;
    return respondWithTransition(reply, correlationId, () => store.resume(body));
  });

  app.post('/v1/breaker/disable', async (request, reply) => {
    const correlationId = correlationIdOf(request);
    const body = parseOrReject(DisableRequestSchema, request.body, correlationId, reply);
    if (!body) return reply;
    return respondWithTransition(reply, correlationId, () => store.disable(body));
  });

  app.post('/v1/breaker/enable', async (request, reply) => {
    const correlationId = correlationIdOf(request);
    const body = parseOrReject(EnableRequestSchema, request.body, correlationId, reply);
    if (!body) return reply;
    return respondWithTransition(reply, correlationId, () => store.enable(body));
  });

  app.get('/v1/breaker/status', async (request, reply) => {
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
      const record = await store.getRecord(parsed.data);
      if (!record) {
        const err = new FuseHttpError(
          'unknown_scope',
          'no breaker has been initialized for this scope yet',
          404,
          correlationId,
        );
        return reply.code(err.httpStatus).send(err.toBody());
      }
      return reply.code(200).send({ record });
    } catch (err) {
      if (err instanceof StoreUnavailableError) {
        const httpErr = new FuseHttpError(
          'store_unavailable',
          'breaker store is unreachable',
          503,
          correlationId,
        );
        return reply.code(httpErr.httpStatus).send(httpErr.toBody());
      }
      throw err;
    }
  });
}
