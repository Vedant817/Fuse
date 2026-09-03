import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnknownScopeError, type PreflightStore } from '@fuse/breaker-store';
import type { Scope } from '@fuse/contracts';
import { registerPreflightRoutes } from './preflight.js';

const recordMock = vi.fn();
const selfAlertRecordMock = vi.fn();
const transitionAddMock = vi.fn();
const operationalEvaluationMock = vi.fn();

vi.mock('@fuse/otel', () => ({
  FUSE_OPERATIONAL_SLO_VERSION: 'v1-provisional',
  getPreflightEvaluationCounter: () => ({ add: operationalEvaluationMock }),
  getPreflightStateGauge: () => ({
    record: recordMock,
    recordSelfAlertState: (active: boolean, attributes: Record<string, string>) => {
      selfAlertRecordMock(active ? 1 : 0, attributes);
    },
    recordSelfAlertTransition: (
      transition: { kind: string; state: string; reasonCode: string },
      attributes: Record<string, string>,
    ) => {
      transitionAddMock(1, {
        ...attributes,
        'fuse.preflight.transition': transition.kind,
        'fuse.preflight.state': transition.state,
        'fuse.preflight.reason_code': transition.reasonCode,
      });
    },
  }),
}));

const SCOPE: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-1' };
const CONFIG = {} as Parameters<typeof registerPreflightRoutes>[2];

function fakeStore(
  evaluateImpl: PreflightStore['evaluateWithTransition'],
): PreflightStore {
  return { evaluateWithTransition: evaluateImpl } as unknown as PreflightStore;
}

describe('registerPreflightRoutes: fuse.preflight.state is actually recorded', () => {
  beforeEach(() => {
    recordMock.mockReset();
    selfAlertRecordMock.mockReset();
    transitionAddMock.mockReset();
    operationalEvaluationMock.mockReset();
  });

  it('records the committed state on a successful report', async () => {
    const app = Fastify();
    registerPreflightRoutes(
      app,
      fakeStore(async () => ({
        result: {
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
        },
        selfAlertTransition: null,
      })),
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

  it('emits one active alert/event on an opening edge and a zero on recovery', async () => {
    const app = Fastify();
    let call = 0;
    registerPreflightRoutes(
      app,
      fakeStore(async () => {
        call += 1;
        const recovered = call === 3;
        const transition =
          call === 1
            ? {
                kind: 'opened' as const,
                fromState: null,
                toState: 'blind' as const,
                reasonCode: 'exporter-delivery-failed' as const,
              }
            : recovered
              ? {
                  kind: 'recovered' as const,
                  fromState: 'blind' as const,
                  toState: 'protected' as const,
                  reasonCode: 'healthy' as const,
                }
              : null;
        return {
          result: {
            scope: SCOPE,
            state: recovered ? 'protected' : 'blind',
            reasonCode: recovered ? 'healthy' : 'exporter-delivery-failed',
            reason: recovered ? 'ok' : 'export failed',
            evaluatedAt: new Date().toISOString(),
            lastGoodAt: recovered ? new Date().toISOString() : null,
            requiredFieldCoveragePercent: recovered ? 100 : 0,
            orphanRatePercent: 0,
            freshnessMs: 0,
            pendingSince: null,
            pendingRecoveryState: null,
          },
          selfAlertTransition: transition,
        };
      }),
      CONFIG,
    );
    await app.ready();

    await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      payload: { scope: SCOPE, spans: [] },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      payload: { scope: SCOPE, spans: [] },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      payload: { scope: SCOPE, spans: [] },
    });

    expect(selfAlertRecordMock.mock.calls.map((args) => args[0])).toEqual([1, 1, 0]);
    expect(transitionAddMock).toHaveBeenCalledTimes(2);
    expect(transitionAddMock.mock.calls[0]![1]).toMatchObject({
      'fuse.preflight.transition': 'opened',
      'fuse.preflight.reason_code': 'exporter-delivery-failed',
    });
    expect(transitionAddMock.mock.calls[1]![1]).toMatchObject({
      'fuse.preflight.transition': 'recovered',
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

  it('rejects an unregistered scope without emitting an arbitrary metric series', async () => {
    const app = Fastify();
    registerPreflightRoutes(
      app,
      fakeStore(async () => {
        throw new UnknownScopeError('scope is not registered');
      }),
      CONFIG,
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/preflight/report',
      payload: { scope: SCOPE, spans: [] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('unknown_scope');
    expect(recordMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('revalidates status reads against persisted evidence before responding', async () => {
    const app = Fastify();
    const getRevalidatedResult = vi.fn(async () => ({
      result: {
        scope: SCOPE,
        state: 'blind' as const,
        reasonCode: 'stale-evidence' as const,
        reason: 'reporter stopped',
        evaluatedAt: new Date().toISOString(),
        lastGoodAt: new Date().toISOString(),
        requiredFieldCoveragePercent: 0,
        orphanRatePercent: 0,
        freshnessMs: 10_000,
        pendingSince: null,
        pendingRecoveryState: null,
      },
      selfAlertTransition: {
        kind: 'opened' as const,
        fromState: 'protected' as const,
        toState: 'blind' as const,
        reasonCode: 'stale-evidence' as const,
      },
    }));
    registerPreflightRoutes(
      app,
      { getRevalidatedResult } as unknown as PreflightStore,
      CONFIG,
    );
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/preflight/status?tenant=t1&environment=test&agentId=agent-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result.state).toBe('blind');
    expect(getRevalidatedResult).toHaveBeenCalledWith(SCOPE, CONFIG);
    expect(transitionAddMock).toHaveBeenCalledOnce();
    await app.close();
  });
});
