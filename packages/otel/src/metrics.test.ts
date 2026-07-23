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
  getEstimatedCostCounter,
  getOperationDurationHistogram,
  getPreflightStateGauge,
  getTokenUsageHistogram,
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
});
