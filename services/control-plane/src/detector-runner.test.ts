import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scope, StepObservationWire } from '@fuse/contracts';
import { DetectorRunner } from './detector-runner.js';

const recordMock = vi.fn();
const firedRecordMock = vi.fn();

vi.mock('@fuse/otel', () => ({
  getDetectorScoreGauge: () => ({ record: recordMock }),
  getDetectorFiredGauge: () => ({ record: firedRecordMock }),
}));

const SCOPE: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-1' };

function step(
  overrides: Partial<StepObservationWire> & { timestampMs: number },
): StepObservationWire {
  return {
    executionId: 'execution-1',
    canonicalShape: 'step',
    inputTokens: 100,
    outputTokens: 20,
    pricingStatus: 'available',
    estimatedCostUsd: 0.001,
    ...overrides,
  };
}

describe('DetectorRunner', () => {
  beforeEach(() => {
    recordMock.mockReset();
    firedRecordMock.mockReset();
  });

  it('emits fuse.detector.score and fuse.detector.fired for every window evaluation', () => {
    const runner = new DetectorRunner();
    const now = new Date('2026-07-22T00:00:00.000Z');
    runner.evaluateWindow(SCOPE, [step({ timestampMs: now.getTime() })], 42, now);

    expect(recordMock).toHaveBeenCalledTimes(3);
    expect(firedRecordMock).toHaveBeenCalledTimes(3);
    const detectors = recordMock.mock.calls.map((call) => call[1]['fuse.detector']);
    expect(new Set(detectors)).toEqual(
      new Set(['loop-signature', 'context-bloat', 'cost-velocity']),
    );
    for (const call of recordMock.mock.calls) {
      expect(call[1]).toMatchObject({
        'fuse.tenant': 't1',
        'fuse.environment': 'test',
        'fuse.agent_id': 'agent-1',
        'fuse.source_epoch': '42',
      });
    }
    // fired is always 0 or 1, never the raw (differently-scaled) score
    for (const call of firedRecordMock.mock.calls) {
      expect([0, 1]).toContain(call[0]);
    }
  });

  it('fires the loop-signature detector once a real ping-pong repeats past its threshold', () => {
    const runner = new DetectorRunner();
    const now = new Date('2026-07-22T00:00:00.000Z');
    // Analyzer/Verifier ping-pong, byte-identical shape each round —
    // DEFAULT_LOOP_SIGNATURE_CONFIG fires at 3 repetitions of a cycle.
    const window = Array.from({ length: 8 }, (_, index) =>
      step({
        timestampMs: now.getTime() - (8 - index) * 1000,
        canonicalShape:
          index % 2 === 0 ? 'analyzer:unchanged' : 'verifier:needs-revision',
      }),
    );
    const results = runner.evaluateWindow(SCOPE, window, 0, now);
    const loop = results.find((r) => r.detector === 'loop-signature');
    expect(loop?.fired).toBe(true);

    // the fired gauge for loop-signature's very last emission must be 1 —
    // exactly what a SigNoz alert rule thresholds on, regardless of the
    // raw score's own scale.
    const lastLoopFiredCall = firedRecordMock.mock.calls
      .filter((call) => call[1]['fuse.detector'] === 'loop-signature')
      .at(-1);
    expect(lastLoopFiredCall?.[0]).toBe(1);
  });

  it('evaluates a complete carried window identically on a fresh replica', () => {
    const firstReplica = new DetectorRunner();
    const secondReplica = new DetectorRunner();
    const now = new Date('2026-07-22T00:00:10.000Z');
    const window = Array.from({ length: 8 }, (_, index) =>
      step({
        timestampMs: now.getTime() - (8 - index) * 1000,
        canonicalShape:
          index % 2 === 0 ? 'analyzer:unchanged' : 'verifier:needs-revision',
      }),
    );

    const first = firstReplica.evaluateWindow(SCOPE, window, 8, now);
    const second = secondReplica.evaluateWindow(SCOPE, window, 8, now);
    expect(second).toEqual(first);
    expect(second.find((result) => result.detector === 'loop-signature')?.fired).toBe(
      true,
    );
  });

  it('fires the context-bloat detector once input tokens cross the absolute ceiling', () => {
    const runner = new DetectorRunner();
    const now = new Date('2026-07-22T00:00:00.000Z');
    const results = runner.evaluateWindow(
      SCOPE,
      [step({ timestampMs: now.getTime(), inputTokens: 150_000, canonicalShape: 'a' })],
      0,
      now,
    );
    const bloat = results.find((r) => r.detector === 'context-bloat');
    expect(bloat?.fired).toBe(true);
  });

  it('fires the cost-velocity detector once spend in the trailing window crosses the threshold', () => {
    const runner = new DetectorRunner();
    const now = new Date('2026-07-22T00:00:00.000Z');
    // DEFAULT_COST_VELOCITY_CONFIG requires >= 2s elapsed across the burst
    // (its "incomplete window" safeguard) — 600ms apart over 5 calls spans
    // 2400ms, comfortably past that, while still landing well inside the
    // default 60s window.
    const window = Array.from({ length: 5 }, (_, index) =>
      step({
        timestampMs: now.getTime() - (4 - index) * 600,
        canonicalShape: `burst-${index}`,
        estimatedCostUsd: 0.2,
      }),
    );
    const results = runner.evaluateWindow(SCOPE, window, 0, now);
    const velocity = results.find((r) => r.detector === 'cost-velocity');
    expect(velocity?.fired).toBe(true);
  });

  it('evaluates each caller window independently', () => {
    const runner = new DetectorRunner();
    const now = new Date('2026-07-22T00:00:00.000Z');
    const otherScope: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-2' };
    runner.evaluateWindow(
      SCOPE,
      Array.from({ length: 8 }, (_, index) =>
        step({
          timestampMs: now.getTime() - (8 - index) * 1000,
          canonicalShape:
            index % 2 === 0 ? 'analyzer:unchanged' : 'verifier:needs-revision',
        }),
      ),
      0,
      now,
    );
    const otherResults = runner.evaluateWindow(
      otherScope,
      [step({ timestampMs: now.getTime(), canonicalShape: 'analyzer:first-ever-step' })],
      0,
      now,
    );
    const loop = otherResults.find((r) => r.detector === 'loop-signature');
    expect(loop?.fired).toBe(false);
  });

  it('ignores observations outside the bounded trailing window', () => {
    const runner = new DetectorRunner();
    const dayOne = new Date('2026-07-01T00:00:00.000Z');
    const later = new Date(dayOne.getTime() + 2 * 60 * 60 * 1000);
    const results = runner.evaluateWindow(
      SCOPE,
      [
        step({
          timestampMs: dayOne.getTime(),
          estimatedCostUsd: 100,
          canonicalShape: 'stale',
        }),
        step({ timestampMs: later.getTime(), canonicalShape: 'fresh' }),
      ],
      0,
      later,
    );
    const velocity = results.find((r) => r.detector === 'cost-velocity');
    expect(velocity?.fired).toBe(false);
    expect(velocity?.score).toBe(0);
  });
});
