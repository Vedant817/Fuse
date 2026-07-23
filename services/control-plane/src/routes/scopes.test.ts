import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  ScopeCapacityExceededError,
  StoreUnavailableError,
  type BreakerStore,
} from '@fuse/breaker-store';
import type { RegisterScopeRequest } from '@fuse/contracts';
import { registerScopeRoutes } from './scopes.js';

const REQUEST: RegisterScopeRequest = {
  scope: { tenant: 'tenant-a', environment: 'production', agentId: 'payments' },
  policyVersion: 'policy-v1',
  actor: { type: 'manual', id: 'operator:alice' },
  reason: 'approved production agent',
  correlationId: 'corr-register-1',
};

function fakeStore(registerScope: BreakerStore['registerScope']): BreakerStore {
  return { registerScope } as unknown as BreakerStore;
}

describe('registerScopeRoutes', () => {
  it('returns 201 for a newly-created registration', async () => {
    const registeredAt = '2026-07-23T12:00:00.000Z';
    const registerScope = vi.fn(async () => ({
      registration: {
        scope: REQUEST.scope,
        policyVersion: REQUEST.policyVersion,
        registeredAt,
        registeredBy: REQUEST.actor,
        reason: REQUEST.reason,
      },
      breaker: {
        scope: REQUEST.scope,
        state: 'armed' as const,
        epoch: 0,
        reason: 'initialized',
        policyVersion: REQUEST.policyVersion,
        cooldownUntil: null,
        updatedAt: registeredAt,
        updatedBy: REQUEST.actor,
      },
      created: true,
    }));
    const app = Fastify();
    registerScopeRoutes(app, fakeStore(registerScope));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/scopes/register',
      payload: REQUEST,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().created).toBe(true);
    expect(registerScope).toHaveBeenCalledWith(REQUEST);
    await app.close();
  });

  it('returns 200 with original metadata for an idempotent replay', async () => {
    const registerScope = vi.fn(async () => ({
      registration: {} as never,
      breaker: {} as never,
      created: false,
    }));
    const app = Fastify();
    registerScopeRoutes(app, fakeStore(registerScope));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/scopes/register',
      payload: REQUEST,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().created).toBe(false);
    await app.close();
  });

  it('rejects malformed input before touching the store', async () => {
    const registerScope = vi.fn();
    const app = Fastify();
    registerScopeRoutes(app, fakeStore(registerScope));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/scopes/register',
      payload: { ...REQUEST, reason: '' },
    });

    expect(response.statusCode).toBe(400);
    expect(registerScope).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns stable capacity and outage errors', async () => {
    const capacityApp = Fastify();
    registerScopeRoutes(
      capacityApp,
      fakeStore(async () => {
        throw new ScopeCapacityExceededError('tenant is full');
      }),
    );
    const capacity = await capacityApp.inject({
      method: 'POST',
      url: '/v1/scopes/register',
      payload: REQUEST,
    });
    expect(capacity.statusCode).toBe(409);
    expect(capacity.json().error).toBe('scope_capacity_exceeded');
    await capacityApp.close();

    const outageApp = Fastify();
    registerScopeRoutes(
      outageApp,
      fakeStore(async () => {
        throw new StoreUnavailableError('down');
      }),
    );
    const outage = await outageApp.inject({
      method: 'POST',
      url: '/v1/scopes/register',
      payload: REQUEST,
    });
    expect(outage.statusCode).toBe(503);
    expect(outage.json().error).toBe('store_unavailable');
    await outageApp.close();
  });
});
