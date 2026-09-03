import { randomUUID } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, BreakerStore, PreflightStore } from '@fuse/breaker-store';
import type { Scope } from '@fuse/contracts';
import { buildApp } from './app.js';
import type { ControlPlaneConfig } from './config.js';

const VALID_TOKEN = 'a'.repeat(32);
const CONFIG: ControlPlaneConfig = {
  port: 0,
  host: '127.0.0.1',
  logLevel: 'silent',
  deploymentEnvironment: 'test',
  databaseUrl: '',
  dbPoolMax: 10,
  dbPoolIdleTimeoutMs: 30_000,
  dbPoolConnectionTimeoutMs: 2_000,
  dbStatementTimeoutMs: 5_000,
  maxRegisteredScopesPerTenant: 10_000,
  rateLimitMax: 120,
  rateLimitWindowMs: 60_000,
  storeOutageMode: 'fail-closed',
  apiTokens: [VALID_TOKEN],
  agentApiTokens: [],
  exporterEvidenceTokens: [],
  webhookTokens: [],
  webhookDefaultPolicyVersion: 'signoz-webhook-v1',
  webhookDefaultCooldownSeconds: 300,
  webhookMaxAlertAgeMs: 600_000,
  webhookMaxClockSkewAheadMs: 60_000,
  preflightWindowMs: 5 * 60_000,
  preflightBlindCoverageThreshold: 0.5,
  preflightBlindOrphanRateThreshold: 0.5,
  preflightBlindTokenMissingRateThreshold: 0.3,
  preflightHeartbeatGraceMs: 2 * 60_000,
  preflightMaxEvidenceStalenessMs: 5 * 60_000,
  preflightMinRecoveryDwellMs: 60_000,
};

const registeredScopes: Scope[] = [];

function freshScope(name: string): Scope {
  return {
    tenant: 't1',
    environment: 'test',
    agentId: `agent-${name}-${randomUUID().slice(0, 8)}`,
  };
}

function scopeFor(name: string): Scope {
  const scope = registeredScopes.pop();
  if (!scope) throw new Error(`registered test scope pool exhausted at ${name}`);
  return scope;
}

