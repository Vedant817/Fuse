import { describe, expect, it } from 'vitest';
import type { SignozAlertmanagerAlert } from '@fuse/contracts';
import { mapSignozAlertToNormalizedEvent } from './signoz-alert-mapper.js';

function baseAlert(
  overrides: Partial<SignozAlertmanagerAlert> = {},
): SignozAlertmanagerAlert {
  return {
    status: 'firing',
    labels: { fuse_tenant: 't1', fuse_environment: 'prod', fuse_agent_id: 'agent-1' },
    annotations: {},
    startsAt: '2026-07-21T00:00:00Z',
    fingerprint: 'abc123',
    ...overrides,
  };
}

describe('mapSignozAlertToNormalizedEvent', () => {
  it('maps an alert using underscored label keys', () => {
    const result = mapSignozAlertToNormalizedEvent(baseAlert());
    expect(result?.scope).toEqual({
      tenant: 't1',
      environment: 'prod',
      agentId: 'agent-1',
    });
  });

  it('maps an alert using dotted label keys', () => {
    const result = mapSignozAlertToNormalizedEvent(
      baseAlert({
        labels: {
          'fuse.tenant': 't1',
          'fuse.environment': 'prod',
          'fuse.agent_id': 'agent-1',
        },
      }),
    );
    expect(result?.scope).toEqual({
      tenant: 't1',
      environment: 'prod',
      agentId: 'agent-1',
    });
  });

  it('returns undefined when the tenant label is missing (unresolvable scope)', () => {
    const result = mapSignozAlertToNormalizedEvent(
      baseAlert({ labels: { fuse_environment: 'prod', fuse_agent_id: 'agent-1' } }),
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when all scope labels are absent', () => {
    const result = mapSignozAlertToNormalizedEvent(
      baseAlert({ labels: { unrelated: 'label' } }),
    );
    expect(result).toBeUndefined();
  });

  it('extracts the detector label when present, defaulting to "unknown" otherwise', () => {
    const withDetector = mapSignozAlertToNormalizedEvent(
      baseAlert({ labels: { ...baseAlert().labels, fuse_detector: 'loop-signature' } }),
    );
    expect(withDetector?.detector).toBe('loop-signature');

    const withoutDetector = mapSignozAlertToNormalizedEvent(baseAlert());
    expect(withoutDetector?.detector).toBe('unknown');
  });

  it('prefers the summary annotation for reason, falling back to description, then a generic message', () => {
    const withSummary = mapSignozAlertToNormalizedEvent(
      baseAlert({ annotations: { summary: 'loop detected' } }),
    );
    expect(withSummary?.reason).toBe('loop detected');

    const withDescription = mapSignozAlertToNormalizedEvent(
      baseAlert({ annotations: { description: 'context bloat detected' } }),
    );
    expect(withDescription?.reason).toBe('context bloat detected');

    const withNeither = mapSignozAlertToNormalizedEvent(baseAlert());
    expect(withNeither?.reason).toContain('abc123');
  });

  it('preserves status (firing/resolved) and fingerprint/startsAt for idempotency', () => {
    const resolved = mapSignozAlertToNormalizedEvent(baseAlert({ status: 'resolved' }));
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.fingerprint).toBe('abc123');
    expect(resolved?.startsAt).toBe('2026-07-21T00:00:00Z');
  });

  it('rejects a scope with an empty agentId even if the label key is technically present', () => {
    const result = mapSignozAlertToNormalizedEvent(
      baseAlert({
        labels: { fuse_tenant: 't1', fuse_environment: 'prod', fuse_agent_id: '' },
      }),
    );
    expect(result).toBeUndefined();
  });
});
