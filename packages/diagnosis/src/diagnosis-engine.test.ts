import { describe, expect, it } from 'vitest';
import type { DetectorResult } from '@fuse/contracts';
import { buildDiagnosis } from './diagnosis-engine.js';
import {
  buildFixtureEvidenceBundle,
  buildUnavailableEvidenceBundle,
} from './fixtures.js';

const SCOPE = { tenant: 't1', environment: 'test', agentId: 'agent-1' };

function loopResult(overrides: Partial<DetectorResult> = {}): DetectorResult {
  return {
    detector: 'loop-signature',
    detectorVersion: 'loop-signature-v1',
    scope: SCOPE,
    fired: true,
    score: 5,
    threshold: 3,
    windowStart: '2026-07-23T00:00:00.000Z',
    windowEnd: '2026-07-23T00:01:00.000Z',
    evidence: ['cycle length 2 repeated 5 times in the trailing 12 steps'],
    dedupeKey: 'loop-signature:t1/test/agent-1',
    ...overrides,
  };
}

describe('buildDiagnosis', () => {
  it('produces a high-confidence, loop-specific diagnosis when real evidence is available', () => {
    const diagnosis = buildDiagnosis(loopResult(), buildFixtureEvidenceBundle());
    expect(diagnosis.detector).toBe('loop-signature');
    expect(diagnosis.confidence).toBe('high');
    expect(diagnosis.evidenceAvailable).toBe(true);
    expect(diagnosis.hypothesis).toContain('repeating step-shape cycle');
    expect(diagnosis.recommendedFix).toContain('cumulative');
    expect(diagnosis.evidenceLinks).toHaveLength(2);
    expect(diagnosis.supportingEvidence).toContain(
      'cycle length 2 repeated 5 times in the trailing 12 steps',
    );
  });

  it('never claims certainty — always states limitations', () => {
    const diagnosis = buildDiagnosis(loopResult(), buildFixtureEvidenceBundle());
    expect(diagnosis.limitations.length).toBeGreaterThan(0);
    expect(diagnosis.limitations.join(' ')).toContain('hypothesis, not a certainty');
  });

  it('degrades to medium confidence and records the reason when evidence is unavailable', () => {
    const diagnosis = buildDiagnosis(
      loopResult(),
      buildUnavailableEvidenceBundle('MCP server unreachable'),
    );
    expect(diagnosis.evidenceAvailable).toBe(false);
    expect(diagnosis.evidenceUnavailableReason).toBe('MCP server unreachable');
    expect(diagnosis.confidence).toBe('medium');
    expect(diagnosis.evidenceLinks).toEqual([]);
    expect(diagnosis.limitations.join(' ')).toContain('unavailable');
  });

  it('degrades to medium confidence when evidence is available but empty (no matching spans)', () => {
    const diagnosis = buildDiagnosis(
      loopResult(),
      buildFixtureEvidenceBundle({ spans: [] }),
    );
    expect(diagnosis.evidenceAvailable).toBe(true);
    expect(diagnosis.confidence).toBe('medium');
    expect(diagnosis.supportingEvidence.join(' ')).toContain('No matching spans');
  });

  it('never throws and always states the breaker is already contained, regardless of evidence', () => {
    const diagnosis = buildDiagnosis(
      loopResult(),
      buildUnavailableEvidenceBundle('timeout'),
    );
    expect(diagnosis.immediateContainment).toContain('already tripped');
  });

  it('maps context-bloat and cost-velocity to their own distinct hypotheses/fixes', () => {
    const bloat = buildDiagnosis(
      { ...loopResult(), detector: 'context-bloat', detectorVersion: 'context-bloat-v1' },
      buildFixtureEvidenceBundle(),
    );
    const velocity = buildDiagnosis(
      { ...loopResult(), detector: 'cost-velocity', detectorVersion: 'cost-velocity-v1' },
      buildFixtureEvidenceBundle(),
    );
    expect(bloat.hypothesis).toContain('Input token count grew');
    expect(bloat.recommendedFix).toContain('compaction');
    expect(velocity.hypothesis).toContain('Estimated spend');
    expect(velocity.recommendedFix).toContain('workload');
    expect(bloat.hypothesis).not.toEqual(velocity.hypothesis);
  });

  it('caps evidenceLinks even if the bundle somehow carries more than 10 spans', () => {
    const manySpans = Array.from({ length: 15 }, (_, i) => ({
      traceId: `t-${i}`,
      spanId: `s-${i}`,
      name: 'chat',
      serviceName: 'svc',
      timestampIso: '2026-07-23T00:00:00.000Z',
      durationNanos: 1,
      hasError: false,
      webUrl: undefined,
    }));
    const diagnosis = buildDiagnosis(
      loopResult(),
      buildFixtureEvidenceBundle({ spans: manySpans }),
    );
    expect(diagnosis.evidenceLinks.length).toBeLessThanOrEqual(10);
  });
});
