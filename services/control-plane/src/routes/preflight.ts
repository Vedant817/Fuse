import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  FuseHttpError,
  PreflightExporterEvidenceRequestSchema,
  PreflightReportRequestSchema,
  ScopeSchema,
} from '@fuse/contracts';
import {
  StoreUnavailableError,
  UnknownScopeError,
  type PreflightEvaluationOutcome,
  type PreflightStore,
} from '@fuse/breaker-store';
import type { PreflightEvaluatorConfig } from '@fuse/preflight';
import {
  FUSE_OPERATIONAL_SLO_VERSION,
  getPreflightEvaluationCounter,
  getPreflightStateGauge,
} from '@fuse/otel';
import type { Scope } from '@fuse/contracts';

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

/** Records committed aggregate state and its durable alert edge. Both HTTP
 * evaluations and autonomous sweeps use this one authoritative path. */
export function recordPreflightOutcome(
  scope: Scope,
  outcome: PreflightEvaluationOutcome,
  source: 'report' | 'exporter' | 'status' | 'sweep',
): void {
  const { result, selfAlertTransition } = outcome;
  const preflightMetrics = getPreflightStateGauge();
  const scopeAttributes = {
    'fuse.tenant': scope.tenant,
    'fuse.environment': scope.environment,
    'fuse.agent_id': scope.agentId,
  };
  preflightMetrics.record(1, {
    ...scopeAttributes,
    'fuse.preflight.state': result.state,
  });
  preflightMetrics.recordSelfAlertState(
    result.state === 'degraded' || result.state === 'blind',
    scopeAttributes,
  );
  if (selfAlertTransition) {
    preflightMetrics.recordSelfAlertTransition(
      {
        kind: selfAlertTransition.kind,
        state: selfAlertTransition.toState,
        reasonCode: selfAlertTransition.reasonCode,
      },
      scopeAttributes,
    );
  }
  const healthClass =
    result.reasonCode === 'stale-evidence' ||
    result.reasonCode === 'exporter-delivery-stale'
      ? 'stale'
      : result.reasonCode === 'no-signal' || result.reasonCode === 'no-recent-telemetry'
        ? 'no_data'
        : result.reasonCode === 'healthy'
          ? 'healthy'
          : result.reasonCode === 'operator-disabled'
            ? 'disabled'
            : result.reasonCode === 'recovering'
              ? 'recovering'
              : 'degraded';
  getPreflightEvaluationCounter().add(1, {
    'fuse.slo.version': FUSE_OPERATIONAL_SLO_VERSION,
    'fuse.preflight.health_class': healthClass,
    'fuse.preflight.source': source,
  });
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
      const outcome = await store.evaluateWithTransition({
        scope: parsed.data.scope,
        spans: parsed.data.spans,
        heartbeat: parsed.data.heartbeat,
        revalidate: parsed.data.revalidate,
        config,
        disabled: parsed.data.disabled,
        disabledReason: parsed.data.disabledReason,
      });
      const { result } = outcome;
      // Recorded here, not client-side in the SDK's PreflightReporter — the
      // same "authoritative decision point" reasoning as the breaker
      // permit-decision counter (routes/permit.ts): this evaluation is the
      // one place a scope's Preflight state is actually committed,
      // network-wide across every reporting caller.
      recordPreflightOutcome(parsed.data.scope, outcome, 'report');
      return reply.code(200).send({ result });
    } catch (err) {
      return handleStoreError(err, correlationId, reply);
    }
  });

  app.post('/v1/preflight/exporter-evidence', async (request, reply) => {
    const correlationId = correlationIdOf(request);
    const parsed = PreflightExporterEvidenceRequestSchema.safeParse(request.body);
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
      const outcome = await store.evaluateWithTransition({
        scope: parsed.data.scope,
        spans: parsed.data.spans,
        exporterDelivery: parsed.data.exporterDelivery,
        config,
      });
      recordPreflightOutcome(parsed.data.scope, outcome, 'exporter');
      return reply.code(200).send({ result: outcome.result });
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
      const outcome = await store.getRevalidatedResult(parsed.data, config);
      if (!outcome) {
        const err = new FuseHttpError(
          'unknown_scope',
          'no Preflight evaluation has ever been reported for this scope',
          404,
          correlationId,
        );
        return reply.code(err.httpStatus).send(err.toBody());
      }
      recordPreflightOutcome(parsed.data, outcome, 'status');
      return reply.code(200).send({ result: outcome.result });
    } catch (err) {
      return handleStoreError(err, correlationId, reply);
    }
  });
}
