import { describe, expect, it } from 'vitest';
import { DetectorResultSchema } from './detector.js';

const SCOPE = { tenant: 't1', environment: 'prod', agentId: 'agent-1' };

describe('DetectorResultSchema', () => {
  it('accepts a valid detector result', () => {
    const result = DetectorResultSchema.safeParse({
      detector: 'loop-signature',
      detectorVersion: 'v1',
      scope: SCOPE,
      fired: true,
      score: 5,
      threshold: 3,
      windowStart: '2026-07-21T00:00:00.000Z',
      windowEnd: '2026-07-21T00:05:00.000Z',
      evidence: ['3 identical step shapes at indices 4,5,6'],
      dedupeKey: 'loop-signature:t1/prod/agent-1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid detector type', () => {
    expect(
      DetectorResultSchema.safeParse({
        detector: 'not-a-real-detector',
        detectorVersion: 'v1',
        scope: SCOPE,
        fired: true,
        score: 5,
        threshold: 3,
        windowStart: '2026-07-21T00:00:00.000Z',
        windowEnd: '2026-07-21T00:05:00.000Z',
        dedupeKey: 'x',
      }).success,
    ).toBe(false);
  });

  it('rejects a missing dedupeKey', () => {
    expect(
      DetectorResultSchema.safeParse({
        detector: 'cost-velocity',
        detectorVersion: 'v1',
        scope: SCOPE,
        fired: false,
        score: 0,
        threshold: 3,
        windowStart: '2026-07-21T00:00:00.000Z',
        windowEnd: '2026-07-21T00:05:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('rejects a non-ISO windowStart', () => {
    expect(
      DetectorResultSchema.safeParse({
        detector: 'context-bloat',
        detectorVersion: 'v1',
        scope: SCOPE,
        fired: false,
        score: 0,
        threshold: 3,
        windowStart: 'not-a-date',
        windowEnd: '2026-07-21T00:05:00.000Z',
        dedupeKey: 'x',
      }).success,
    ).toBe(false);
  });
});
