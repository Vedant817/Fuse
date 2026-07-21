import { describe, expect, it } from 'vitest';
import { PreflightResultSchema } from './preflight.js';

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
