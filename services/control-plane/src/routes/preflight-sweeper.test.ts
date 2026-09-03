import { describe, expect, it, vi } from 'vitest';
import type { PreflightStore } from '@fuse/breaker-store';
import type { PreflightEvaluatorConfig } from '@fuse/preflight';
import { PreflightSweeper } from './preflight-sweeper.js';

const transitionMock = vi.fn();
const evaluationMock = vi.fn();
const sweepMock = vi.fn();
const sweepHealthMock = vi.fn();

vi.mock('@fuse/otel', () => ({
  FUSE_OPERATIONAL_SLO_VERSION: 'v1-provisional',
  getPreflightStateGauge: () => ({
    record: vi.fn(),
    recordSelfAlertState: vi.fn(),
    recordSelfAlertTransition: transitionMock,
  }),
  getPreflightEvaluationCounter: () => ({ add: evaluationMock }),
  getPreflightSweepCounter: () => ({ add: sweepMock }),
  getPreflightSweepHealthGauge: () => ({ record: sweepHealthMock }),
}));

const CONFIG = {
  windowMs: 1_000,
  blindCoverageThreshold: 0.5,
  blindOrphanRateThreshold: 0.5,
  blindTokenMissingRateThreshold: 0.3,
  heartbeatGraceMs: 500,
  maxEvidenceStalenessMs: 1_000,
  minRecoveryDwellMs: 100,
} satisfies PreflightEvaluatorConfig;

describe('PreflightSweeper', () => {
  it('bounds a pass, prevents overlap, and emits the committed transition once', async () => {
    let release!: (value: Awaited<ReturnType<PreflightStore['sweepStale']>>) => void;
    const pending = new Promise<Awaited<ReturnType<PreflightStore['sweepStale']>>>(
      (resolve) => {
        release = resolve;
      },
    );
    const sweepStale = vi.fn(() => pending);
    const sweeper = new PreflightSweeper({
      store: { sweepStale } as unknown as PreflightStore,
      config: CONFIG,
      log: { error: vi.fn() },
      intervalMs: 1_000,
      batchSize: 2,
    });

    const first = sweeper.runOnce();
    const overlapping = sweeper.runOnce();
    expect(sweepStale).toHaveBeenCalledOnce();
    expect(sweepStale).toHaveBeenCalledWith(CONFIG, 2);
    release([
      {
        result: {
          scope: { tenant: 't1', environment: 'test', agentId: 'agent-1' },
          state: 'blind',
          reasonCode: 'stale-evidence',
          reason: 'stale',
          evaluatedAt: new Date().toISOString(),
          lastGoodAt: null,
          requiredFieldCoveragePercent: 0,
          orphanRatePercent: 0,
          freshnessMs: 1_001,
          pendingRecoveryState: null,
          pendingSince: null,
        },
        selfAlertTransition: {
          kind: 'opened',
          fromState: 'protected',
          toState: 'blind',
          reasonCode: 'stale-evidence',
        },
      },
    ]);

    await expect(first).resolves.toBe(1);
    await expect(overlapping).resolves.toBe(1);
    expect(transitionMock).toHaveBeenCalledOnce();
    expect(evaluationMock).toHaveBeenCalledWith(1, {
      'fuse.slo.version': 'v1-provisional',
      'fuse.preflight.health_class': 'stale',
      'fuse.preflight.source': 'sweep',
    });
    expect(sweepMock).toHaveBeenCalledWith(1, {
      'fuse.slo.version': 'v1-provisional',
      'fuse.outcome': 'success',
    });
    expect(sweepHealthMock).toHaveBeenCalledWith(1, {
      'fuse.slo.version': 'v1-provisional',
    });
  });

  it('contains store failures so the periodic timer remains alive', async () => {
    const error = vi.fn();
    const sweeper = new PreflightSweeper({
      store: {
        sweepStale: vi.fn().mockRejectedValue(new Error('database unavailable')),
      } as unknown as PreflightStore,
      config: CONFIG,
      log: { error },
      intervalMs: 1_000,
      batchSize: 10,
    });

    await expect(sweeper.runOnce()).resolves.toBe(0);
    expect(error).toHaveBeenCalledOnce();
    expect(sweepMock).toHaveBeenCalledWith(1, {
      'fuse.slo.version': 'v1-provisional',
      'fuse.outcome': 'failure',
    });
    expect(sweepHealthMock).toHaveBeenCalledWith(0, {
      'fuse.slo.version': 'v1-provisional',
    });
  });
});
