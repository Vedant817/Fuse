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

describe('loadConfig Postgres pool options', () => {
  it('defaults match @fuse/breaker-store createPool hardcoded fallbacks when unset', () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config.dbPoolMax).toBe(10);
    expect(config.dbPoolIdleTimeoutMs).toBe(30_000);
    expect(config.dbPoolConnectionTimeoutMs).toBe(2_000);
    expect(config.dbStatementTimeoutMs).toBe(5_000);
  });

  it('parses explicit pool env values into the config object', () => {
    const config = loadConfig({
      ...BASE_ENV,
      CONTROL_PLANE_DB_POOL_MAX: '25',
      CONTROL_PLANE_DB_POOL_IDLE_TIMEOUT_MS: '45000',
      CONTROL_PLANE_DB_POOL_CONNECTION_TIMEOUT_MS: '5000',
      CONTROL_PLANE_DB_STATEMENT_TIMEOUT_MS: '10000',
    });
    expect(config.dbPoolMax).toBe(25);
    expect(config.dbPoolIdleTimeoutMs).toBe(45_000);
    expect(config.dbPoolConnectionTimeoutMs).toBe(5_000);
    expect(config.dbStatementTimeoutMs).toBe(10_000);
  });

  it('rejects a non-numeric CONTROL_PLANE_DB_POOL_MAX', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, CONTROL_PLANE_DB_POOL_MAX: 'not-a-number' }),
    ).toThrow(/invalid control-plane configuration/);
  });

  it('rejects a zero CONTROL_PLANE_DB_POOL_MAX', () => {
    expect(() => loadConfig({ ...BASE_ENV, CONTROL_PLANE_DB_POOL_MAX: '0' })).toThrow(
      /invalid control-plane configuration/,
    );
  });

  it('rejects a negative CONTROL_PLANE_DB_STATEMENT_TIMEOUT_MS', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, CONTROL_PLANE_DB_STATEMENT_TIMEOUT_MS: '-1' }),
    ).toThrow(/invalid control-plane configuration/);
  });
});

describe('loadConfig Preflight evaluator thresholds', () => {
  it('defaults match @fuse/preflight DEFAULT_PREFLIGHT_CONFIG when unset', () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config.preflightWindowMs).toBe(5 * 60_000);
    expect(config.preflightBlindCoverageThreshold).toBe(0.5);
    expect(config.preflightBlindOrphanRateThreshold).toBe(0.5);
    expect(config.preflightBlindTokenMissingRateThreshold).toBe(0.3);
    expect(config.preflightHeartbeatGraceMs).toBe(2 * 60_000);
    expect(config.preflightMaxEvidenceStalenessMs).toBe(5 * 60_000);
    expect(config.preflightMinRecoveryDwellMs).toBe(60_000);
  });

  it('parses explicit Preflight env values into the config object', () => {
    const config = loadConfig({
      ...BASE_ENV,
      CONTROL_PLANE_PREFLIGHT_WINDOW_MS: '600000',
      CONTROL_PLANE_PREFLIGHT_BLIND_COVERAGE_THRESHOLD: '0.7',
      CONTROL_PLANE_PREFLIGHT_BLIND_ORPHAN_RATE_THRESHOLD: '0.6',
      CONTROL_PLANE_PREFLIGHT_BLIND_TOKEN_MISSING_RATE_THRESHOLD: '0.4',
      CONTROL_PLANE_PREFLIGHT_HEARTBEAT_GRACE_MS: '180000',
      CONTROL_PLANE_PREFLIGHT_MAX_EVIDENCE_STALENESS_MS: '900000',
      CONTROL_PLANE_PREFLIGHT_MIN_RECOVERY_DWELL_MS: '120000',
    });
    expect(config.preflightWindowMs).toBe(600_000);
    expect(config.preflightBlindCoverageThreshold).toBe(0.7);
    expect(config.preflightBlindOrphanRateThreshold).toBe(0.6);
    expect(config.preflightBlindTokenMissingRateThreshold).toBe(0.4);
    expect(config.preflightHeartbeatGraceMs).toBe(180_000);
    expect(config.preflightMaxEvidenceStalenessMs).toBe(900_000);
    expect(config.preflightMinRecoveryDwellMs).toBe(120_000);
  });

  it('rejects a non-numeric CONTROL_PLANE_PREFLIGHT_WINDOW_MS', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, CONTROL_PLANE_PREFLIGHT_WINDOW_MS: 'not-a-number' }),
    ).toThrow(/invalid control-plane configuration/);
  });

  it('rejects a zero/non-positive CONTROL_PLANE_PREFLIGHT_HEARTBEAT_GRACE_MS', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, CONTROL_PLANE_PREFLIGHT_HEARTBEAT_GRACE_MS: '0' }),
    ).toThrow(/invalid control-plane configuration/);
  });

  it('rejects a negative CONTROL_PLANE_PREFLIGHT_MIN_RECOVERY_DWELL_MS', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, CONTROL_PLANE_PREFLIGHT_MIN_RECOVERY_DWELL_MS: '-1' }),
    ).toThrow(/invalid control-plane configuration/);
  });

  it('rejects a blind-coverage-threshold ratio above 1', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_PREFLIGHT_BLIND_COVERAGE_THRESHOLD: '1.5',
      }),
    ).toThrow(/invalid control-plane configuration/);
  });

  it('rejects a negative blind-orphan-rate-threshold ratio', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_PREFLIGHT_BLIND_ORPHAN_RATE_THRESHOLD: '-0.1',
      }),
    ).toThrow(/invalid control-plane configuration/);
  });

  it('rejects a non-numeric blind-token-missing-rate-threshold', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_PREFLIGHT_BLIND_TOKEN_MISSING_RATE_THRESHOLD: 'not-a-number',
      }),
    ).toThrow(/invalid control-plane configuration/);
  });

  it('accepts boundary ratio values 0 and 1', () => {
    const config = loadConfig({
      ...BASE_ENV,
      CONTROL_PLANE_PREFLIGHT_BLIND_COVERAGE_THRESHOLD: '0',
      CONTROL_PLANE_PREFLIGHT_BLIND_ORPHAN_RATE_THRESHOLD: '1',
    });
    expect(config.preflightBlindCoverageThreshold).toBe(0);
    expect(config.preflightBlindOrphanRateThreshold).toBe(1);
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
