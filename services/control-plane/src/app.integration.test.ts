import { randomUUID } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, BreakerStore } from '@fuse/breaker-store';
import type { Scope } from '@fuse/contracts';
import { buildApp } from './app.js';
import type { ControlPlaneConfig } from './config.js';

const VALID_TOKEN = 'a'.repeat(32);
const CONFIG: ControlPlaneConfig = {
  port: 0,
  host: '127.0.0.1',
  logLevel: 'silent' as ControlPlaneConfig['logLevel'],
  databaseUrl: '',
  storeOutageMode: 'fail-closed',
  apiTokens: [VALID_TOKEN],
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
    app = await buildApp({ store, pool, config: CONFIG });
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
