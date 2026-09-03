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
import { DemoThresholdTrigger } from './demo-threshold-trigger.js';

const API_TOKEN = 'demo-threshold-integration-test-token-01234';
const POLICY_VERSION = 'demo-hardcoded-threshold-v1';

/**
 * End-to-end proof of task.md §2.3's "hardcoded trigger": threshold ->
 * atomic trip -> next pre-call denied -> structured audit event, with the
 * trip fired automatically by a hardcoded call-count watcher rather than a
 * manually invoked HTTP call. This is the crude, explicitly-labeled
 * demo-only trigger that de-risks the enforcement path before real
 * SigNoz-driven detectors exist (task.md §4).
 */
describe('DemoThresholdTrigger end-to-end: threshold -> trip -> next call denied', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let controlPlane: FastifyInstance;
  let controlPlaneUrl: string;
  let fakeProvider: FakeProvider;
  const registeredScopes: Scope[] = [];
  // node-postgres emits 'error' on idle clients whose backend the server
  // terminates; without a listener that is an uncaught exception. Record
  // mid-test errors so the suite still fails loudly, but stop recording at
  // teardown where container SIGTERM (57P01) after pool.end() is benign.
  let tearingDownPool = false;
  const poolErrors: unknown[] = [];

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
    pool.on('error', (err) => {
      if (!tearingDownPool) poolErrors.push(err);
    });
    await runMigrations(pool);
    const store = new BreakerStore(pool);
    for (let index = 0; index < 4; index++) {
      const scope: Scope = {
        tenant: 't1',
        environment: 'test',
        agentId: `agent-registered-${index}-${randomUUID().slice(0, 8)}`,
      };
      await store.registerScope({
        scope,
        policyVersion: POLICY_VERSION,
        actor: { type: 'system', id: 'test:setup' },
        reason: 'integration test registration',
        correlationId: `setup-${index}`,
      });
      registeredScopes.push(scope);
    }
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
        exporterEvidenceTokens: [],
        webhookTokens: [],
        webhookDefaultPolicyVersion: 'signoz-webhook-v1',
        webhookDefaultCooldownSeconds: 300,
        webhookMaxAlertAgeMs: 600_000,
        webhookMaxClockSkewAheadMs: 60_000,
        dbPoolMax: 10,
        dbPoolIdleTimeoutMs: 30_000,
        dbPoolConnectionTimeoutMs: 2_000,
        dbStatementTimeoutMs: 5_000,
        maxRegisteredScopesPerTenant: 10_000,
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
    tearingDownPool = true;
    await controlPlane.close();
    await pool.end();
    await pgContainer.stop();
    await fakeProvider.close();
    expect(poolErrors).toEqual([]);
  });

  function scopeFor(name: string): Scope {
    const scope = registeredScopes.pop();
    if (!scope) throw new Error(`registered scope pool exhausted at ${name}`);
    return scope;
  }

  it('trips automatically once the hardcoded call-count threshold is exceeded, denying the very next call', async () => {
    const scope = scopeFor('threshold-trigger');
    const guard = new FuseGuard({
      scope,
      controlPlaneUrl,
      apiToken: API_TOKEN,
      timeoutMs: 2000,
    });

    let tripFired = false;
    const trigger = new DemoThresholdTrigger({
      maxCallsPerWindow: 3,
      windowMs: 10_000,
      trip: async (reason) => {
        const res = await fetch(`${controlPlaneUrl}/v1/breaker/trip`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${API_TOKEN}`,
          },
          body: JSON.stringify({
            scope,
            reason,
            policyVersion: POLICY_VERSION,
            cooldownSeconds: 60,
            actor: { type: 'system', id: 'system:demo-hardcoded-threshold' },
            correlationId: `trip-${randomUUID()}`,
            idempotencyKey: `idem-${randomUUID()}`,
          }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          record: { state: string };
          auditEvent: { toState: string };
        };
        expect(body.record.state).toBe('tripped');
        expect(body.auditEvent.toState).toBe('tripped'); // structured audit event, per §2.3
        tripFired = true;
      },
    });

    const before = fakeProvider.requestCount();

    // Calls 1-3 stay at the threshold (maxCallsPerWindow=3, trip fires only
    // when the window count exceeds it) and succeed without tripping.
    for (let i = 0; i < 3; i++) {
      await guard.guard(() => callFakeProvider(fakeProvider.url));
      await trigger.recordCall();
    }
    expect(tripFired).toBe(false);
    expect(fakeProvider.requestCount() - before).toBe(3);

    // Call 4 pushes the window to 4 > 3, so recordCall() fires the trip
    // itself — no external actor decided this, the hardcoded watcher did.
    await guard.guard(() => callFakeProvider(fakeProvider.url));
    const firedOnThisCall = await trigger.recordCall();
    expect(firedOnThisCall).toBe(true);
    expect(tripFired).toBe(true);
    expect(fakeProvider.requestCount() - before).toBe(4);

    // The next pre-call is denied — the committed trip blocks it, and the
    // fake provider (a real HTTP server) receives no additional request.
    await expect(guard.guard(() => callFakeProvider(fakeProvider.url))).rejects.toThrow(
      BreakerTrippedError,
    );
    expect(fakeProvider.requestCount() - before).toBe(4); // unchanged
  });
});
