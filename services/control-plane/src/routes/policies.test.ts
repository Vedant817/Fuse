import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnknownScopeError, type BreakerStore } from '@fuse/breaker-store';
import { registerPolicyRoutes } from './policies.js';

const SCOPE = { tenant: 'tenant-a', environment: 'prod', agentId: 'agent-1' };

describe('effective policy route', () => {
  const assertScopeRegistered = vi.fn();
  const resolvePolicy = vi.fn();
  const store = { assertScopeRegistered } as unknown as BreakerStore;

  beforeEach(() => {
    assertScopeRegistered.mockReset().mockResolvedValue(undefined);
    resolvePolicy.mockReset().mockReturnValue({
      policyVersion: 'production-v3',
      cooldownSeconds: 300,
      storeOutageMode: 'fail-closed',
      controlPlaneOutageMode: 'fail-closed',
      notificationRoutes: ['slack'],
      detectors: {
        'context-bloat': {
          absoluteCeilingTokens: 100_000,
          minConsecutiveGrowthSteps: 5,
          minGrowthRatio: 3,
          minInputTokensForGrowthSignal: 8_000,
          minStepsRequired: 4,
        },
      },
    });
  });

  it('returns the resolved policy for a registered scope', async () => {
    const app = Fastify();
    registerPolicyRoutes(app, store, resolvePolicy);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/policies/effective?tenant=tenant-a&environment=prod&agentId=agent-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: SCOPE,
      policy: { policyVersion: 'production-v3', cooldownSeconds: 300 },
    });
    expect(resolvePolicy).toHaveBeenCalledWith(SCOPE);
    await app.close();
  });

  it('rejects an unknown scope without resolving a policy', async () => {
    assertScopeRegistered.mockRejectedValueOnce(new UnknownScopeError('unknown'));
    const app = Fastify();
    registerPolicyRoutes(app, store, resolvePolicy);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/policies/effective?tenant=tenant-a&environment=prod&agentId=missing',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('unknown_scope');
    expect(resolvePolicy).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects malformed scope queries', async () => {
    const app = Fastify();
    registerPolicyRoutes(app, store, resolvePolicy);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/policies/effective?tenant=tenant-a&environment=prod',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
    await app.close();
  });
});
