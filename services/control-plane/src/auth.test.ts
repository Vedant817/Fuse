import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  extractTenantFromRequest,
  extractTenantFromWebhookRequest,
  requireBearerAuth,
} from './auth.js';
import type { ScopedToken } from './config.js';

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

async function buildTestApp() {
  const app = Fastify();
  app.addHook('preHandler', requireBearerAuth([TOKEN_A, TOKEN_B]));
  app.get('/protected', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('requireBearerAuth', () => {
  it('rejects a request with no Authorization header', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthenticated');
    await app.close();
  });

  it('rejects a non-Bearer Authorization header', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Basic ${TOKEN_A}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an empty bearer token', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer ' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a token that is not in the configured set', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${'c'.repeat(32)}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('accepts any token from the configured set', async () => {
    const app = await buildTestApp();
    for (const token of [TOKEN_A, TOKEN_B]) {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });

  it('rejects a token that is a prefix of a valid token', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${TOKEN_A.slice(0, 10)}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('requireBearerAuth with a scoped (allowed vs. known) token set', () => {
  const OPERATOR_TOKEN = 'operator-token-'.padEnd(32, '0');
  const AGENT_TOKEN = 'agent-token-'.padEnd(32, '0');
  const UNKNOWN_TOKEN = 'unknown-token-'.padEnd(32, '0');

  async function buildScopedApp() {
    const app = Fastify();
    // Only OPERATOR_TOKEN is "allowed" here; AGENT_TOKEN is a real,
    // configured credential but not for this route.
    app.addHook(
      'preHandler',
      requireBearerAuth([OPERATOR_TOKEN], [OPERATOR_TOKEN, AGENT_TOKEN]),
    );
    app.get('/operator-only', async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  it('accepts the allowed (operator) token', async () => {
    const app = await buildScopedApp();
    const res = await app.inject({
      method: 'GET',
      url: '/operator-only',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('rejects a valid-but-lower-privilege (agent) token with 403 unauthorized, not 401', async () => {
    const app = await buildScopedApp();
    const res = await app.inject({
      method: 'GET',
      url: '/operator-only',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('unauthorized');
    await app.close();
  });

  it('rejects a token that is not configured anywhere with 401 unauthenticated', async () => {
    const app = await buildScopedApp();
    const res = await app.inject({
      method: 'GET',
      url: '/operator-only',
      headers: { authorization: `Bearer ${UNKNOWN_TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthenticated');
    await app.close();
  });
});

describe('requireBearerAuth with tenant-scoped tokens', () => {
  const TENANT_A_TOKEN: ScopedToken = {
    token: 't1-token-'.padEnd(32, '0'),
    tenant: 't1',
  };
  const TENANT_B_TOKEN: ScopedToken = {
    token: 't2-token-'.padEnd(32, '0'),
    tenant: 't2',
  };
  const WILDCARD_TOKEN = 'wildcard-token-'.padEnd(32, '0');

  async function buildTenantScopedApp() {
    const app = Fastify();
    app.addHook(
      'preHandler',
      requireBearerAuth(
        [TENANT_A_TOKEN, TENANT_B_TOKEN, WILDCARD_TOKEN],
        [TENANT_A_TOKEN, TENANT_B_TOKEN, WILDCARD_TOKEN],
        extractTenantFromRequest,
      ),
    );
    app.post('/scoped', async () => ({ ok: true }));
    app.get('/scoped', async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  it('accepts a tenant-bound token when the request targets its own tenant (body scope)', async () => {
    const app = await buildTenantScopedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/scoped',
      headers: { authorization: `Bearer ${TENANT_A_TOKEN.token}` },
      payload: { scope: { tenant: 't1', environment: 'prod', agentId: 'a1' } },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('rejects a tenant-bound token acting on a different tenant (body scope) with 403, not a silent cross-tenant pass', async () => {
    const app = await buildTenantScopedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/scoped',
      headers: { authorization: `Bearer ${TENANT_A_TOKEN.token}` },
      payload: { scope: { tenant: 't2', environment: 'prod', agentId: 'a1' } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('unauthorized');
    await app.close();
  });

  it('rejects a tenant-bound token acting on a different tenant (query scope)', async () => {
    const app = await buildTenantScopedApp();
    const res = await app.inject({
      method: 'GET',
      url: '/scoped?tenant=t2&environment=prod&agentId=a1',
      headers: { authorization: `Bearer ${TENANT_A_TOKEN.token}` },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects a tenant-bound token when the request has no determinable tenant at all (fail closed)', async () => {
    const app = await buildTenantScopedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/scoped',
      headers: { authorization: `Bearer ${TENANT_A_TOKEN.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('a wildcard (plain, unscoped) token is accepted for any tenant, preserving prior behavior', async () => {
    const app = await buildTenantScopedApp();
    for (const tenant of ['t1', 't2', 'some-other-tenant']) {
      const res = await app.inject({
        method: 'POST',
        url: '/scoped',
        headers: { authorization: `Bearer ${WILDCARD_TOKEN}` },
        payload: { scope: { tenant, environment: 'prod', agentId: 'a1' } },
      });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });

  it('without an extractTenant function, a tenant-bound token is accepted regardless of scope (opt-in enforcement)', async () => {
    const app = Fastify();
    app.addHook(
      'preHandler',
      requireBearerAuth([TENANT_A_TOKEN], [TENANT_A_TOKEN]), // no extractTenant passed
    );
    app.post('/unscoped-check', async () => ({ ok: true }));
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/unscoped-check',
      headers: { authorization: `Bearer ${TENANT_A_TOKEN.token}` },
      payload: { scope: { tenant: 't2', environment: 'prod', agentId: 'a1' } },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('extractTenantFromRequest', () => {
  it('reads tenant from a POST body scope.tenant', async () => {
    const app = Fastify();
    app.post('/echo', async (request) => ({ tenant: extractTenantFromRequest(request) }));
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { scope: { tenant: 't1' } },
    });
    expect(res.json().tenant).toBe('t1');
    await app.close();
  });

  it('reads tenant from a GET query param when no body scope is present', async () => {
    const app = Fastify();
    app.get('/echo', async (request) => ({ tenant: extractTenantFromRequest(request) }));
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/echo?tenant=t2' });
    expect(res.json().tenant).toBe('t2');
    await app.close();
  });

  it('returns undefined when neither is present', async () => {
    const app = Fastify();
    app.post('/echo', async (request) => ({ tenant: extractTenantFromRequest(request) }));
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/echo', payload: {} });
    expect(res.json().tenant).toBeUndefined();
    await app.close();
  });
});

describe('tenant-scoped grouped webhook authentication', () => {
  const TENANT_TOKEN: ScopedToken = {
    tenant: 't1',
    token: 'webhook-tenant-token-0000000001',
  };
  const WILDCARD_TOKEN = 'webhook-wildcard-token-0000001';

  async function buildWebhookApp() {
    const app = Fastify();
    app.addHook(
      'preHandler',
      requireBearerAuth(
        [TENANT_TOKEN, WILDCARD_TOKEN],
        [TENANT_TOKEN, WILDCARD_TOKEN],
        extractTenantFromWebhookRequest,
      ),
    );
    app.post('/webhook', async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  const alert = (tenant: string) => ({ labels: { 'fuse.tenant': tenant } });

  it('accepts a tenant token only when every grouped alert matches', async () => {
    const app = await buildWebhookApp();
    const accepted = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { authorization: `Bearer ${TENANT_TOKEN.token}` },
      payload: { alerts: [alert('t1'), alert('t1')] },
    });
    const crossTenant = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { authorization: `Bearer ${TENANT_TOKEN.token}` },
      payload: { alerts: [alert('t1'), alert('t2')] },
    });
    expect(accepted.statusCode).toBe(200);
    expect(crossTenant.statusCode).toBe(403);
    await app.close();
  });

  it('keeps the explicit wildcard escape hatch for mixed-tenant SigNoz groups', async () => {
    const app = await buildWebhookApp();
    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { authorization: `Bearer ${WILDCARD_TOKEN}` },
      payload: { alerts: [alert('t1'), alert('t2')] },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