describe('control-plane HTTP API (Postgres integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let app: FastifyInstance;
  // node-postgres emits 'error' on idle clients whose backend the server
  // terminates; without a listener that is an uncaught exception. Record
  // mid-test errors so the suite still fails loudly, but stop recording at
  // teardown where container SIGTERM (57P01) after pool.end() is benign.
  let tearingDownPool = false;
  const poolErrors: unknown[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', (err) => {
      if (!tearingDownPool) poolErrors.push(err);
    });
    await runMigrations(pool);
    const store = new BreakerStore(pool);
    for (let index = 0; index < 40; index++) {
      const scope = freshScope(`registered-${index}`);
      await store.registerScope({
        scope,
        policyVersion: 'test-v1',
        actor: { type: 'system', id: 'test:setup' },
        reason: 'integration test registration',
        correlationId: `setup-${index}`,
      });
      registeredScopes.push(scope);
    }
    const preflightStore = new PreflightStore(pool);
    app = await buildApp({ store, preflightStore, pool, config: CONFIG });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    tearingDownPool = true;
    await app.close();
    await pool.end();
    await container.stop();
    expect(poolErrors).toEqual([]);
  });

  function authed(overrides: Record<string, string> = {}) {
    return { authorization: `Bearer ${VALID_TOKEN}`, ...overrides };
  }

  it('rejects unauthenticated requests to /v1/permit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      payload: { scope: scopeFor('noauth'), correlationId: 'c1' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthenticated');
  });

  it('rejects an invalid bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      headers: authed({ authorization: 'Bearer wrong-token-wrong-token-wrong' }),
      payload: { scope: scopeFor('badtoken'), correlationId: 'c1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows /healthz and /readyz without authentication', async () => {
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe('ready');
  });

  it('permits a fresh scope by default', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      headers: authed(),
      payload: { scope: scopeFor('fresh'), correlationId: 'c1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.allowed).toBe(true);
    expect(body.state).toBe('armed');
  });

  it('applies the configured rate-limit override instead of a source-hardcoded maximum', async () => {
    const limitedApp = await buildApp({
      store: new BreakerStore(pool),
      preflightStore: new PreflightStore(pool),
      pool,
      config: { ...CONFIG, rateLimitMax: 2, rateLimitWindowMs: 60_000 },
    });
    await limitedApp.ready();
    try {
      const target = scopeFor('configured-rate-limit');
      const request = () =>
        limitedApp.inject({
          method: 'POST',
          url: '/v1/permit',
          headers: authed(),
          payload: { scope: target, correlationId: randomUUID() },
        });
      expect((await request()).statusCode).toBe(200);
      expect((await request()).statusCode).toBe(200);
      const limited = await request();
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({
        error: 'rate_limited',
        message: 'rate limit exceeded',
      });
      expect(limited.json().correlationId).toBeTypeOf('string');
    } finally {
      await limitedApp.close();
    }
  });

  it('rejects a malformed permit request with 400 invalid_request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      headers: authed(),
      payload: { scope: { tenant: '' }, correlationId: 'c1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('rejects an oversized request body with 413, not a generic 500 (regression: Fastify framework errors were forced to internal_error)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      headers: authed(),
      payload: {
        scope: scopeFor('oversized'),
        correlationId: 'c1',
        padding: 'x'.repeat(128 * 1024), // well past MAX_BODY_BYTES (64KB)
      },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('invalid_request');
  });

  it('trips a breaker via the operational API and denies the next permit', async () => {
    const scope = scopeFor('trip-http');
    const tripRes = await app.inject({
      method: 'POST',
      url: '/v1/breaker/trip',
      headers: authed(),
      payload: {
        scope,
        reason: 'manual force-trip for test',
        policyVersion: 'demo-hardcoded-threshold-v1',
        cooldownSeconds: 60,
        actor: { type: 'manual', id: 'user:test' },
        correlationId: 'c1',
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    expect(tripRes.statusCode).toBe(200);
    expect(tripRes.json().record.state).toBe('tripped');

    const permitRes = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      headers: authed(),
      payload: { scope, correlationId: 'c2' },
    });
    expect(permitRes.json().allowed).toBe(false);
  });

  it('rejects resume during cooldown with 409 cooldown_active, then allows manual override', async () => {
    const scope = scopeFor('cooldown-http');
    await app.inject({
      method: 'POST',
      url: '/v1/breaker/trip',
      headers: authed(),
      payload: {
        scope,
        reason: 'loop',
        policyVersion: 'v1',
        cooldownSeconds: 3600,
        actor: { type: 'system', id: 'system:detector' },
        correlationId: 'c1',
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });

    const policyResume = await app.inject({
      method: 'POST',
      url: '/v1/breaker/resume',
      headers: authed(),
      payload: {
        scope,
        reason: 'auto',
        actor: { type: 'policy', id: 'policy:auto' },
        correlationId: 'c2',
        idempotencyKey: `idem-${randomUUID()}`,
        expectedEpoch: 1,
      },
    });
    expect(policyResume.statusCode).toBe(409);
    expect(policyResume.json().error).toBe('cooldown_active');

    const manualResume = await app.inject({
      method: 'POST',
      url: '/v1/breaker/resume',
      headers: authed(),
      payload: {
        scope,
        reason: 'human override',
        actor: { type: 'manual', id: 'user:oncall' },
        correlationId: 'c3',
        idempotencyKey: `idem-${randomUUID()}`,
        expectedEpoch: 1,
      },
    });
    expect(manualResume.statusCode).toBe(200);
    expect(manualResume.json().record.state).toBe('armed');
  });

  it('returns 404 unknown_scope for status on a never-seen agent', async () => {
    const scope = freshScope('never-seen');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=${scope.tenant}&environment=${scope.environment}&agentId=${scope.agentId}`,
      headers: authed(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('unknown_scope');
  });

  it('returns the current record for a known scope via status', async () => {
    const scope = scopeFor('status-known');
    await app.inject({
      method: 'POST',
      url: '/v1/permit',
      headers: authed(),
      payload: { scope, correlationId: 'c1' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=${scope.tenant}&environment=${scope.environment}&agentId=${scope.agentId}`,
      headers: authed(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().record.state).toBe('armed');
  });

  it('duplicate trip delivery via HTTP (same idempotency key) returns the same outcome', async () => {
    const scope = scopeFor('http-dup');
    const idempotencyKey = `idem-${randomUUID()}`;
    const payload = {
      scope,
      reason: 'loop',
      policyVersion: 'v1',
      cooldownSeconds: 60,
      actor: { type: 'system', id: 'system:detector' },
      correlationId: 'c1',
      idempotencyKey,
    };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/breaker/trip',
      headers: authed(),
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/breaker/trip',
      headers: authed(),
      payload,
    });
    expect(first.json()).toEqual(second.json());
  });

  it('requires expectedEpoch on resume, disable, and enable requests', async () => {
    const scope = scopeFor('operator-epoch-required');
    for (const action of ['resume', 'disable', 'enable']) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/breaker/${action}`,
        headers: authed(),
        payload: {
          scope,
          reason: `unbound ${action} must fail`,
          actor: { type: 'manual', id: 'user:oncall' },
          correlationId: `corr-unbound-${action}`,
          idempotencyKey: `idem-unbound-${action}`,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_request' });
    }

    const status = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=${scope.tenant}&environment=${scope.environment}&agentId=${scope.agentId}`,
      headers: authed(),
    });
    expect(status.json().record).toMatchObject({ state: 'armed', epoch: 0 });
  });

  it('returns stable structured stale_epoch for delayed resume, disable, and enable', async () => {
    const scope = scopeFor('operator-stale-epoch');
    const trip = await app.inject({
      method: 'POST',
      url: '/v1/breaker/trip',
      headers: authed(),
      payload: {
        scope,
        reason: 'new incident supersedes old operator actions',
        policyVersion: 'v1',
        cooldownSeconds: 0,
        actor: { type: 'system', id: 'system:detector' },
        correlationId: 'corr-trip-before-stale-actions',
        idempotencyKey: 'idem-trip-before-stale-actions',
        expectedEpoch: 0,
      },
    });
    expect(trip.statusCode).toBe(200);

    for (const action of ['resume', 'disable', 'enable']) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/breaker/${action}`,
        headers: authed({ 'x-correlation-id': `http-stale-${action}` }),
        payload: {
          scope,
          reason: `delayed ${action}`,
          actor: { type: 'manual', id: 'user:oncall' },
          correlationId: `body-stale-${action}`,
          idempotencyKey: `idem-stale-${action}`,
          expectedEpoch: 0,
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'stale_epoch',
        message: 'expected epoch 0, current epoch is 1',
        correlationId: `http-stale-${action}`,
      });
    }

    const status = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=${scope.tenant}&environment=${scope.environment}&agentId=${scope.agentId}`,
      headers: authed(),
    });
    expect(status.json().record).toMatchObject({ state: 'tripped', epoch: 1 });
  });

  it('binds an agent credential to one complete scope across permit, Preflight, and detectors without exposing peer scope existence', async () => {
    const scopedStore = new BreakerStore(pool);
    const own: Scope = {
      tenant: 'credential-tenant',
      environment: 'production',
      agentId: `credential-agent-${randomUUID().slice(0, 8)}`,
    };
    const peers: Scope[] = [
      { ...own, tenant: 'peer-tenant' },
      { ...own, environment: 'staging' },
      { ...own, agentId: `peer-agent-${randomUUID().slice(0, 8)}` },
    ];
    const deniedScopes = [
      ...peers,
      { ...own, agentId: `unregistered-agent-${randomUUID().slice(0, 8)}` },
    ];
    for (const [index, scope] of [own, ...peers].entries()) {
      await scopedStore.registerScope({
        scope,
        policyVersion: 'test-v1',
        actor: { type: 'system', id: 'test:setup' },
        reason: 'agent credential scope integration setup',
        correlationId: `credential-scope-${index}`,
      });
    }

    const agentToken = 'exact-agent-credential-'.padEnd(32, '0');
    const scopedApp = await buildApp({
      store: scopedStore,
      preflightStore: new PreflightStore(pool),
      pool,
      config: {
        ...CONFIG,
        agentApiTokens: [{ ...own, token: agentToken }],
        exporterEvidenceTokens: [],
      },
    });
    await scopedApp.ready();
    try {
      const routes = [
        {
          name: 'permit',
          url: '/v1/permit',
          payload: (scope: Scope) => ({ scope, correlationId: 'credential-test' }),
        },
        {
          name: 'Preflight',
          url: '/v1/preflight/report',
          payload: (scope: Scope) => ({ scope, spans: [] }),
        },
        {
          name: 'detectors',
          url: '/v1/detectors/observe',
          payload: (scope: Scope) => ({
            scope,
            steps: [
              {
                executionId: 'credential-scope-execution',
                timestampMs: Date.now(),
                canonicalShape: 'credential-scope-test',
                inputTokens: 10,
                outputTokens: 2,
                pricingStatus: 'available',
                estimatedCostUsd: 0.0001,
              },
            ],
          }),
        },
      ];
      const headers = {
        authorization: `Bearer ${agentToken}`,
        'x-correlation-id': 'credential-scope-auth',
      };

      for (const route of routes) {
        const allowed = await scopedApp.inject({
          method: 'POST',
          url: route.url,
          headers,
          payload: route.payload(own),
        });
        expect(allowed.statusCode, `${route.name} should allow own scope`).toBe(200);

        let deniedBody: { error: string; message: string } | undefined;
        for (const peer of deniedScopes) {
          const denied = await scopedApp.inject({
            method: 'POST',
            url: route.url,
            headers,
            payload: route.payload(peer),
          });
          expect(denied.statusCode, `${route.name} should deny peer scope`).toBe(403);
          const body = denied.json() as { error: string; message: string };
          expect(body).toMatchObject({
            error: 'unauthorized',
            message: 'this token is not authorized for the requested scope',
          });
          deniedBody ??= { error: body.error, message: body.message };
          expect({ error: body.error, message: body.message }).toEqual(deniedBody);
        }
      }
    } finally {
      await scopedApp.close();
    }
  });
});

