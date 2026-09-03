import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { BreakerStore } from '@fuse/breaker-store';
import type { ControlPlaneConfig } from '../config.js';
import type { ResolvedDetectorPolicy } from '../policy-loader.js';
import { registerWebhookRoutes } from './webhook.js';

const CONFIG = {
  webhookDefaultPolicyVersion: 'policy-v1',
  webhookDefaultCooldownSeconds: 300,
  webhookMaxAlertAgeMs: 600_000,
  webhookMaxClockSkewAheadMs: 60_000,
} as ControlPlaneConfig;

function firingAlert(fingerprint: string, sourceEpoch = '0') {
  return {
    status: 'firing',
    alerts: [
      {
        status: 'firing',
        labels: {
          fuse_tenant: 't1',
          fuse_environment: 'prod',
          fuse_agent_id: 'agent-1',
          fuse_detector: 'loop-signature',
          fuse_source_epoch: sourceEpoch,
        },
        annotations: { summary: 'loop detected' },
        startsAt: new Date().toISOString(),
        fingerprint,
      },
    ],
  };
}

function policy(overrides: Partial<ResolvedDetectorPolicy> = {}): ResolvedDetectorPolicy {
  return {
    policyVersion: 'scope-policy-v7',
    cooldownSeconds: 47,
    storeOutageMode: 'fail-closed',
    controlPlaneOutageMode: 'fail-closed',
    detectors: {},
    notificationRoutes: ['slack'],
    ...overrides,
  };
}

