import { describe, expect, it } from 'vitest';
import { evaluateDetectorProtection, evaluatePreflight } from './evaluator.js';
import {
  buildEmptyFixture,
  buildHealthyFixture,
  buildMissingFieldsFixture,
  buildOrphanSpansFixture,
  buildStaleFixture,
} from './fixtures.js';
import { DEFAULT_PREFLIGHT_CONFIG } from './types.js';
import type { PreflightResult } from '@fuse/contracts';

const SCOPE = { tenant: 't1', environment: 'prod', agentId: 'agent-1' };
const NOW = new Date('2026-07-21T00:00:00.000Z');
const NOW_MS = NOW.getTime();
function delivery(status: 'success' | 'failure', observedAtMs: number, sequence = 1) {
  return { status, observedAtMs, sourceInstanceId: 'test-instance', sequence };
}
const OTLP_SUCCESS = delivery('success', NOW_MS);

describe('evaluatePreflight', () => {
  it('reports protected on a fully healthy window (first evaluation, no hysteresis needed)', () => {
    const result = evaluatePreflight({
      scope: SCOPE,
      spans: buildHealthyFixture(NOW_MS),
      exporterDelivery: OTLP_SUCCESS,
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(result.state).toBe('protected');
    expect(result.reasonCode).toBe('healthy');
    expect(result.lastGoodAt).toBe(NOW.toISOString());
  });

  it('reports blind on missing required fields (token counts dropped)', () => {
    const result = evaluatePreflight({
      scope: SCOPE,
      spans: buildMissingFieldsFixture(NOW_MS),
      exporterDelivery: OTLP_SUCCESS,
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(result.state).toBe('blind');
    expect(result.reasonCode).toBe('missing-required-fields');
  });

  it('reports blind on broken parent-chain propagation (all orphan spans)', () => {
    const result = evaluatePreflight({
      scope: SCOPE,
      spans: buildOrphanSpansFixture(NOW_MS),
      exporterDelivery: OTLP_SUCCESS,
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(result.state).toBe('blind');
    expect(result.reasonCode).toBe('orphan-spans-detected');
  });

  it('reports degraded (not blind) for partial field coverage above the blind threshold', () => {
    // 1 unhealthy span out of 6 => ~93% coverage average — degraded, not blind.
    const spans = buildHealthyFixture(NOW_MS, 6);
    spans[5] = { ...spans[5]!, hasOutputTokens: false };
    const result = evaluatePreflight({
      scope: SCOPE,
      spans,
      exporterDelivery: OTLP_SUCCESS,
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(result.state).toBe('degraded');
  });

  it('distinguishes idle (heartbeat alive, no spans) from broken telemetry (no signal at all)', () => {
    const idleWithHeartbeat = evaluatePreflight({
      scope: SCOPE,
      spans: buildEmptyFixture(),
      heartbeat: { lastSeenAtMs: NOW_MS - 10_000 },
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(idleWithHeartbeat.state).toBe('degraded');
    expect(idleWithHeartbeat.reasonCode).toBe('no-recent-telemetry');

    const noSignalAtAll = evaluatePreflight({
      scope: SCOPE,
      spans: buildEmptyFixture(),
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(noSignalAtAll.state).toBe('blind');
    expect(noSignalAtAll.reasonCode).toBe('no-signal');
  });

  it('treats a stale heartbeat the same as no heartbeat (blind, not degraded)', () => {
    const result = evaluatePreflight({
      scope: SCOPE,
      spans: buildEmptyFixture(),
      heartbeat: {
        lastSeenAtMs: NOW_MS - DEFAULT_PREFLIGHT_CONFIG.heartbeatGraceMs - 60_000,
      },
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(result.state).toBe('blind');
  });

  it('never treats future spans or heartbeats as current health evidence', () => {
    const futureSpans = evaluatePreflight({
      scope: SCOPE,
      spans: buildHealthyFixture(NOW_MS + 60_000),
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(futureSpans.state).toBe('blind');
    expect(futureSpans.reasonCode).toBe('no-signal');
    expect(futureSpans.freshnessMs).toBeNull();

    const futureHeartbeat = evaluatePreflight({
      scope: SCOPE,
      spans: [],
      heartbeat: { lastSeenAtMs: NOW_MS + 60_000 },
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(futureHeartbeat.state).toBe('blind');
    expect(futureHeartbeat.reasonCode).toBe('no-signal');
    expect(futureHeartbeat.freshnessMs).toBeNull();
  });

  it('treats all-stale spans (older than the staleness limit) as insufficient current evidence', () => {
    const result = evaluatePreflight({
      scope: SCOPE,
      spans: buildStaleFixture(
        NOW_MS,
        DEFAULT_PREFLIGHT_CONFIG.maxEvidenceStalenessMs + 60_000,
      ),
      exporterDelivery: OTLP_SUCCESS,
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(result.state).toBe('blind');
    expect(result.reasonCode).toBe('stale-evidence');
  });

  it('never claims protected without current (fresh + healthy) evidence, even with a live heartbeat', () => {
    const result = evaluatePreflight({
      scope: SCOPE,
      spans: buildEmptyFixture(),
      heartbeat: { lastSeenAtMs: NOW_MS },
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(result.state).not.toBe('protected');
  });

  it('degrades immediately (no hysteresis delay) when previously protected and telemetry breaks', () => {
    const protectedResult = evaluatePreflight({
      scope: SCOPE,
      spans: buildHealthyFixture(NOW_MS),
      exporterDelivery: OTLP_SUCCESS,
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    const laterMs = NOW_MS + 5000;
    const later = new Date(laterMs);
    const brokenResult = evaluatePreflight({
      scope: SCOPE,
      spans: buildMissingFieldsFixture(laterMs),
      exporterDelivery: delivery('success', laterMs, 2),
      now: later,
      config: DEFAULT_PREFLIGHT_CONFIG,
      previous: protectedResult,
    });
    expect(brokenResult.state).toBe('blind'); // committed immediately, not held in a "recovering"-like limbo
  });

  it('requires a dwell period before recovering from blind to protected (hysteresis)', () => {
    const broken = evaluatePreflight({
      scope: SCOPE,
      spans: buildMissingFieldsFixture(NOW_MS),
      exporterDelivery: OTLP_SUCCESS,
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(broken.state).toBe('blind');

    // Shortly after, telemetry looks healthy again — but not long enough
    // to satisfy minRecoveryDwellMs yet.
    const soonMs = NOW_MS + 5_000;
    const soon = evaluatePreflight({
      scope: SCOPE,
      spans: buildHealthyFixture(soonMs),
      exporterDelivery: delivery('success', soonMs, 2),
      now: new Date(soonMs),
      config: DEFAULT_PREFLIGHT_CONFIG,
      previous: broken,
    });
    expect(soon.state).toBe('blind'); // still held
    expect(soon.reasonCode).toBe('recovering');
    expect(soon.pendingRecoveryState).toBe('protected');
    // Regression: `lastGoodAt` must NOT advance to "now" just because this
    // call's raw telemetry looks healthy — the officially reported state
    // above is still `blind`, so a `lastGoodAt` of "moments ago" would
    // mislead an operator into thinking this scope was just confirmed
    // protected when it wasn't.
    expect(soon.lastGoodAt).toBe(broken.lastGoodAt);
    expect(soon.lastGoodAt).toBeNull(); // never actually protected yet

    // After the dwell period elapses with continued healthy evidence, it commits.
    const laterMs = NOW_MS + DEFAULT_PREFLIGHT_CONFIG.minRecoveryDwellMs + 5_000;
    const later = evaluatePreflight({
      scope: SCOPE,
      spans: buildHealthyFixture(laterMs),
      exporterDelivery: delivery('success', laterMs, 3),
      now: new Date(laterMs),
      config: DEFAULT_PREFLIGHT_CONFIG,
      previous: soon,
    });
    expect(later.state).toBe('protected');
    // Only now, once `protected` is actually committed, does it advance.
    expect(later.lastGoodAt).toBe(new Date(laterMs).toISOString());
  });

  it('resets the recovery dwell timer if health regresses mid-dwell', () => {
    const broken = evaluatePreflight({
      scope: SCOPE,
      spans: buildMissingFieldsFixture(NOW_MS),
      exporterDelivery: OTLP_SUCCESS,
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    const midDwellMs = NOW_MS + 5_000;
    const midDwell = evaluatePreflight({
      scope: SCOPE,
      spans: buildHealthyFixture(midDwellMs),
      exporterDelivery: delivery('success', midDwellMs, 2),
      now: new Date(midDwellMs),
      config: DEFAULT_PREFLIGHT_CONFIG,
      previous: broken,
    });
    expect(midDwell.pendingRecoveryState).toBe('protected');

    // Regresses again before the dwell completes.
    const regressMs = midDwellMs + 5_000;
    const regressed = evaluatePreflight({
      scope: SCOPE,
      spans: buildMissingFieldsFixture(regressMs),
      exporterDelivery: delivery('success', regressMs, 3),
      now: new Date(regressMs),
      config: DEFAULT_PREFLIGHT_CONFIG,
      previous: midDwell,
    });
    expect(regressed.state).toBe('blind');
    expect(regressed.pendingRecoveryState).toBeNull();

    // Healthy again — the dwell must restart from here, not from the
    // original pendingSince (which would let it recover instantly).
    const afterRegressMs = regressMs + DEFAULT_PREFLIGHT_CONFIG.minRecoveryDwellMs - 1000;
    const stillPending = evaluatePreflight({
      scope: SCOPE,
      spans: buildHealthyFixture(afterRegressMs),
      exporterDelivery: delivery('success', afterRegressMs, 4),
      now: new Date(afterRegressMs),
      config: DEFAULT_PREFLIGHT_CONFIG,
      previous: regressed,
    });
    expect(stillPending.state).toBe('blind');
  });

  it('handles an operator-disabled scope, overriding any telemetry evidence', () => {
    const result = evaluatePreflight({
      scope: SCOPE,
      spans: buildHealthyFixture(NOW_MS),
      exporterDelivery: OTLP_SUCCESS,
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
      disabled: true,
      disabledReason: 'planned maintenance window',
    });
    expect(result.state).toBe('disabled');
    expect(result.reason).toBe('planned maintenance window');
  });

  it('starts fresh (no instant recovery) when re-enabled after being disabled', () => {
    const disabled: PreflightResult = {
      scope: SCOPE,
      state: 'disabled',
      reasonCode: 'operator-disabled',
      reason: 'maintenance',
      evaluatedAt: NOW.toISOString(),
      lastGoodAt: null,
      requiredFieldCoveragePercent: 0,
      orphanRatePercent: 0,
      freshnessMs: null,
      pendingRecoveryState: null,
      pendingSince: null,
    };
    const reenabled = evaluatePreflight({
      scope: SCOPE,
      spans: buildHealthyFixture(NOW_MS),
      exporterDelivery: OTLP_SUCCESS,
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
      previous: disabled,
    });
    // No previous non-disabled baseline to hold hysteresis against, so a
    // healthy reading commits immediately rather than entering "recovering".
    expect(reenabled.state).toBe('protected');
  });

  it('requires a successful OTLP acknowledgement before reporting protected', () => {
    const neverConfirmed = evaluatePreflight({
      scope: SCOPE,
      spans: buildHealthyFixture(NOW_MS),
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(neverConfirmed.state).toBe('degraded');
    expect(neverConfirmed.reasonCode).toBe('exporter-delivery-unconfirmed');

    const failed = evaluatePreflight({
      scope: SCOPE,
      spans: buildHealthyFixture(NOW_MS),
      exporterDelivery: delivery('failure', NOW_MS),
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(failed.state).toBe('blind');
    expect(failed.reasonCode).toBe('exporter-delivery-failed');
  });

  it('keeps exporter failure authoritative when its rejected spans are stale', () => {
    const result = evaluatePreflight({
      scope: SCOPE,
      spans: buildStaleFixture(
        NOW_MS,
        DEFAULT_PREFLIGHT_CONFIG.maxEvidenceStalenessMs + 1,
      ),
      heartbeat: { lastSeenAtMs: NOW_MS },
      exporterDelivery: delivery('failure', NOW_MS),
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(result.state).toBe('blind');
    expect(result.reasonCode).toBe('exporter-delivery-failed');
  });

  it('rejects a stale successful OTLP acknowledgement', () => {
    const result = evaluatePreflight({
      scope: SCOPE,
      spans: buildHealthyFixture(NOW_MS),
      exporterDelivery: delivery(
        'success',
        NOW_MS - DEFAULT_PREFLIGHT_CONFIG.maxEvidenceStalenessMs - 1,
      ),
      now: NOW,
      config: DEFAULT_PREFLIGHT_CONFIG,
    });
    expect(result.state).toBe('blind');
    expect(result.reasonCode).toBe('exporter-delivery-stale');
  });
});

describe('evaluateDetectorProtection', () => {
  it('degrades only cost velocity when execution pricing is unavailable', () => {
    expect(
      evaluateDetectorProtection({
        executionId: 'execution-1',
        pricingStatuses: ['available', 'unavailable'],
        reportingAvailable: true,
      }),
    ).toEqual([
      expect.objectContaining({ detector: 'loop-signature', status: 'protected' }),
      expect.objectContaining({ detector: 'context-bloat', status: 'protected' }),
      expect.objectContaining({
        detector: 'cost-velocity',
        status: 'degraded',
        reasonCode: 'pricing-unavailable',
      }),
    ]);
  });

  it('degrades every detector when direct reporting is unavailable', () => {
    expect(
      evaluateDetectorProtection({
        executionId: 'execution-1',
        pricingStatuses: ['available'],
        reportingAvailable: false,
      }).every((status) => status.status === 'degraded'),
    ).toBe(true);
  });
});
