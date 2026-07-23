import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { FuseHttpError, ObserveStepsRequestSchema } from '@fuse/contracts';
import {
  CasContentionExhaustedError,
  IdempotencyConflictError,
  StoreUnavailableError,
  UnknownScopeError,
  type BreakerStore,
} from '@fuse/breaker-store';
import type { DetectorRunner } from '../detector-runner.js';
import type { ResolvedDetectorPolicy } from '../policy-loader.js';
import {
  runDiagnosisAndNotify,
  type DiagnosisWorkerConfig,
} from '../diagnosis-worker.js';

function correlationIdOf(request: FastifyRequest): string {
  const header = request.headers['x-correlation-id'];
  return typeof header === 'string' && header.length > 0 ? header : request.id;
}

export function registerDetectorRoutes(
  app: FastifyInstance,
  runner: DetectorRunner,
  store: BreakerStore,
  options: {
    policyVersion: string;
    cooldownSeconds: number;
    resolvePolicy?: (scope: {
      tenant: string;
      environment: string;
      agentId: string;
    }) => ResolvedDetectorPolicy;
    diagnosisConfig?: DiagnosisWorkerConfig;
    diagnose?: typeof runDiagnosisAndNotify;
  },
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

    try {
      await store.assertScopeRegistered(parsed.data.scope);
    } catch (err) {
      if (err instanceof UnknownScopeError) {
        const httpErr = new FuseHttpError(
          'unknown_scope',
          'scope must be registered by an operator before detector observations are accepted',
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
      throw err;
    }

    // The SDK sends its complete bounded trailing window on every request.
    // Evaluate that window statelessly so requests may land on any
    // control-plane replica without splitting detector history.
    let policy: ResolvedDetectorPolicy;
    try {
      policy = options.resolvePolicy?.(parsed.data.scope) ?? {
        policyVersion: options.policyVersion,
        cooldownSeconds: options.cooldownSeconds,
        storeOutageMode: 'fail-closed',
        controlPlaneOutageMode: 'fail-closed',
        detectors: {},
        notificationRoutes: ['slack'],
      };
    } catch {
      const err = new FuseHttpError(
        'internal_error',
        'no active detector policy matches this scope',
        503,
        correlationId,
      );
      return reply.code(err.httpStatus).send(err.toBody());
    }
    const results = runner.evaluateWindow(
      parsed.data.scope,
      parsed.data.steps,
      new Date(),
      policy.detectors,
    );
    const enforcement: Array<{
      detector: string;
      outcome: 'tripped' | 'already-tripped' | 'breaker-disabled';
    }> = [];

    for (const result of results.filter((candidate) => candidate.fired)) {
      try {
        const current = await store.getRecord(parsed.data.scope);
        if (current?.state === 'tripped') {
          enforcement.push({ detector: result.detector, outcome: 'already-tripped' });
          continue;
        }
        if (current?.state === 'disabled') {
          enforcement.push({ detector: result.detector, outcome: 'breaker-disabled' });
          continue;
        }

        // The current epoch identifies one arm→trip opportunity. Every
        // replica derives the same request for the same detector+epoch, so
        // concurrent observations serialize through BreakerStore's
        // idempotency lock instead of producing duplicate audit events.
        const epoch = current?.epoch ?? 0;
        const incidentDigest = createHash('sha256')
          .update(
            [
              parsed.data.scope.tenant,
              parsed.data.scope.environment,
              parsed.data.scope.agentId,
              result.detector,
              result.detectorVersion,
              String(epoch),
            ].join('\0'),
          )
          .digest('hex');
        const incidentId = `detector:${incidentDigest}`;
        const trip = await store.trip({
          scope: parsed.data.scope,
          reason: `Fuse ${result.detector} detector ${result.detectorVersion} fired`,
          policyVersion: policy.policyVersion,
          cooldownSeconds: policy.cooldownSeconds,
          actor: { type: 'system', id: `system:detector:${result.detector}` },
          correlationId: incidentId,
          idempotencyKey: incidentId,
        });
        const outcome =
          trip.kind === 'applied' && !trip.noop
            ? 'tripped'
            : trip.kind === 'applied' && trip.noopReason === 'breaker-disabled'
              ? 'breaker-disabled'
              : 'already-tripped';
        enforcement.push({ detector: result.detector, outcome });
        if (
          outcome === 'tripped' &&
          trip.kind === 'applied' &&
          !trip.replayed &&
          policy.notificationRoutes.includes('slack') &&
          options.diagnosisConfig
        ) {
          void (options.diagnose ?? runDiagnosisAndNotify)(
            {
              scope: parsed.data.scope,
              detector: result.detector,
              reason: `Fuse ${result.detector} detector ${result.detectorVersion} fired`,
              correlationId: incidentId,
              startsAt: result.windowStart,
              detectorResult: result,
            },
            options.diagnosisConfig,
            (message, meta) => request.log.info(meta, message),
          );
        }
      } catch (err) {
        if (err instanceof StoreUnavailableError) {
          const httpErr = new FuseHttpError(
            'store_unavailable',
            'detector fired but the breaker trip could not be committed',
            503,
            correlationId,
          );
          return reply.code(httpErr.httpStatus).send(httpErr.toBody());
        }
        if (
          err instanceof IdempotencyConflictError ||
          err instanceof CasContentionExhaustedError
        ) {
          const httpErr = new FuseHttpError(
            'contention_exhausted',
            'detector trip contention could not be resolved; retry the observation',
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
    return reply.code(200).send({ results, enforcement });
  });
}