describe('SigNoz webhook notification idempotency', () => {
  it('does not notify again when the durable trip result is an idempotency replay', async () => {
    const trip = vi.fn().mockResolvedValue({
      kind: 'applied',
      noop: false,
      replayed: true,
    });
    const app = Fastify();
    registerWebhookRoutes(
      app,
      { getRecord: vi.fn().mockResolvedValue(null), trip } as unknown as BreakerStore,
      CONFIG,
    );
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      payload: firingAlert('replayed-alert'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([
      { fingerprint: 'replayed-alert', outcome: 'tripped' },
    ]);
    expect(trip).toHaveBeenCalledOnce();
    await app.close();
  });

  it('uses the exact effective scope policy and atomically requests Slack delivery', async () => {
    const trip = vi.fn().mockResolvedValue({
      kind: 'applied',
      noop: false,
      replayed: false,
      record: { epoch: 9 },
    });
    const resolvePolicy = vi.fn().mockReturnValue(policy());
    const app = Fastify();
    registerWebhookRoutes(
      app,
      { getRecord: vi.fn().mockResolvedValue(null), trip } as unknown as BreakerStore,
      CONFIG,
      resolvePolicy,
    );
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      payload: firingAlert('scope-policy-alert'),
    });

    expect(response.statusCode).toBe(200);
    expect(resolvePolicy).toHaveBeenCalledWith({
      tenant: 't1',
      environment: 'prod',
      agentId: 'agent-1',
    });
    expect(trip).toHaveBeenCalledWith(
      expect.objectContaining({
        policyVersion: 'scope-policy-v7',
        cooldownSeconds: 47,
      }),
      expect.objectContaining({
        detector: 'loop-signature',
        notifySlack: true,
      }),
    );
    await app.close();
  });

  it('persists a diagnosis job without Slack delivery when policy excludes Slack', async () => {
    const trip = vi.fn().mockResolvedValue({
      kind: 'applied',
      noop: false,
      replayed: false,
      record: { epoch: 3 },
    });
    const app = Fastify();
    registerWebhookRoutes(
      app,
      { getRecord: vi.fn().mockResolvedValue(null), trip } as unknown as BreakerStore,
      CONFIG,
      () => policy({ notificationRoutes: [] }),
    );
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      payload: firingAlert('no-slack-alert'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([
      { fingerprint: 'no-slack-alert', outcome: 'tripped' },
    ]);
    expect(trip).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ notifySlack: false }),
    );
    await app.close();
  });

  it('binds the trip to the observed epoch so a concurrent resume cannot be undone', async () => {
    const trip = vi.fn().mockResolvedValue({
      kind: 'rejected',
      code: 'stale_epoch',
      message: 'expected epoch 4, current epoch is 5',
    });
    const app = Fastify();
    registerWebhookRoutes(
      app,
      {
        getRecord: vi.fn().mockResolvedValue({
          state: 'armed',
          epoch: 4,
          updatedAt: new Date(Date.now() - 5_000).toISOString(),
        }),
        trip,
      } as unknown as BreakerStore,
      CONFIG,
      () => policy(),
    );
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      payload: firingAlert('resume-race-alert', '4'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([
      { fingerprint: 'resume-race-alert', outcome: 'stale-epoch' },
    ]);
    expect(trip).toHaveBeenCalledWith(
      expect.objectContaining({ expectedEpoch: 4 }),
      expect.any(Object),
    );
    await app.close();
  });

  it('accepts the maximum 200-alert batch without spawning route-level delivery work', async () => {
    const trip = vi.fn().mockResolvedValue({
      kind: 'applied',
      noop: false,
      replayed: false,
      record: { epoch: 1 },
    });
    const app = Fastify();
    registerWebhookRoutes(
      app,
      { getRecord: vi.fn().mockResolvedValue(null), trip } as unknown as BreakerStore,
      CONFIG,
      () => policy(),
    );
    await app.ready();
    const template = firingAlert('template').alerts[0]!;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      payload: {
        status: 'firing',
        alerts: Array.from({ length: 200 }, (_, index) => ({
          ...template,
          fingerprint: `batch-${index}`,
        })),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results).toHaveLength(200);
    expect(trip).toHaveBeenCalledTimes(200);
    expect(trip.mock.calls.every((call) => call[1]?.notifySlack === true)).toBe(true);
    await app.close();
  });

  it.each([
    ['missing', undefined],
    ['negative', '-1'],
    ['non-integer', '1.5'],
    ['unsafe', String(Number.MAX_SAFE_INTEGER + 1)],
  ])('observes a %s source epoch without mutating state', async (_name, sourceEpoch) => {
    const trip = vi.fn();
    const getRecord = vi.fn();
    const payload = firingAlert(`unbound-${_name}`);
    if (sourceEpoch === undefined) {
      delete (payload.alerts[0]!.labels as Record<string, string>)['fuse_source_epoch'];
    } else {
      payload.alerts[0]!.labels.fuse_source_epoch = sourceEpoch;
    }
    const app = Fastify();
    registerWebhookRoutes(
      app,
      { getRecord, trip } as unknown as BreakerStore,
      CONFIG,
      () => policy(),
    );
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([
      { fingerprint: `unbound-${_name}`, outcome: 'unbound-alert' },
    ]);
    expect(getRecord).not.toHaveBeenCalled();
    expect(trip).not.toHaveBeenCalled();
    await app.close();
  });

  it('hashes an oversized fingerprint before using bounded persisted identifiers', async () => {
    const oversizedFingerprint = 'f'.repeat(20_000);
    const trip = vi.fn().mockResolvedValue({ kind: 'applied', noop: false });
    const app = Fastify();
    registerWebhookRoutes(app, { trip } as unknown as BreakerStore, CONFIG, () =>
      policy(),
    );
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      payload: firingAlert(oversizedFingerprint, '17'),
    });

    expect(response.statusCode).toBe(200);
    const request = trip.mock.calls[0]![0];
    expect(request.expectedEpoch).toBe(17);
    expect(request.correlationId).toMatch(/^signoz:[a-f0-9]{64}$/);
    expect(request.idempotencyKey).toBe(request.correlationId);
    expect(request.correlationId.length).toBeLessThanOrEqual(200);
    expect(request.correlationId).not.toContain(oversizedFingerprint.slice(0, 100));
    await app.close();
  });
});
