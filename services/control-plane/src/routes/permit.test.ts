import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreUnavailableError, type BreakerStore } from '@fuse/breaker-store';
import type { Scope } from '@fuse/contracts';
import { registerPermitRoute } from './permit.js';

const addMock = vi.fn();

vi.mock('@fuse/otel', () => ({
  getBreakerDecisionCounter: () => ({ add: addMock }),
}));

const SCOPE: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-1' };

function fakeStore(permitImpl: BreakerStore['permit']): BreakerStore {
  return { permit: permitImpl } as unknown as BreakerStore;
}

describe('registerPermitRoute: fuse.breaker.permit.decisions is actually recorded', () => {
  beforeEach(() => {
    addMock.mockReset();
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
    await app.close();
  });
});
