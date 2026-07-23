import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreflightStore } from '@fuse/breaker-store';
import type { Scope } from '@fuse/contracts';
import { registerPreflightRoutes } from './preflight.js';

const recordMock = vi.fn();

vi.mock('@fuse/otel', () => ({
  getPreflightStateGauge: () => ({ record: recordMock }),
}));

const SCOPE: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-1' };
const CONFIG = {} as Parameters<typeof registerPreflightRoutes>[2];

function fakeStore(evaluateImpl: PreflightStore['evaluate']): PreflightStore {
  return { evaluate: evaluateImpl } as unknown as PreflightStore;
}

describe('registerPreflightRoutes: fuse.preflight.state is actually recorded', () => {
  beforeEach(() => {
    recordMock.mockReset();
  });

  it('records the committed state on a successful report', async () => {
    const app = Fastify();
    registerPreflightRoutes(
      app,
      fakeStore(async () => ({
        scope: SCOPE,
        state: 'protected',
        reasonCode: 'healthy',
        reason: 'ok',
        evaluatedAt: new Date().toISOString(),
        lastGoodAt: new Date().toISOString(),
        requiredFieldCoveragePercent: 100,
        orphanRatePercent: 0,
        freshnessMs: 0,
        pendingSince: null,
        pendingRecoveryState: null,
      })) as unknown as PreflightStore,
      CONFIG,
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      payload: { scope: SCOPE, spans: [] },
    });
    expect(res.statusCode).toBe(200);

    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(1, {
      'fuse.tenant': 't1',
      'fuse.environment': 'test',
      'fuse.agent_id': 'agent-1',
      'fuse.preflight.state': 'protected',
    });
    await app.close();
  });

  it('does not record anything for a malformed request that never reaches the store', async () => {
    const app = Fastify();
    registerPreflightRoutes(
      app,
      fakeStore(async () => {
        throw new Error('should never be called');
      }),
      CONFIG,
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      payload: { scope: { tenant: '' }, spans: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(recordMock).not.toHaveBeenCalled();
    await app.close();
  });
});
