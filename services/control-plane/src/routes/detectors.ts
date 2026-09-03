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

    let baseline: Awaited<ReturnType<BreakerStore['getRecord']>>;
    try {
      baseline = await store.getRecord(parsed.data.scope);
      if (!baseline) {
        const httpErr = new FuseHttpError(
          'unknown_scope',
          'scope must be registered by an operator before detector observations are accepted',
          404,
          correlationId,
        );
        return reply.code(httpErr.httpStatus).send(httpErr.toBody());
      }
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
          'breaker state store is unreachable',
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
      baseline.epoch,
      new Date(),
      policy.detectors,
    );
    const enforcement: Array<{
      detector: string;
      outcome: 'tripped' | 'already-tripped' | 'breaker-disabled';
    }> = [];
    let episodeAlreadyTripped = baseline.state === 'tripped';

    for (const result of results.filter((candidate) => candidate.fired)) {
      if (episodeAlreadyTripped) {
        enforcement.push({ detector: result.detector, outcome: 'already-tripped' });
        continue;
      }
      if (baseline.state === 'disabled') {
        enforcement.push({ detector: result.detector, outcome: 'breaker-disabled' });
        continue;
      }
      try {
        // The baseline epoch identifies one arm→trip opportunity. Every
        // replica derives the same request for the same detector+epoch, so
        // concurrent observations serialize through BreakerStore's
        // idempotency lock instead of producing duplicate audit events.
        const epoch = baseline.epoch;
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
        const trip = await store.trip(
          {
            scope: parsed.data.scope,
            reason: `Fuse ${result.detector} detector ${result.detectorVersion} fired`,
            policyVersion: policy.policyVersion,
            cooldownSeconds: policy.cooldownSeconds,
            actor: { type: 'system', id: `system:detector:${result.detector}` },
            correlationId: incidentId,
            idempotencyKey: incidentId,
            expectedEpoch: epoch,
          },
          {
            detector: result.detector,
            startsAt: result.windowStart,
            notifySlack: policy.notificationRoutes.includes('slack'),
            measurement: {
              detectorVersion: result.detectorVersion,
              score: result.score,
              threshold: result.threshold,
              windowEnd: result.windowEnd,
            },
          },
        );
        if (trip.kind === 'rejected') {
          const httpErr = new FuseHttpError(
            'contention_exhausted',
            'breaker state changed before the direct detector trip committed; retry the observation',
            409,
            correlationId,
          );
          return reply
            .header('retry-after', '1')
            .code(httpErr.httpStatus)
            .send(httpErr.toBody());
        }
        const outcome = !trip.noop
          ? 'tripped'
          : trip.noopReason === 'breaker-disabled'
            ? 'breaker-disabled'
            : 'already-tripped';
        enforcement.push({ detector: result.detector, outcome });
        if (outcome === 'tripped' || outcome === 'already-tripped') {
          episodeAlreadyTripped = true;
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
