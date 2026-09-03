import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOKEN_TYPE,
} from '@opentelemetry/semantic-conventions/incubating';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getBreakerDecisionCounter,
  getDetectorFiredGauge,
  getDetectorScoreGauge,
  getDiagnosisDeliveryAttemptCounter,
  getDiagnosisDeliveryLatencyHistogram,
  getDiagnosisQueueDepthGauge,
  getDiagnosisLeaseRenewalFailureCounter,
  getDetectorObservationLatencyHistogram,
  getDetectorObservationRequestCounter,
  getEstimatedCostCounter,
  getOperationDurationHistogram,
  getPreflightStateGauge,
  getPreflightSelfAlertActiveGauge,
  getPreflightSelfAlertTransitionCounter,
  getPreflightEvaluationCounter,
  getPreflightSweepCounter,
  getPreflightSweepHealthGauge,
  getPermitLatencyHistogram,
  getPermitRequestCounter,
  getRedisReadinessCheckCounter,
  getRedisReadinessGauge,
  getTokenUsageHistogram,
  getWebhookLatencyHistogram,
  getWebhookRequestCounter,
} from './metrics.js';

describe('metrics instruments', () => {
  let exporter: InMemoryMetricExporter;
  let reader: PeriodicExportingMetricReader;
  let provider: MeterProvider;

  beforeEach(() => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 100_000,
    });
    provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    metrics.disable(); // unregister so the next test's setGlobalMeterProvider takes effect
  });

  it('records token usage split by input/output type, dimensioned by model — not by session/correlation id', async () => {
    getTokenUsageHistogram().record(100, {
      [ATTR_GEN_AI_REQUEST_MODEL]: 'llama-3.1-8b-instant',
      [ATTR_GEN_AI_TOKEN_TYPE]: 'input',
    });
    getTokenUsageHistogram().record(20, {
      [ATTR_GEN_AI_REQUEST_MODEL]: 'llama-3.1-8b-instant',
      [ATTR_GEN_AI_TOKEN_TYPE]: 'output',
    });
    await provider.forceFlush();

    const [resourceMetrics] = exporter.getMetrics();
    const dataPoints = resourceMetrics!.scopeMetrics[0]!.metrics[0]!.dataPoints as Array<{
      attributes: Record<string, unknown>;
      value: { sum: number; count: number };
    }>;
    expect(dataPoints).toHaveLength(2); // one series per token type
    const inputPoint = dataPoints.find(
      (p) => p.attributes[ATTR_GEN_AI_TOKEN_TYPE] === 'input',
    )!;
    expect(inputPoint.value.sum).toBe(100);
  });

  it('records operation duration', async () => {
    getOperationDurationHistogram().record(1.5, {
      [ATTR_GEN_AI_REQUEST_MODEL]: 'llama-3.1-8b-instant',
    });
    await provider.forceFlush();
    const [resourceMetrics] = exporter.getMetrics();
    expect(resourceMetrics!.scopeMetrics[0]!.metrics.length).toBeGreaterThan(0);
  });

  it('records breaker permit decisions', async () => {
    getBreakerDecisionCounter().add(1, {
      allowed: false,
      state: 'tripped',
      degraded: false,
    });
    await provider.forceFlush();
    const [resourceMetrics] = exporter.getMetrics();
    const metric = resourceMetrics!.scopeMetrics[0]!.metrics.find(
      (m) => m.descriptor.name === 'fuse.breaker.permit.decisions',
    );
    expect(metric).toBeDefined();
  });

  it('records the latest detector score as a gauge, by detector type and scope', async () => {
    getDetectorScoreGauge().record(3, {
      'fuse.detector': 'loop-signature',
      'fuse.tenant': 't1',
      'fuse.environment': 'prod',
      'fuse.agent_id': 'agent-1',
    });
    getDetectorScoreGauge().record(7, {
      'fuse.detector': 'loop-signature',
      'fuse.tenant': 't1',
      'fuse.environment': 'prod',
      'fuse.agent_id': 'agent-1',
    });
    await provider.forceFlush();
    const [resourceMetrics] = exporter.getMetrics();
    const metric = resourceMetrics!.scopeMetrics[0]!.metrics.find(
      (m) => m.descriptor.name === 'fuse.detector.score',
    );
    expect(metric).toBeDefined();
    // a gauge reports the latest value, not an accumulated sum
    const dataPoints = metric!.dataPoints as Array<{ value: number }>;
    expect(dataPoints[0]?.value).toBe(7);
  });

  it('records fuse.detector.fired as a clean 0/1 indicator, independent of score units', async () => {
    getDetectorFiredGauge().record(1, {
      'fuse.detector': 'context-bloat',
      'fuse.tenant': 't1',
      'fuse.environment': 'prod',
      'fuse.agent_id': 'agent-1',
    });
    await provider.forceFlush();
    const [resourceMetrics] = exporter.getMetrics();
    const metric = resourceMetrics!.scopeMetrics[0]!.metrics.find(
      (m) => m.descriptor.name === 'fuse.detector.fired',
    );
    expect(metric).toBeDefined();
    const dataPoints = metric!.dataPoints as Array<{ value: number }>;
    expect(dataPoints[0]?.value).toBe(1);
  });

  it('accumulates estimated cost across calls, by scope/provider/model', async () => {
    const attrs = {
      'fuse.tenant': 't1',
      'fuse.environment': 'prod',
      'fuse.agent_id': 'agent-1',
      'gen_ai.provider.name': 'groq',
      'gen_ai.request.model': 'llama-3.1-8b-instant',
    };
    getEstimatedCostCounter().add(0.001, attrs);
    getEstimatedCostCounter().add(0.002, attrs);
    await provider.forceFlush();
    const [resourceMetrics] = exporter.getMetrics();
    const metric = resourceMetrics!.scopeMetrics[0]!.metrics.find(
      (m) => m.descriptor.name === 'fuse.estimated_cost.usd.total',
    );
    expect(metric).toBeDefined();
    const dataPoints = metric!.dataPoints as Array<{ value: number }>;
    expect(dataPoints[0]?.value).toBeCloseTo(0.003, 6);
  });

  it('records the current Preflight state as a 1-valued gauge, by scope and state label', async () => {
    getPreflightStateGauge().record(1, {
      'fuse.tenant': 't1',
      'fuse.environment': 'prod',
      'fuse.agent_id': 'agent-1',
      'fuse.preflight.state': 'protected',
    });
    await provider.forceFlush();
    const [resourceMetrics] = exporter.getMetrics();
    const metric = resourceMetrics!.scopeMetrics[0]!.metrics.find(
      (m) => m.descriptor.name === 'fuse.preflight.state',
    );
    expect(metric).toBeDefined();
    const dataPoints = metric!.dataPoints as Array<{
      value: number;
      attributes: Record<string, unknown>;
    }>;
    expect(dataPoints[0]?.value).toBe(1);
    expect(dataPoints[0]?.attributes['fuse.preflight.state']).toBe('protected');
  });

  it('records self-alert open/recovery on one active series plus transition events', async () => {
    const scopeAttributes = {
      'fuse.tenant': 't1',
      'fuse.environment': 'prod',
      'fuse.agent_id': 'agent-1',
    };
    getPreflightSelfAlertActiveGauge().record(1, scopeAttributes);
    getPreflightSelfAlertTransitionCounter().add(1, {
      ...scopeAttributes,
      'fuse.preflight.transition': 'opened',
      'fuse.preflight.state': 'blind',
      'fuse.preflight.reason_code': 'exporter-delivery-failed',
    });
    getPreflightSelfAlertActiveGauge().record(0, scopeAttributes);
    getPreflightSelfAlertTransitionCounter().add(1, {
      ...scopeAttributes,
      'fuse.preflight.transition': 'recovered',
      'fuse.preflight.state': 'protected',
      'fuse.preflight.reason_code': 'healthy',
    });
    await provider.forceFlush();

    const [resourceMetrics] = exporter.getMetrics();
    const active = resourceMetrics!.scopeMetrics[0]!.metrics.find(
      (metric) => metric.descriptor.name === 'fuse.preflight.self_alert.active',
    );
    expect(active?.dataPoints).toHaveLength(1);
    expect((active!.dataPoints[0] as { value: number }).value).toBe(0);

    const transitions = resourceMetrics!.scopeMetrics[0]!.metrics.find(
      (metric) => metric.descriptor.name === 'fuse.preflight.self_alert.transitions',
    );
    expect(transitions?.dataPoints).toHaveLength(2);
  });

  it('records low-cardinality diagnosis queue, attempt, and delivery latency metrics', async () => {
    getDiagnosisQueueDepthGauge().record(7, { 'fuse.diagnosis.status': 'pending' });
    getDiagnosisQueueDepthGauge().record(2, { 'fuse.diagnosis.status': 'running' });
    getDiagnosisQueueDepthGauge().record(1, {
      'fuse.diagnosis.status': 'dead-letter',
    });
    getDiagnosisDeliveryAttemptCounter().add(1, {
      'fuse.diagnosis.outcome': 'succeeded',
    });
    getDiagnosisDeliveryLatencyHistogram().record(0.125, {
      'fuse.diagnosis.outcome': 'succeeded',
    });
    await provider.forceFlush();

    const [resourceMetrics] = exporter.getMetrics();
    const byName = new Map(
      resourceMetrics!.scopeMetrics[0]!.metrics.map((metric) => [
        metric.descriptor.name,
        metric,
      ]),
    );
    const queue = byName.get('fuse.diagnosis.queue.jobs');
    expect(queue?.dataPoints).toHaveLength(3);
    expect(
      queue?.dataPoints.every((point) =>
        Object.keys(point.attributes).every((key) => key === 'fuse.diagnosis.status'),
      ),
    ).toBe(true);
    expect(byName.get('fuse.diagnosis.delivery.attempts')).toBeDefined();
    expect(byName.get('fuse.diagnosis.delivery.latency')).toBeDefined();
  });

  it('records the operational SLO surface with bounded infrastructure-wide labels', async () => {
    const version = { 'fuse.slo.version': 'v1-provisional' };
    getPermitRequestCounter().add(1, { ...version, 'fuse.outcome': 'denied' });
    getPermitLatencyHistogram().record(0.012, {
      ...version,
      'fuse.outcome': 'denied',
    });
    getDetectorObservationRequestCounter().add(1, {
      ...version,
      'fuse.outcome': 'server_error',
    });
    getDetectorObservationLatencyHistogram().record(0.04, {
      ...version,
      'fuse.outcome': 'server_error',
    });
    getWebhookRequestCounter().add(1, {
      ...version,
      'fuse.outcome': 'auth_failure',
    });
    getWebhookLatencyHistogram().record(0.003, {
      ...version,
      'fuse.outcome': 'auth_failure',
    });
    getDiagnosisLeaseRenewalFailureCounter().add(1, {
      ...version,
      'fuse.reason': 'rejected',
    });
    getRedisReadinessGauge().record(0, version);
    getRedisReadinessCheckCounter().add(1, {
      ...version,
      'fuse.outcome': 'failure',
    });
    getPreflightEvaluationCounter().add(1, {
      ...version,
      'fuse.preflight.health_class': 'stale',
      'fuse.preflight.source': 'sweep',
    });
    getPreflightSweepCounter().add(1, {
      ...version,
      'fuse.outcome': 'success',
    });
    getPreflightSweepHealthGauge().record(1, version);
    await provider.forceFlush();

    const [resourceMetrics] = exporter.getMetrics();
    const operational = resourceMetrics!.scopeMetrics[0]!.metrics.filter((metric) =>
      metric.descriptor.name.startsWith('fuse.control_plane.') ||
      metric.descriptor.name.startsWith('fuse.rate_limit.') ||
      metric.descriptor.name === 'fuse.preflight.evaluations' ||
      metric.descriptor.name.startsWith('fuse.preflight.sweep.') ||
      metric.descriptor.name === 'fuse.diagnosis.lease_renewal.failures'
        ? true
        : false,
    );
    expect(operational.map((metric) => metric.descriptor.name).sort()).toEqual(
      [
        'fuse.control_plane.detector_observation.duration',
        'fuse.control_plane.detector_observation.requests',
        'fuse.control_plane.permit.duration',
        'fuse.control_plane.permit.requests',
        'fuse.control_plane.webhook.duration',
        'fuse.control_plane.webhook.requests',
        'fuse.diagnosis.lease_renewal.failures',
        'fuse.preflight.evaluations',
        'fuse.preflight.sweep.runs',
        'fuse.preflight.sweep.healthy',
        'fuse.rate_limit.redis.readiness_checks',
        'fuse.rate_limit.redis.ready',
      ].sort(),
    );
    for (const metric of operational) {
      for (const point of metric.dataPoints) {
        expect(point.attributes['fuse.slo.version']).toBe('v1-provisional');
        expect(Object.keys(point.attributes)).not.toEqual(
          expect.arrayContaining([
            'fuse.tenant',
            'fuse.environment',
            'fuse.agent_id',
            'fuse.source_epoch',
          ]),
        );
      }
    }
  });
});