describe('control-plane token scoping: agent tokens cannot resume/trip/disable/enable', () => {
  const OPERATOR_TOKEN = 'operator-'.padEnd(32, '0');
  const AGENT_TOKEN = 'agent-'.padEnd(32, '0');
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let app: FastifyInstance;
  const agentScopes: Scope[] = [];
  // See above: record mid-test pool errors loudly, ignore the teardown
  // window where container SIGTERM (57P01) after pool.end() is benign.
  let tearingDownPool = false;
  const poolErrors: unknown[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', (err) => {
      if (!tearingDownPool) poolErrors.push(err);
    });
    await runMigrations(pool);
    const store = new BreakerStore(pool);
    for (let index = 0; index < 10; index++) {
      const scope = freshScope(`agent-token-${index}`);
      await store.registerScope({
        scope,
        policyVersion: 'test-v1',
        actor: { type: 'system', id: 'test:setup' },
        reason: 'integration test registration',
        correlationId: `agent-token-setup-${index}`,
      });
      agentScopes.push(scope);
    }
    const preflightStore = new PreflightStore(pool);
    app = await buildApp({
      store,
      preflightStore,
      pool,
      config: {
        port: 0,
        host: '127.0.0.1',
        logLevel: 'silent',
        deploymentEnvironment: 'test',
        databaseUrl: container.getConnectionUri(),
        dbPoolMax: 10,
        dbPoolIdleTimeoutMs: 30_000,
        dbPoolConnectionTimeoutMs: 2_000,
        dbStatementTimeoutMs: 5_000,
        maxRegisteredScopesPerTenant: 10_000,
        rateLimitMax: 120,
        rateLimitWindowMs: 60_000,
        storeOutageMode: 'fail-closed',
        apiTokens: [OPERATOR_TOKEN],
        agentApiTokens: [AGENT_TOKEN],
        exporterEvidenceTokens: [],
        webhookTokens: [],
        webhookDefaultPolicyVersion: 'signoz-webhook-v1',
        webhookDefaultCooldownSeconds: 300,
        webhookMaxAlertAgeMs: 600_000,
        webhookMaxClockSkewAheadMs: 60_000,
        preflightWindowMs: 5 * 60_000,
        preflightBlindCoverageThreshold: 0.5,
        preflightBlindOrphanRateThreshold: 0.5,
        preflightBlindTokenMissingRateThreshold: 0.3,
        preflightHeartbeatGraceMs: 2 * 60_000,
        preflightMaxEvidenceStalenessMs: 5 * 60_000,
        preflightMinRecoveryDwellMs: 60_000,
      },
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    tearingDownPool = true;
    await app.close();
    await pool.end();
    await container.stop();
    expect(poolErrors).toEqual([]);
  });

  function agentScope(name: string): Scope {
    const scope = agentScopes.pop();
    if (!scope) throw new Error(`registered agent-token scope pool exhausted at ${name}`);
    return scope;
  }

  it('an agent token can call /v1/permit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { scope: agentScope('agent-permit-ok'), correlationId: 'c1' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('an agent token gets 403 unauthorized on /v1/breaker/trip, not a silent pass', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/breaker/trip',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: {
        scope: agentScope('agent-cannot-trip'),
        reason: 'attempted by an agent-scoped token',
        policyVersion: 'v1',
        cooldownSeconds: 60,
        actor: { type: 'manual', id: 'someone' },
        correlationId: 'c1',
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('unauthorized');
  });

  it('an agent token gets 403 on /v1/breaker/resume — cannot self-assert a manual-actor cooldown override', async () => {
    const scope = agentScope('agent-cannot-resume');
    // Operator trips it first.
    await app.inject({
      method: 'POST',
      url: '/v1/breaker/trip',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: {
        scope,
        reason: 'loop',
        policyVersion: 'v1',
        cooldownSeconds: 3600,
        actor: { type: 'system', id: 'system:detector' },
        correlationId: 'c1',
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    // An agent-scoped token cannot resume it, even by claiming actor:manual.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/breaker/resume',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: {
        scope,
        reason: 'trying to self-override',
        actor: { type: 'manual', id: 'not-really-a-human' },
        correlationId: 'c2',
        idempotencyKey: `idem-${randomUUID()}`,
        expectedEpoch: 1,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('unauthorized');
  });

  it('an operator token retains full access to /v1/breaker/*', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=t1&environment=test&agentId=nonexistent-${randomUUID()}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(res.statusCode).toBe(404); // unknown_scope, not 401/403 — auth passed
  });
});

describe('control-plane tenant-scoped tokens: closing the cross-tenant blast radius', () => {
  const TENANT_A_TOKEN = { token: 'tenant-a-'.padEnd(32, '0'), tenant: 'tenant-a' };
  const TENANT_B_TOKEN = { token: 'tenant-b-'.padEnd(32, '0'), tenant: 'tenant-b' };
  const WILDCARD_TOKEN = 'wildcard-operator-'.padEnd(32, '0');
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let app: FastifyInstance;
  const tenantScopes = new Map<string, Scope[]>();
  // See above: record mid-test pool errors loudly, ignore the teardown
  // window where container SIGTERM (57P01) after pool.end() is benign.
  let tearingDownPool = false;
  const poolErrors: unknown[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', (err) => {
      if (!tearingDownPool) poolErrors.push(err);
    });
    await runMigrations(pool);
    const store = new BreakerStore(pool);
    for (const tenant of ['tenant-a', 'tenant-b']) {
      const scopes: Scope[] = [];
      for (let index = 0; index < 20; index++) {
        const scope: Scope = {
          tenant,
          environment: 'test',
          agentId: `agent-registered-${index}-${randomUUID().slice(0, 8)}`,
        };
        await store.registerScope({
          scope,
          policyVersion: 'test-v1',
          actor: { type: 'system', id: 'test:setup' },
          reason: 'integration test registration',
          correlationId: `${tenant}-${index}`,
        });
        scopes.push(scope);
      }
      tenantScopes.set(tenant, scopes);
    }
    const preflightStore = new PreflightStore(pool);
    app = await buildApp({
      store,
      preflightStore,
      pool,
      config: {
        port: 0,
        host: '127.0.0.1',
        logLevel: 'silent',
        deploymentEnvironment: 'test',
        databaseUrl: container.getConnectionUri(),
        dbPoolMax: 10,
        dbPoolIdleTimeoutMs: 30_000,
        dbPoolConnectionTimeoutMs: 2_000,
        dbStatementTimeoutMs: 5_000,
        maxRegisteredScopesPerTenant: 10_000,
        rateLimitMax: 120,
        rateLimitWindowMs: 60_000,
        storeOutageMode: 'fail-closed',
        apiTokens: [TENANT_A_TOKEN, TENANT_B_TOKEN, WILDCARD_TOKEN],
        agentApiTokens: [],
        exporterEvidenceTokens: [],
        webhookTokens: [],
        webhookDefaultPolicyVersion: 'signoz-webhook-v1',
        webhookDefaultCooldownSeconds: 300,
        webhookMaxAlertAgeMs: 600_000,
        webhookMaxClockSkewAheadMs: 60_000,
        preflightWindowMs: 5 * 60_000,
        preflightBlindCoverageThreshold: 0.5,
        preflightBlindOrphanRateThreshold: 0.5,
        preflightBlindTokenMissingRateThreshold: 0.3,
        preflightHeartbeatGraceMs: 2 * 60_000,
        preflightMaxEvidenceStalenessMs: 5 * 60_000,
        preflightMinRecoveryDwellMs: 60_000,
      },
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    tearingDownPool = true;
    await app.close();
    await pool.end();
    await container.stop();
    expect(poolErrors).toEqual([]);
  });

  function scopeForTenant(tenant: string, name: string): Scope {
    const scope = tenantScopes.get(tenant)?.pop();
    if (!scope) throw new Error(`registered ${tenant} test scope exhausted at ${name}`);
    return scope;
  }

  it("tenant A's token can trip tenant A's own breaker", async () => {
    const scope = scopeForTenant('tenant-a', 'own-scope');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/breaker/trip',
      headers: { authorization: `Bearer ${TENANT_A_TOKEN.token}` },
      payload: {
        scope,
        reason: 'tenant A tripping its own scope',
        policyVersion: 'v1',
        cooldownSeconds: 60,
        actor: { type: 'manual', id: 'user:tenant-a-admin' },
        correlationId: 'c1',
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().record.state).toBe('tripped');
  });

  it("tenant A's token gets 403 (not a silent trip) when targeting tenant B's scope — the blast-radius fix", async () => {
    const scope = scopeForTenant('tenant-b', 'cross-tenant-attempt');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/breaker/trip',
      headers: { authorization: `Bearer ${TENANT_A_TOKEN.token}` },
      payload: {
        scope,
        reason: 'tenant A attempting to trip tenant B',
        policyVersion: 'v1',
        cooldownSeconds: 60,
        actor: { type: 'manual', id: 'user:tenant-a-admin' },
        correlationId: 'c1',
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('unauthorized');

    // Confirm it genuinely never happened — tenant B's own token still
    // sees the registered scope in its initial armed state.
    const statusRes = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=${scope.tenant}&environment=${scope.environment}&agentId=${scope.agentId}`,
      headers: { authorization: `Bearer ${TENANT_B_TOKEN.token}` },
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().record.state).toBe('armed');
  });

  it("tenant B's token cannot resume a scope tripped under tenant A", async () => {
    const scope = scopeForTenant('tenant-a', 'cross-tenant-resume-attempt');
    await app.inject({
      method: 'POST',
      url: '/v1/breaker/trip',
      headers: { authorization: `Bearer ${TENANT_A_TOKEN.token}` },
      payload: {
        scope,
        reason: 'loop',
        policyVersion: 'v1',
        cooldownSeconds: 3600,
        actor: { type: 'system', id: 'system:detector' },
        correlationId: 'c1',
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/breaker/resume',
      headers: { authorization: `Bearer ${TENANT_B_TOKEN.token}` },
      payload: {
        scope,
        reason: 'tenant B attempting to resume tenant A',
        actor: { type: 'manual', id: 'user:tenant-b-admin' },
        correlationId: 'c2',
        idempotencyKey: `idem-${randomUUID()}`,
        expectedEpoch: 1,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('unauthorized');
  });

  it("tenant A's token cannot read tenant B's Preflight status", async () => {
    const scope = scopeForTenant('tenant-b', 'preflight-cross-tenant');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/preflight/status?tenant=${scope.tenant}&environment=${scope.environment}&agentId=${scope.agentId}`,
      headers: { authorization: `Bearer ${TENANT_A_TOKEN.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a wildcard (unscoped) operator token still retains cross-tenant access — the documented, opt-in escape hatch', async () => {
    const scope = scopeForTenant('tenant-a', 'wildcard-still-works');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/breaker/trip',
      headers: { authorization: `Bearer ${WILDCARD_TOKEN}` },
      payload: {
        scope,
        reason: 'wildcard operator token',
        policyVersion: 'v1',
        cooldownSeconds: 60,
        actor: { type: 'manual', id: 'user:break-glass' },
        correlationId: 'c1',
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().record.state).toBe('tripped');
  });
});
