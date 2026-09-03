import { describe, expect, it } from 'vitest';
import {
  compareExporterDeliverySignals,
  PreflightExporterEvidenceRequestSchema,
  PreflightReportRequestSchema,
  PreflightResultSchema,
} from './preflight.js';

const SCOPE = { tenant: 't1', environment: 'prod', agentId: 'agent-1' };

describe('PreflightResultSchema', () => {
  it('accepts a valid protected result', () => {
    const result = PreflightResultSchema.safeParse({
      scope: SCOPE,
      state: 'protected',
      reasonCode: 'healthy',
      reason: 'all required fields present, no orphans, fresh telemetry',
      evaluatedAt: '2026-07-21T00:00:00.000Z',
      lastGoodAt: '2026-07-21T00:00:00.000Z',
      requiredFieldCoveragePercent: 100,
      orphanRatePercent: 0,
      freshnessMs: 500,
      pendingRecoveryState: null,
      pendingSince: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a blind result with a null lastGoodAt (never confirmed protected)', () => {
    const result = PreflightResultSchema.safeParse({
      scope: SCOPE,
      state: 'blind',
      reasonCode: 'no-signal',
      reason: 'no spans and no heartbeat observed',
      evaluatedAt: '2026-07-21T00:00:00.000Z',
      lastGoodAt: null,
      requiredFieldCoveragePercent: 0,
      orphanRatePercent: 0,
      freshnessMs: null,
      pendingRecoveryState: null,
      pendingSince: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid state', () => {
    expect(
      PreflightResultSchema.safeParse({
        scope: SCOPE,
        state: 'super-protected',
        reasonCode: 'healthy',
        reason: 'x',
        evaluatedAt: '2026-07-21T00:00:00.000Z',
        lastGoodAt: null,
        requiredFieldCoveragePercent: 100,
        orphanRatePercent: 0,
        freshnessMs: null,
        pendingRecoveryState: null,
        pendingSince: null,
      }).success,
    ).toBe(false);
  });

  it('rejects a coverage percent outside 0-100', () => {
    expect(
      PreflightResultSchema.safeParse({
        scope: SCOPE,
        state: 'protected',
        reasonCode: 'healthy',
        reason: 'x',
        evaluatedAt: '2026-07-21T00:00:00.000Z',
        lastGoodAt: null,
        requiredFieldCoveragePercent: 150,
        orphanRatePercent: 0,
        freshnessMs: null,
        pendingRecoveryState: null,
        pendingSince: null,
      }).success,
    ).toBe(false);
  });
});

describe('PreflightReportRequestSchema', () => {
  it('rejects exporter delivery on the ordinary structural report boundary', () => {
    const result = PreflightReportRequestSchema.safeParse({
      scope: SCOPE,
      spans: [],
      exporterDelivery: {
        status: 'success',
        observedAtMs: 1_785_801_600_000,
        sourceInstanceId: 'instance-1',
        sequence: 1,
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts ordinary bounded structural observations', () => {
    const result = PreflightReportRequestSchema.safeParse({
      scope: SCOPE,
      spans: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects caller-supplied evidence during revalidation', () => {
    expect(
      PreflightReportRequestSchema.safeParse({
        scope: SCOPE,
        spans: [],
        revalidate: true,
        exporterDelivery: {
          status: 'success',
          observedAtMs: 1,
          sourceInstanceId: 'instance-1',
          sequence: 1,
        },
      }).success,
    ).toBe(false);
    expect(
      PreflightReportRequestSchema.safeParse({
        scope: SCOPE,
        spans: [],
        revalidate: true,
        heartbeat: { lastSeenAtMs: 2 },
      }).success,
    ).toBe(false);
  });
});

describe('PreflightExporterEvidenceRequestSchema', () => {
  it('accepts only bounded exporter evidence with an exact request scope', () => {
    expect(
      PreflightExporterEvidenceRequestSchema.safeParse({
        scope: SCOPE,
        spans: [],
        exporterDelivery: {
          status: 'success',
          observedAtMs: 1_785_801_600_000,
          sourceInstanceId: 'instance-1',
          sequence: 1,
        },
      }).success,
    ).toBe(true);
  });

  it('rejects malformed or mixed-capability exporter evidence', () => {
    expect(
      PreflightExporterEvidenceRequestSchema.safeParse({
        scope: SCOPE,
        spans: [],
        exporterDelivery: {
          status: 'maybe',
          observedAtMs: -1,
          sourceInstanceId: '',
          sequence: 0,
        },
      }).success,
    ).toBe(false);
    expect(
      PreflightExporterEvidenceRequestSchema.safeParse({
        scope: SCOPE,
        spans: [],
        exporterDelivery: {
          status: 'success',
          observedAtMs: 1,
          sourceInstanceId: 'instance-1',
          sequence: 1,
        },
        disabled: true,
      }).success,
    ).toBe(false);
  });
});

describe('compareExporterDeliverySignals', () => {
  const signal = {
    status: 'success' as const,
    observedAtMs: 100,
    sourceInstanceId: 'instance-a',
    sequence: 1,
  };

  it('uses sequence within one process even when wall time moves backwards', () => {
    expect(
      compareExporterDeliverySignals(
        { ...signal, observedAtMs: 50, sequence: 2 },
        signal,
      ),
    ).toBeGreaterThan(0);
  });

  it('does not compare distinct process clocks', () => {
    expect(
      compareExporterDeliverySignals(
        { ...signal, sourceInstanceId: 'instance-b', observedAtMs: 10_000 },
        signal,
      ),
    ).toBe(0);
    expect(
      compareExporterDeliverySignals(
        {
          ...signal,
          sourceInstanceId: 'instance-b',
          status: 'failure',
        },
        signal,
      ),
    ).toBe(0);
  });

  it('prefers failure for a conflicting same-source sequence', () => {
    expect(
      compareExporterDeliverySignals({ ...signal, status: 'failure' }, signal),
    ).toBeGreaterThan(0);
  });
});
