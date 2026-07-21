import { describe, expect, it } from 'vitest';
import { loadConfig, normalizeToken, normalizeTokens } from './config.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://fuse:fuse@localhost:5432/fuse',
  CONTROL_PLANE_API_TOKENS: 'a'.repeat(16),
};

describe('loadConfig token parsing', () => {
  it('parses a plain (unscoped) token as-is', () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config.apiTokens).toEqual(['a'.repeat(16)]);
  });

  it('parses a tenant:token entry into a { tenant, token } record', () => {
    const config = loadConfig({
      ...BASE_ENV,
      CONTROL_PLANE_API_TOKENS: `t1:${'b'.repeat(16)}`,
    });
    expect(config.apiTokens).toEqual([{ tenant: 't1', token: 'b'.repeat(16) }]);
  });

  it('parses a mixed comma-separated list of plain and tenant-scoped tokens', () => {
    const config = loadConfig({
      ...BASE_ENV,
      CONTROL_PLANE_API_TOKENS: `${'a'.repeat(16)},t1:${'b'.repeat(16)},t2:${'c'.repeat(16)}`,
    });
    expect(config.apiTokens).toEqual([
      'a'.repeat(16),
      { tenant: 't1', token: 'b'.repeat(16) },
      { tenant: 't2', token: 'c'.repeat(16) },
    ]);
  });

  it('treats an entry with an empty tenant part (leading colon) as a plain token, not a parse error', () => {
    const config = loadConfig({
      ...BASE_ENV,
      CONTROL_PLANE_API_TOKENS: `:${'a'.repeat(16)}`,
    });
    expect(config.apiTokens).toEqual([`:${'a'.repeat(16)}`]);
  });

  it('rejects a tenant-scoped token whose token part is shorter than 16 characters', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, CONTROL_PLANE_API_TOKENS: 't1:short' }),
    ).toThrow(/invalid control-plane configuration/);
  });

  it('still enforces the minimum-one-operator-token requirement', () => {
    expect(() => loadConfig({ ...BASE_ENV, CONTROL_PLANE_API_TOKENS: '' })).toThrow(
      /invalid control-plane configuration/,
    );
  });
});

describe('normalizeToken / normalizeTokens', () => {
  it('normalizes a plain string to a wildcard-tenant record', () => {
    expect(normalizeToken('abc')).toEqual({ token: 'abc', tenant: '*' });
  });

  it('leaves an already-scoped token record unchanged', () => {
    const scoped = { token: 'abc', tenant: 't1' };
    expect(normalizeToken(scoped)).toEqual(scoped);
  });

  it('normalizes a mixed list', () => {
    expect(normalizeTokens(['plain', { token: 'scoped', tenant: 't1' }])).toEqual([
      { token: 'plain', tenant: '*' },
      { token: 'scoped', tenant: 't1' },
    ]);
  });
});
