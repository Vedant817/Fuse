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
