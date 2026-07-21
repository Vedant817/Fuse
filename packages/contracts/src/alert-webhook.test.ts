import { describe, expect, it } from 'vitest';
import {
  NormalizedAlertEventSchema,
  SignozAlertmanagerWebhookPayloadSchema,
} from './alert-webhook.js';

const VALID_ALERT = {
  status: 'firing' as const,
  labels: {
    fuse_tenant: 't1',
    fuse_environment: 'prod',
    fuse_agent_id: 'agent-1',
    fuse_detector: 'loop-signature',
  },
  annotations: { summary: 'loop detected' },
  startsAt: '2026-07-21T00:00:00Z',
  fingerprint: 'abc123',
};

describe('SignozAlertmanagerWebhookPayloadSchema', () => {
  it('accepts a realistic Alertmanager-shaped payload', () => {
    const result = SignozAlertmanagerWebhookPayloadSchema.safeParse({
      version: '4',
      groupKey: '{}:{alertname="LoopSignature"}',
      status: 'firing',
      receiver: 'fuse-webhook',
      groupLabels: { alertname: 'LoopSignature' },
      commonLabels: { alertname: 'LoopSignature' },
      commonAnnotations: {},
      externalURL: 'http://signoz.internal',
      alerts: [VALID_ALERT],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a payload with zero alerts', () => {
    expect(
      SignozAlertmanagerWebhookPayloadSchema.safeParse({
        status: 'firing',
        alerts: [],
      }).success,
    ).toBe(false);
  });

  it('rejects more than 200 alerts (bounding a single delivery)', () => {
    const alerts = Array.from({ length: 201 }, (_, i) => ({
      ...VALID_ALERT,
      fingerprint: `f${i}`,
    }));
    expect(
      SignozAlertmanagerWebhookPayloadSchema.safeParse({ status: 'firing', alerts })
        .success,
    ).toBe(false);
  });

  it('rejects an alert with an invalid status', () => {
    expect(
      SignozAlertmanagerWebhookPayloadSchema.safeParse({
        status: 'firing',
        alerts: [{ ...VALID_ALERT, status: 'unknown-status' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an alert missing a fingerprint', () => {
    const { fingerprint: _fingerprint, ...withoutFingerprint } = VALID_ALERT;
    expect(
      SignozAlertmanagerWebhookPayloadSchema.safeParse({
        status: 'firing',
        alerts: [withoutFingerprint],
      }).success,
    ).toBe(false);
  });

  it('rejects non-string label values', () => {
    expect(
      SignozAlertmanagerWebhookPayloadSchema.safeParse({
        status: 'firing',
        alerts: [{ ...VALID_ALERT, labels: { fuse_tenant: 123 } }],
      }).success,
    ).toBe(false);
  });
});

describe('NormalizedAlertEventSchema', () => {
  it('accepts a valid normalized event', () => {
    const result = NormalizedAlertEventSchema.safeParse({
      scope: { tenant: 't1', environment: 'prod', agentId: 'agent-1' },
      status: 'firing',
      detector: 'loop-signature',
      reason: 'loop detected',
      fingerprint: 'abc123',
      startsAt: '2026-07-21T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an oversized reason', () => {
    expect(
      NormalizedAlertEventSchema.safeParse({
        scope: { tenant: 't1', environment: 'prod', agentId: 'agent-1' },
        status: 'firing',
        detector: 'loop-signature',
        reason: 'x'.repeat(3000),
        fingerprint: 'abc123',
        startsAt: '2026-07-21T00:00:00Z',
      }).success,
    ).toBe(false);
  });
});
