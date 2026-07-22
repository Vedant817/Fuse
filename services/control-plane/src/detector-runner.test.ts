import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectorResult, Scope, StepObservationWire } from '@fuse/contracts';
import { DetectorRunner } from './detector-runner.js';

const recordMock = vi.fn();

vi.mock('@fuse/otel', () => ({
  getDetectorScoreGauge: () => ({ record: recordMock }),
}));

const SCOPE: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-1' };

function step(
  overrides: Partial<StepObservationWire> & { timestampMs: number },
): StepObservationWire {
  return {
    canonicalShape: 'step',
    inputTokens: 100,
    outputTokens: 20,
    estimatedCostUsd: 0.001,
    ...overrides,
  };
}

describe('DetectorRunner', () => {
  beforeEach(() => {
    recordMock.mockReset();
  });

  it('emits a fuse.detector.score gauge point for every detector on every step', () => {
    const runner = new DetectorRunner();
    const now = new Date('2026-07-22T00:00:00.000Z');
    runner.recordStep(SCOPE, step({ timestampMs: now.getTime() }), now);

    expect(recordMock).toHaveBeenCalledTimes(3);
    const detectors = recordMock.mock.calls.map((call) => call[1]['fuse.detector']);
    expect(new Set(detectors)).toEqual(
      new Set(['loop-signature', 'context-bloat', 'cost-velocity']),
    );
    for (const call of recordMock.mock.calls) {
      expect(call[1]).toMatchObject({
        'fuse.tenant': 't1',
        'fuse.environment': 'test',
        'fuse.agent_id': 'agent-1',
      });
    }
  });

  it('fires the loop-signature detector once a real ping-pong repeats past its threshold', () => {
    const runner = new DetectorRunner();
    const now = new Date('2026-07-22T00:00:00.000Z');
    let results: DetectorResult[] = [];
    // Analyzer/Verifier ping-pong, byte-identical shape each round —
    // DEFAULT_LOOP_SIGNATURE_CONFIG fires at 3 repetitions of a cycle.
    for (let i = 0; i < 8; i++) {
      const shape = i % 2 === 0 ? 'analyzer:unchanged' : 'verifier:needs-revision';
      results = runner.recordStep(
        SCOPE,
        step({ timestampMs: now.getTime() + i * 1000, canonicalShape: shape }),
        new Date(now.getTime() + i * 1000),
      );
    }
    const loop = results.find((r) => r.detector === 'loop-signature');
    expect(loop?.fired).toBe(true);
  });

  it('fires the context-bloat detector once input tokens cross the absolute ceiling', () => {
    const runner = new DetectorRunner();
    const now = new Date('2026-07-22T00:00:00.000Z');
    const results = runner.recordStep(
      SCOPE,
      step({ timestampMs: now.getTime(), inputTokens: 150_000, canonicalShape: 'a' }),
      now,
    );
    const bloat = results.find((r) => r.detector === 'context-bloat');
    expect(bloat?.fired).toBe(true);
  });

  it('fires the cost-velocity detector once spend in the trailing window crosses the threshold', () => {
    const runner = new DetectorRunner();
    const now = new Date('2026-07-22T00:00:00.000Z');
    let results: DetectorResult[] = [];
    // DEFAULT_COST_VELOCITY_CONFIG requires >= 2s elapsed across the burst
    // (its "incomplete window" safeguard) — 600ms apart over 5 calls spans
    // 2400ms, comfortably past that, while still landing well inside the
    // default 60s window.
    for (let i = 0; i < 5; i++) {
      results = runner.recordStep(
        SCOPE,
        step({
          timestampMs: now.getTime() + i * 600,
          canonicalShape: `burst-${i}`,
          estimatedCostUsd: 0.2,
        }),
        new Date(now.getTime() + i * 600),
      );
    }
    const velocity = results.find((r) => r.detector === 'cost-velocity');
    expect(velocity?.fired).toBe(true);
  });

  it('keeps two scopes independent — a loop on one agent never fires for another', () => {
    const runner = new DetectorRunner();
    const now = new Date('2026-07-22T00:00:00.000Z');
    const otherScope: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-2' };
    for (let i = 0; i < 8; i++) {
      const shape = i % 2 === 0 ? 'analyzer:unchanged' : 'verifier:needs-revision';
      runner.recordStep(
        SCOPE,
        step({ timestampMs: now.getTime() + i * 1000, canonicalShape: shape }),
        new Date(now.getTime() + i * 1000),
      );
    }
    const otherResults = runner.recordStep(
      otherScope,
      step({ timestampMs: now.getTime(), canonicalShape: 'analyzer:first-ever-step' }),
      now,
    );
    const loop = otherResults.find((r) => r.detector === 'loop-signature');
    expect(loop?.fired).toBe(false);
  });

  it('prunes steps older than the buffer age so a stale scope does not grow unbounded', () => {
    const runner = new DetectorRunner();
    const dayOne = new Date('2026-07-01T00:00:00.000Z');
    runner.recordStep(SCOPE, step({ timestampMs: dayOne.getTime() }), dayOne);
    // Two hours later — well past the 1-hour buffer age — a fresh single
    // step should evaluate as if the old one was never there (cost-velocity
    // needs minCallsForSignal=3, so a lone fresh step never fires).
    const later = new Date(dayOne.getTime() + 2 * 60 * 60 * 1000);
    const results = runner.recordStep(
      SCOPE,
      step({ timestampMs: later.getTime(), canonicalShape: 'fresh' }),
      later,
    );
    const velocity = results.find((r) => r.detector === 'cost-velocity');
    expect(velocity?.fired).toBe(false);
    expect(velocity?.score).toBe(0);
  });
});
