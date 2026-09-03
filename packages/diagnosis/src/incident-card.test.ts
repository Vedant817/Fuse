import { describe, expect, it } from 'vitest';
import type { DiagnosisResult } from '@fuse/contracts';
import { buildIncidentCardBlocks, renderLocalIncidentCardHtml } from './incident-card.js';

const DIAGNOSIS: DiagnosisResult = {
  detector: 'loop-signature',
  detectorVersion: 'loop-signature-v1',
  scope: { tenant: 't1', environment: 'prod', agentId: 'agent-1' },
  generatedAt: '2026-07-23T00:00:00.000Z',
  evidenceAvailable: true,
  hypothesis: 'A repeating step-shape cycle was detected.',
  confidence: 'high',
  supportingEvidence: ['cycle length 2 repeated 5 times'],
  limitations: ['This is a hypothesis, not a certainty.'],
  immediateContainment: 'The breaker has already tripped this scope.',
  recommendedFix: 'Add a cumulative cost ceiling.',
  evidenceLinks: [
    {
      traceId: 'abcdef1234567890',
      spanId: 's1',
      webUrl: 'http://signoz/trace/abcdef1234567890',
    },
  ],
};

describe('buildIncidentCardBlocks', () => {
  it('includes tripped state/scope/reason/evidence/confidence/fix', () => {
    const card = buildIncidentCardBlocks(DIAGNOSIS, {
      correlationId: 'corr-1',
      preflightState: 'protected',
    });
    const json = JSON.stringify(card.blocks);
    expect(json).toContain('loop-signature');
    expect(json).toContain('t1/prod/agent-1');
    expect(json).toContain('repeating step-shape cycle');
    expect(json).toContain('cumulative cost ceiling');
    expect(json).toContain('High');
    expect(card.text).toContain('Fuse tripped');
  });

  it('includes a Resume action only when a resumeActionValue is provided', () => {
    const withResume = buildIncidentCardBlocks(DIAGNOSIS, {
      correlationId: 'corr-1',
      preflightState: 'protected',
      resumeActionValue: 'scope-payload',
    });
    const withoutResume = buildIncidentCardBlocks(DIAGNOSIS, {
      correlationId: 'corr-1',
      preflightState: 'protected',
    });
    expect(JSON.stringify(withResume.blocks)).toContain('fuse_resume');
    expect(JSON.stringify(withoutResume.blocks)).not.toContain('fuse_resume');
  });

  it('never leaks raw evidence link URLs without the trace id label', () => {
    const card = buildIncidentCardBlocks(DIAGNOSIS, {
      correlationId: 'corr-1',
      preflightState: 'protected',
    });
    expect(JSON.stringify(card.blocks)).toContain('abcdef123456');
  });

  it.each(['degraded', 'blind', 'unknown'] as const)(
    'renders the tripped breaker with Preflight %s without implying protection',
    (preflightState) => {
      const card = buildIncidentCardBlocks(DIAGNOSIS, {
        correlationId: 'corr-1',
        preflightState,
      });
      const json = JSON.stringify(card.blocks);
      expect(card.text).toContain('Fuse tripped');
      expect(json).toContain(`*Preflight*\\n${preflightState}`);
      if (preflightState !== 'degraded') expect(json).not.toContain('protected');
    },
  );
});

describe('renderLocalIncidentCardHtml', () => {
  it('renders a self-contained HTML snapshot with no network calls', () => {
    const html = renderLocalIncidentCardHtml(DIAGNOSIS, {
      correlationId: 'corr-1',
      preflightState: 'blind',
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('repeating step-shape cycle');
    expect(html).toContain('cumulative cost ceiling');
    expect(html).toContain('Preflight:</span> blind');
    expect(html).not.toContain('slack.com');
    expect(html).not.toMatch(/https?:\/\/hooks\.slack/);
  });

  it('escapes HTML-significant characters in diagnosis text', () => {
    const withHtml: DiagnosisResult = {
      ...DIAGNOSIS,
      hypothesis: '<script>alert(1)</script>',
    };
    const html = renderLocalIncidentCardHtml(withHtml, {
      correlationId: 'corr-1',
      preflightState: 'unknown',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
