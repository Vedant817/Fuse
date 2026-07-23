import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectorResult, Scope, StepObservationWire } from '@fuse/contracts';
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
    firedRecordMock.mockReset();
  });

  it('emits fuse.detector.score AND fuse.detector.fired gauge points for every detector on every step', () => {
    const runner = new DetectorRunner();
    const now = new Date('2026-07-22T00:00:00.000Z');
    runner.recordStep(SCOPE, step({ timestampMs: now.getTime() }), now);

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

    const first = firstReplica.evaluateWindow(SCOPE, window, now);
    const second = secondReplica.evaluateWindow(SCOPE, window, now);
    expect(second).toEqual(first);
    expect(second.find((result) => result.detector === 'loop-signature')?.fired).toBe(
      true,
    );
    expect(firstReplica.trackedScopeCount).toBe(0);
    expect(secondReplica.trackedScopeCount).toBe(0);
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

  it('caps the number of distinct tracked scopes — a caller sending unbounded distinct agentIds cannot grow memory without limit (task.md §9.2)', () => {
    const runner = new DetectorRunner(3);
    const now = new Date('2026-07-22T00:00:00.000Z');
    const scopeFor = (n: number): Scope => ({
      tenant: 't1',
      environment: 'test',
      agentId: `agent-${n}`,
    });

    for (let i = 0; i < 3; i++) {
      runner.recordStep(scopeFor(i), step({ timestampMs: now.getTime() }), now);
    }
    expect(runner.trackedScopeCount).toBe(3);

    // A 4th distinct scope must evict the least-recently-touched one
    // (agent-0, inserted first and never touched again), not grow past
    // the cap.
    runner.recordStep(scopeFor(3), step({ timestampMs: now.getTime() }), now);
    expect(runner.trackedScopeCount).toBe(3);
    expect(runner.hasScope(scopeFor(0))).toBe(false);
    expect(runner.hasScope(scopeFor(1))).toBe(true);
    expect(runner.hasScope(scopeFor(2))).toBe(true);
    expect(runner.hasScope(scopeFor(3))).toBe(true);
  });

  it('re-touching an existing scope refreshes its LRU position instead of counting as a new one', () => {
    const runner = new DetectorRunner(2);
    const now = new Date('2026-07-22T00:00:00.000Z');
    const a: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-a' };
    const b: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-b' };
    const c: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-c' };

    runner.recordStep(a, step({ timestampMs: now.getTime() }), now);
    runner.recordStep(b, step({ timestampMs: now.getTime() }), now);
    // Re-touch `a` — it should now be the most-recently-used, so the next
    // new scope evicts `b` (never touched again), not `a`.
    runner.recordStep(
      a,
      step({ timestampMs: now.getTime(), canonicalShape: 'again' }),
      now,
    );
    runner.recordStep(c, step({ timestampMs: now.getTime() }), now);

    expect(runner.trackedScopeCount).toBe(2);
    expect(runner.hasScope(a)).toBe(true);
    expect(runner.hasScope(b)).toBe(false);
    expect(runner.hasScope(c)).toBe(true);
  });
});
