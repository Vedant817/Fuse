import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { BreakerStore } from '@fuse/breaker-store';
import type { ControlPlaneConfig } from '../config.js';
import type { DiagnosisWorkerConfig } from '../diagnosis-worker.js';
import { registerWebhookRoutes } from './webhook.js';

const CONFIG = {
  webhookDefaultPolicyVersion: 'policy-v1',
  webhookDefaultCooldownSeconds: 300,
  webhookMaxAlertAgeMs: 600_000,
  webhookMaxClockSkewAheadMs: 60_000,
} as ControlPlaneConfig;

const DIAGNOSIS_CONFIG = {
  mcpServerUrl: undefined,
  slackBotToken: undefined,
  slackChannel: 'C_TEST',
  localSnapshotDir: '/tmp/unused',
  slackSigningSecret: undefined,
  operatorToken: undefined,
} as DiagnosisWorkerConfig;

describe('SigNoz webhook notification idempotency', () => {
  it('does not notify again when the durable trip result is an idempotency replay', async () => {
    const trip = vi.fn().mockResolvedValue({
      kind: 'applied',
      noop: false,
      replayed: true,
    });
    const diagnose = vi.fn().mockResolvedValue(undefined);
    const app = Fastify();
    registerWebhookRoutes(
      app,
      { trip } as unknown as BreakerStore,
      CONFIG,
      DIAGNOSIS_CONFIG,
      diagnose,
    );
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/signoz',
      payload: {
        status: 'firing',
        alerts: [
          {
            status: 'firing',
            labels: {
              fuse_tenant: 't1',
              fuse_environment: 'prod',
              fuse_agent_id: 'agent-1',
              fuse_detector: 'loop-signature',
            },
            annotations: { summary: 'loop detected' },
            startsAt: new Date().toISOString(),
            fingerprint: 'replayed-alert',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([
      { fingerprint: 'replayed-alert', outcome: 'tripped' },
    ]);
    expect(diagnose).not.toHaveBeenCalled();
    await app.close();
  });
});
