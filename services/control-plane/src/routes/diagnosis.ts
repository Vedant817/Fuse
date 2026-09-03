import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ActorSchema, FuseHttpError, ScopeSchema } from '@fuse/contracts';
import {
  StoreUnavailableError,
  type DiagnosisJobCursor,
  type DiagnosisJobStore,
} from '@fuse/breaker-store';

const DiagnosisStatusSchema = z.enum(['pending', 'running', 'succeeded', 'dead-letter']);
const CursorSchema = z
  .object({
    createdAt: z.string().datetime(),
    auditEventId: z.string().uuid(),
  })
  .strict();
const ListQuerySchema = z
  .object({
    tenant: z.string().min(1).max(128),
    environment: z.string().min(1).max(64).optional(),
    agentId: z.string().min(1).max(128).optional(),
    status: DiagnosisStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
const ReplayParamsSchema = z.object({ auditEventId: z.string().uuid() }).strict();
const ReplayBodySchema = z
  .object({
    scope: ScopeSchema,
    actor: ActorSchema.extend({ type: z.literal('manual') }),
    reason: z.string().trim().min(1).max(2_000),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

function correlationIdOf(request: FastifyRequest): string {
  const header = request.headers['x-correlation-id'];
  return typeof header === 'string' && header.length > 0 ? header : request.id;
}

export function encodeDiagnosisCursor(cursor: DiagnosisJobCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeDiagnosisCursor(value: string): DiagnosisJobCursor | undefined {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const parsed = CursorSchema.safeParse(JSON.parse(decoded));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function invalidRequest(
  message: string,
  correlationId: string,
  reply: FastifyReply,
): FastifyReply {
  const error = new FuseHttpError('invalid_request', message, 400, correlationId);
  return reply.code(error.httpStatus).send(error.toBody());
}

function storeUnavailable(correlationId: string, reply: FastifyReply): FastifyReply {
  const error = new FuseHttpError(
    'store_unavailable',
    'diagnosis job store is unreachable',
    503,
    correlationId,
  );
  return reply.code(error.httpStatus).send(error.toBody());
}

/** Operator-only routes. `app.ts` owns deny-by-default authentication and
 * tenant binding before these handlers can read or mutate queue state. */
export function registerDiagnosisRoutes(
  app: FastifyInstance,
  store: DiagnosisJobStore,
): void {
  app.get('/v1/diagnosis/jobs', async (request, reply) => {
    const correlationId = correlationIdOf(request);
    const parsed = ListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return invalidRequest(parsed.error.message, correlationId, reply);
    }
    const cursor = parsed.data.cursor
      ? decodeDiagnosisCursor(parsed.data.cursor)
      : undefined;
    if (parsed.data.cursor && !cursor) {
      return invalidRequest('cursor is malformed or unsupported', correlationId, reply);
    }
    try {
      const page = await store.list({
        tenant: parsed.data.tenant,
        limit: parsed.data.limit,
        ...(parsed.data.environment ? { environment: parsed.data.environment } : {}),
        ...(parsed.data.agentId ? { agentId: parsed.data.agentId } : {}),
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(cursor ? { cursor } : {}),
      });
      return reply.code(200).send({
        jobs: page.jobs,
        nextCursor: page.nextCursor ? encodeDiagnosisCursor(page.nextCursor) : null,
      });
    } catch (error) {
      if (error instanceof StoreUnavailableError) {
        return storeUnavailable(correlationId, reply);
      }
      throw error;
    }
  });

  app.post('/v1/diagnosis/jobs/:auditEventId/replay', async (request, reply) => {
    const correlationId = correlationIdOf(request);
    const params = ReplayParamsSchema.safeParse(request.params);
    const body = ReplayBodySchema.safeParse(request.body);
    if (!params.success) {
      return invalidRequest(params.error.message, correlationId, reply);
    }
    if (!body.success) {
      return invalidRequest(body.error.message, correlationId, reply);
    }
    try {
      const result = await store.replay({
        auditEventId: params.data.auditEventId,
        ...body.data,
      });
      if (result.kind === 'not-found') {
        const error = new FuseHttpError(
          'unknown_scope',
          'diagnosis job was not found for the requested scope',
          404,
          correlationId,
        );
        return reply.code(error.httpStatus).send(error.toBody());
      }
      if (result.kind === 'not-dead-letter') {
        const error = new FuseHttpError(
          'invalid_transition',
          'only dead-letter diagnosis jobs can be replayed',
          409,
          correlationId,
        );
        return reply.code(error.httpStatus).send(error.toBody());
      }
      if (result.kind === 'idempotency-conflict') {
        const error = new FuseHttpError(
          'idempotency_conflict',
          'idempotency key was already used for a different replay request',
          409,
          correlationId,
        );
        return reply.code(error.httpStatus).send(error.toBody());
      }
      return reply.code(200).send({
        job: result.job,
        replayed: result.kind === 'replayed',
      });
    } catch (error) {
      if (error instanceof StoreUnavailableError) {
        return storeUnavailable(correlationId, reply);
      }
      throw error;
    }
  });
}
