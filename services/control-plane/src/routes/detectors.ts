import type { FastifyInstance, FastifyRequest } from 'fastify';
import { FuseHttpError, ObserveStepsRequestSchema } from '@fuse/contracts';
import type { DetectorRunner } from '../detector-runner.js';

function correlationIdOf(request: FastifyRequest): string {
  const header = request.headers['x-correlation-id'];
  return typeof header === 'string' && header.length > 0 ? header : request.id;
}

export function registerDetectorRoutes(
  app: FastifyInstance,
  runner: DetectorRunner,
): void {
  app.post('/v1/detectors/observe', async (request, reply) => {
    const correlationId = correlationIdOf(request);
    const parsed = ObserveStepsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      const err = new FuseHttpError(
        'invalid_request',
        parsed.error.message,
        400,
        correlationId,
      );
      return reply.code(err.httpStatus).send(err.toBody());
    }

    // Steps within one request are processed in the order the caller sent
    // them, exactly as if they'd arrived as separate requests — only the
    // final result (reflecting the fully-updated buffer) is returned.
    let results = undefined;
    for (const step of parsed.data.steps) {
      results = runner.recordStep(parsed.data.scope, step);
    }
    return reply.code(200).send({ results });
  });
}
