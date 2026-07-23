import { describe, expect, it } from 'vitest';
import { DiagnosisResultSchema } from './diagnosis.js';

const SCOPE = { tenant: 't1', environment: 'prod', agentId: 'agent-1' };
const VALID = {
  detector: 'loop-signature' as const,
  detectorVersion: 'loop-signature-v1',
  scope: SCOPE,
  generatedAt: '2026-07-23T00:00:00.000Z',
  evidenceAvailable: true,
  hypothesis: 'A repeating step-shape cycle was detected.',
  confidence: 'high' as const,
  supportingEvidence: ['cycle length 2 repeated 5 times'],
  limitations: ['Trace sample is bounded to 5 spans.'],
  immediateContainment: 'The breaker has already tripped this scope.',
  recommendedFix: 'Add a cumulative cost ceiling and a progress check.',
  evidenceLinks: [{ traceId: 't-1', spanId: 's-1', webUrl: 'http://x/trace/t-1' }],
};

describe('DiagnosisResultSchema', () => {
  it('accepts a valid diagnosis result', () => {
    expect(DiagnosisResultSchema.safeParse(VALID).success).toBe(true);
  });

  it('accepts an evidence-unavailable result with a reason', () => {
    const result = DiagnosisResultSchema.safeParse({
      ...VALID,
      evidenceAvailable: false,
      evidenceUnavailableReason: 'MCP server unreachable',
      evidenceLinks: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects more than 10 evidence links', () => {
    const evidenceLinks = Array.from({ length: 11 }, (_, i) => ({
      traceId: `t-${i}`,
      spanId: `s-${i}`,
    }));
    expect(DiagnosisResultSchema.safeParse({ ...VALID, evidenceLinks }).success).toBe(
      false,
    );
  });

  it('rejects an unknown detector type', () => {
    expect(
      DiagnosisResultSchema.safeParse({ ...VALID, detector: 'not-a-detector' }).success,
    ).toBe(false);
  });

  it('rejects a missing recommendedFix', () => {
    const { recommendedFix: _drop, ...rest } = VALID;
    expect(DiagnosisResultSchema.safeParse(rest).success).toBe(false);
  });
});
