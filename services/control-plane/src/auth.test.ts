import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { requireBearerAuth } from './auth.js';

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
