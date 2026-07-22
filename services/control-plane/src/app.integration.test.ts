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
  storeOutageMode: 'fail-closed',
  apiTokens: [VALID_TOKEN],
  agentApiTokens: [],
  webhookTokens: [],
  webhookDefaultPolicyVersion: 'signoz-webhook-v1',
  webhookDefaultCooldownSeconds: 300,
  webhookMaxAlertAgeMs: 600_000,
  webhookMaxClockSkewAheadMs: 60_000,
};

function scopeFor(name: string): Scope {
  return {
    tenant: 't1',
    environment: 'test',
    agentId: `agent-${name}-${randomUUID().slice(0, 8)}`,
  };
}

describe('control-plane HTTP API (Postgres integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool);
    const store = new BreakerStore(pool);
    const preflightStore = new PreflightStore(pool);
    app = await buildApp({ store, preflightStore, pool, config: CONFIG });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
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
      },
    });
    expect(manualResume.statusCode).toBe(200);
    expect(manualResume.json().record.state).toBe('armed');
  });

  it('returns 404 unknown_scope for status on a never-seen agent', async () => {
    const scope = scopeFor('never-seen');
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
});

describe('control-plane token scoping: agent tokens cannot resume/trip/disable/enable', () => {
  const OPERATOR_TOKEN = 'operator-'.padEnd(32, '0');
  const AGENT_TOKEN = 'agent-'.padEnd(32, '0');
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool);
    const store = new BreakerStore(pool);
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
        storeOutageMode: 'fail-closed',
        apiTokens: [OPERATOR_TOKEN],
        agentApiTokens: [AGENT_TOKEN],
        webhookTokens: [],
        webhookDefaultPolicyVersion: 'signoz-webhook-v1',
        webhookDefaultCooldownSeconds: 300,
        webhookMaxAlertAgeMs: 600_000,
        webhookMaxClockSkewAheadMs: 60_000,
      },
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
  });

  it('an agent token can call /v1/permit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { scope: scopeFor('agent-permit-ok'), correlationId: 'c1' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('an agent token gets 403 unauthorized on /v1/breaker/trip, not a silent pass', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/breaker/trip',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: {
        scope: scopeFor('agent-cannot-trip'),
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
    const scope = scopeFor('agent-cannot-resume');
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

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool);
    const store = new BreakerStore(pool);
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
        storeOutageMode: 'fail-closed',
        apiTokens: [TENANT_A_TOKEN, TENANT_B_TOKEN, WILDCARD_TOKEN],
        agentApiTokens: [],
        webhookTokens: [],
        webhookDefaultPolicyVersion: 'signoz-webhook-v1',
        webhookDefaultCooldownSeconds: 300,
        webhookMaxAlertAgeMs: 600_000,
        webhookMaxClockSkewAheadMs: 60_000,
      },
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
  });

  function scopeForTenant(tenant: string, name: string): Scope {
    return {
      tenant,
      environment: 'test',
      agentId: `agent-${name}-${randomUUID().slice(0, 8)}`,
    };
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
    // sees a fresh, never-tripped scope, not something A already tripped.
    const statusRes = await app.inject({
      method: 'GET',
      url: `/v1/breaker/status?tenant=${scope.tenant}&environment=${scope.environment}&agentId=${scope.agentId}`,
      headers: { authorization: `Bearer ${TENANT_B_TOKEN.token}` },
    });
    expect(statusRes.statusCode).toBe(404); // unknown_scope — never touched
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
