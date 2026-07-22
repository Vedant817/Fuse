import { randomUUID } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@fuse/control-plane';
import { BreakerStore, PreflightStore, runMigrations } from '@fuse/breaker-store';
import type { Scope } from '@fuse/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FuseGuard } from './guard.js';
import { BreakerTrippedError } from './errors.js';
import { callFakeProvider, startFakeProvider, type FakeProvider } from './testing.js';

const API_TOKEN = 'sdk-integration-test-token-0123456789';
const POLICY_VERSION = 'demo-hardcoded-threshold-v1';

/**
 * This is the load-bearing proof for Fuse's central product claim: once a
 * trip is committed, the middleware prevents the next model-provider
 * request from being dispatched. Every request in this file goes over a
 * real HTTP connection (control plane on a real listening port, fake
 * provider on a real listening port) — nothing here is an in-process
 * function-call count standing in for network behavior.
 */
describe('FuseGuard end-to-end: dispatch-counter proof against a real HTTP control plane', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let controlPlane: FastifyInstance;
  let controlPlaneUrl: string;
  let fakeProvider: FakeProvider;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
    await runMigrations(pool);
    const store = new BreakerStore(pool);
    const preflightStore = new PreflightStore(pool);
    controlPlane = await buildApp({
      store,
      preflightStore,
      pool,
      config: {
        port: 0,
        host: '127.0.0.1',
        logLevel: 'silent',
        deploymentEnvironment: 'test',
        databaseUrl: pgContainer.getConnectionUri(),
        storeOutageMode: 'fail-closed',
        apiTokens: [API_TOKEN],
        agentApiTokens: [],
        webhookTokens: [],
        webhookDefaultPolicyVersion: 'signoz-webhook-v1',
        webhookDefaultCooldownSeconds: 300,
        webhookMaxAlertAgeMs: 600_000,
        webhookMaxClockSkewAheadMs: 60_000,
        dbPoolMax: 10,
        dbPoolIdleTimeoutMs: 30_000,
        dbPoolConnectionTimeoutMs: 2_000,
        dbStatementTimeoutMs: 5_000,
        rateLimitMax: 120,
        rateLimitWindowMs: 60_000,
        preflightWindowMs: 5 * 60_000,
        preflightBlindCoverageThreshold: 0.5,
        preflightBlindOrphanRateThreshold: 0.5,
        preflightBlindTokenMissingRateThreshold: 0.3,
        preflightHeartbeatGraceMs: 2 * 60_000,
        preflightMaxEvidenceStalenessMs: 5 * 60_000,
        preflightMinRecoveryDwellMs: 60_000,
      },
    });
    await controlPlane.listen({ port: 0, host: '127.0.0.1' });
    const address = controlPlane.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('control plane failed to bind');
    controlPlaneUrl = `http://127.0.0.1:${address.port}`;

    fakeProvider = await startFakeProvider();
  }, 120_000);

  afterAll(async () => {
    await controlPlane.close();
    await pool.end();
    await pgContainer.stop();
    await fakeProvider.close();
  });

  function scopeFor(name: string): Scope {
    return {
      tenant: 't1',
      environment: 'test',
      agentId: `agent-${name}-${randomUUID().slice(0, 8)}`,
    };
  }

  function guardFor(scope: Scope): FuseGuard {
    return new FuseGuard({
      scope,
      controlPlaneUrl,
      apiToken: API_TOKEN,
      timeoutMs: 2000,
    });
  }

  async function tripViaHardcodedThreshold(
    scope: Scope,
    cooldownSeconds = 60,
  ): Promise<void> {
    const res = await fetch(`${controlPlaneUrl}/v1/breaker/trip`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        scope,
        reason: 'demo hardcoded threshold: call count exceeded 3 in 10s window',
        policyVersion: POLICY_VERSION,
        cooldownSeconds,
        actor: { type: 'system', id: 'system:demo-hardcoded-threshold' },
        correlationId: `trip-${randomUUID()}`,
        idempotencyKey: `idem-${randomUUID()}`,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { record: { state: string } };
    expect(body.record.state).toBe('tripped');
  }

  it('while armed, guarded calls reach the real provider endpoint', async () => {
    const scope = scopeFor('armed-path');
    const guard = guardFor(scope);
    const before = fakeProvider.requestCount();

    for (let i = 0; i < 3; i++) {
      const result = await guard.guard(() => callFakeProvider(fakeProvider.url));
      expect(result).toMatchObject({ ok: true });
    }

    expect(fakeProvider.requestCount() - before).toBe(3);
  });

  it('after a committed trip, zero provider requests occur — sequential calls', async () => {
    const scope = scopeFor('trip-then-zero');
    const guard = guardFor(scope);

    // Establish a baseline successful call so we know the wiring works.
    await guard.guard(() => callFakeProvider(fakeProvider.url));
    const beforeTrip = fakeProvider.requestCount();

    await tripViaHardcodedThreshold(scope);

    const attempts = 10;
    let deniedCount = 0;
    for (let i = 0; i < attempts; i++) {
      try {
        await guard.guard(() => callFakeProvider(fakeProvider.url));
      } catch (err) {
        if (err instanceof BreakerTrippedError) deniedCount += 1;
        else throw err;
      }
    }

    expect(deniedCount).toBe(attempts);
    expect(fakeProvider.requestCount()).toBe(beforeTrip); // exactly zero new requests
  });

  it('after a committed trip, zero provider requests occur — concurrent calls racing the trip', async () => {
    const scope = scopeFor('trip-then-zero-concurrent');
    const guard = guardFor(scope);
    await guard.guard(() => callFakeProvider(fakeProvider.url));

    await tripViaHardcodedThreshold(scope);
    const afterTripCount = fakeProvider.requestCount();

    // Fire many concurrent guarded calls *after* the trip has already been
    // confirmed committed (the HTTP response above returned). None of these
    // may reach the provider, however tightly they race each other.
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () =>
        guard.guard(() => callFakeProvider(fakeProvider.url)),
      ),
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(
      results.every(
        (r) =>
          r.status === 'rejected' && (r.reason as Error) instanceof BreakerTrippedError,
      ),
    ).toBe(true);
    expect(fakeProvider.requestCount()).toBe(afterTripCount); // still zero new requests
  });

  it('measures in-flight exposure: calls already past their permit check when the trip commits may still complete', async () => {
    // This documents the honest limitation (task.md §2.3): Fuse cannot
    // cancel a provider request that already started before the trip
    // committed. We simulate "already past permit, mid-dispatch" by
    // invoking the fake provider directly (bypassing guard()), timed
    // around the trip call, and confirm the count of such pre-existing
    // in-flight calls is exactly and only the ones started beforehand —
    // no additional guarded call after the trip response returns is ever
    // counted alongside them.
    const scope = scopeFor('in-flight-exposure');
    const guard = guardFor(scope);
    await guard.guard(() => callFakeProvider(fakeProvider.url));
    const before = fakeProvider.requestCount();

    const inFlightBeforeTrip = [
      callFakeProvider(fakeProvider.url),
      callFakeProvider(fakeProvider.url),
    ];
    await tripViaHardcodedThreshold(scope);
    await Promise.all(inFlightBeforeTrip);

    expect(fakeProvider.requestCount() - before).toBe(2); // the 2 in-flight calls, and only those

    await expect(guard.guard(() => callFakeProvider(fakeProvider.url))).rejects.toThrow(
      BreakerTrippedError,
    );
    expect(fakeProvider.requestCount() - before).toBe(2); // no further growth
  });

  it('a manual resume restores provider access', async () => {
    const scope = scopeFor('resume-restores');
    const guard = guardFor(scope);
    await tripViaHardcodedThreshold(scope);
    await expect(guard.guard(() => callFakeProvider(fakeProvider.url))).rejects.toThrow(
      BreakerTrippedError,
    );

    const resumeRes = await fetch(`${controlPlaneUrl}/v1/breaker/resume`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        scope,
        reason: 'operator verified fix, resuming',
        actor: { type: 'manual', id: 'user:oncall' },
        correlationId: `resume-${randomUUID()}`,
        idempotencyKey: `idem-${randomUUID()}`,
      }),
    });
    expect(resumeRes.status).toBe(200);

    const result = await guard.guard(() => callFakeProvider(fakeProvider.url));
    expect(result).toMatchObject({ ok: true });
  });

  it('recordSpanTelemetry + flush makes this scope visible as protected via the real Preflight API', async () => {
    const scope = scopeFor('preflight-live-wiring');
    const guard = guardFor(scope);

    const statusBefore = await fetch(
      `${controlPlaneUrl}/v1/preflight/status?tenant=${scope.tenant}&environment=${scope.environment}&agentId=${scope.agentId}`,
      { headers: { authorization: `Bearer ${API_TOKEN}` } },
    );
    expect(statusBefore.status).toBe(404); // never reported yet

    guard.recordSpanTelemetry({
      timestampMs: Date.now(),
      hasRequestModel: true,
      hasInputTokens: true,
      hasOutputTokens: true,
      hasScopedIdentity: true,
      hasValidTimestamps: true,
      isRootSpan: true,
      hasParent: false,
    });
    await guard.flushPreflightTelemetry();

    const statusAfter = await fetch(
      `${controlPlaneUrl}/v1/preflight/status?tenant=${scope.tenant}&environment=${scope.environment}&agentId=${scope.agentId}`,
      { headers: { authorization: `Bearer ${API_TOKEN}` } },
    );
    expect(statusAfter.status).toBe(200);
    const body = (await statusAfter.json()) as { result: { state: string } };
    expect(body.result.state).toBe('protected');
    guard.stopPreflightReporting();
  });
});
