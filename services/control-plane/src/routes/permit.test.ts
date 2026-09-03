import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StoreUnavailableError,
  UnknownScopeError,
  type BreakerStore,
} from '@fuse/breaker-store';
import type { Scope } from '@fuse/contracts';
import { registerPermitRoute } from './permit.js';

const addMock = vi.fn();
const operationalAddMock = vi.fn();
const operationalLatencyMock = vi.fn();

vi.mock('@fuse/otel', () => ({
  FUSE_OPERATIONAL_SLO_VERSION: 'v1-provisional',
  getBreakerDecisionCounter: () => ({ add: addMock }),
  getPermitRequestCounter: () => ({ add: operationalAddMock }),
  getPermitLatencyHistogram: () => ({ record: operationalLatencyMock }),
}));

const SCOPE: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-1' };

function fakeStore(permitImpl: BreakerStore['permit']): BreakerStore {
  return { permit: permitImpl } as unknown as BreakerStore;
}

describe('registerPermitRoute: fuse.breaker.permit.decisions is actually recorded', () => {
  beforeEach(() => {
    addMock.mockReset();
    operationalAddMock.mockReset();
    operationalLatencyMock.mockReset();
  });

  it('records the real decision (scope + state + allowed + degraded) on a successful permit', async () => {
    const app = Fastify();
    registerPermitRoute(
      app,
      fakeStore(async () => ({
        allowed: true,
        state: 'armed',
        reason: 'armed',
        epoch: 3,
        degraded: false,
        correlationId: 'c1',
        record: {} as never,
      })),
      'fail-closed',
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      payload: { scope: SCOPE, correlationId: 'c1' },
    });
    expect(res.statusCode).toBe(200);

    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith(1, {
      'fuse.tenant': 't1',
      'fuse.environment': 'test',
      'fuse.agent_id': 'agent-1',
      'fuse.breaker.state': 'armed',
      'fuse.breaker.allowed': true,
      'fuse.breaker.degraded': false,
    });
    expect(operationalAddMock).toHaveBeenCalledWith(1, {
      'fuse.slo.version': 'v1-provisional',
      'fuse.outcome': 'allowed',
    });
    expect(operationalLatencyMock).toHaveBeenCalledWith(expect.any(Number), {
      'fuse.slo.version': 'v1-provisional',
      'fuse.outcome': 'allowed',
    });
    await app.close();
  });

  it('still records a decision (degraded, per the configured outage mode) when the store is unavailable', async () => {
    const app = Fastify();
    registerPermitRoute(
      app,
      fakeStore(async () => {
        throw new StoreUnavailableError('down');
      }),
      'fail-open',
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      payload: { scope: SCOPE, correlationId: 'c1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().allowed).toBe(true); // fail-open

    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith(1, {
      'fuse.tenant': 't1',
      'fuse.environment': 'test',
      'fuse.agent_id': 'agent-1',
      'fuse.breaker.state': 'unknown',
      'fuse.breaker.allowed': true,
      'fuse.breaker.degraded': true,
    });
    expect(operationalAddMock).toHaveBeenCalledWith(1, {
      'fuse.slo.version': 'v1-provisional',
      'fuse.outcome': 'degraded',
    });
    await app.close();
  });

  it('records denial latency without putting scope identity on the SLO series', async () => {
    const app = Fastify();
    registerPermitRoute(
      app,
      fakeStore(async () => ({
        allowed: false,
        state: 'tripped',
        reason: 'loop detector fired',
        epoch: 4,
        degraded: false,
        correlationId: 'deny-correlation',
        record: {} as never,
      })),
      'fail-closed',
    );
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      payload: { scope: SCOPE, correlationId: 'deny-correlation' },
    });

    expect(response.statusCode).toBe(200);
    expect(operationalAddMock).toHaveBeenCalledWith(1, {
      'fuse.slo.version': 'v1-provisional',
      'fuse.outcome': 'denied',
    });
    expect(operationalLatencyMock).toHaveBeenCalledWith(expect.any(Number), {
      'fuse.slo.version': 'v1-provisional',
      'fuse.outcome': 'denied',
    });
    expect(operationalLatencyMock.mock.calls[0]?.[1]).not.toHaveProperty('fuse.tenant');
    await app.close();
  });

  it('resolves store outage mode from the scope policy before applying an outage fallback', async () => {
    const app = Fastify();
    const resolveMode = vi.fn(() => 'fail-open' as const);
    registerPermitRoute(
      app,
      fakeStore(async () => {
        throw new StoreUnavailableError('down');
      }),
      resolveMode,
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      payload: { scope: SCOPE, correlationId: 'policy-outage-mode' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      allowed: true,
      degraded: true,
      reason: 'store unavailable: applying configured outage mode (fail-open)',
    });
    expect(resolveMode).toHaveBeenCalledWith(SCOPE);
    await app.close();
  });

  it('does not record a decision for a malformed request that never reaches the store', async () => {
    const app = Fastify();
    registerPermitRoute(
      app,
      fakeStore(async () => {
        throw new Error('should never be called');
      }),
      'fail-closed',
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      payload: { scope: { tenant: '' }, correlationId: 'c1' },
    });
    expect(res.statusCode).toBe(400);
    expect(addMock).not.toHaveBeenCalled();
    expect(operationalAddMock).toHaveBeenCalledWith(1, {
      'fuse.slo.version': 'v1-provisional',
      'fuse.outcome': 'client_error',
    });
    await app.close();
  });

  it('rejects an unregistered scope without emitting an arbitrary metric series', async () => {
    const app = Fastify();
    registerPermitRoute(
      app,
      fakeStore(async () => {
        throw new UnknownScopeError('scope is not registered');
      }),
      'fail-closed',
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      payload: { scope: SCOPE, correlationId: 'c1' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('unknown_scope');
    expect(addMock).not.toHaveBeenCalled();
    expect(operationalAddMock).toHaveBeenCalledWith(1, {
      'fuse.slo.version': 'v1-provisional',
      'fuse.outcome': 'client_error',
    });
    await app.close();
  });
});
