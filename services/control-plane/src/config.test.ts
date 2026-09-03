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

  it('parses an agent credential bound to tenant, environment, and agentId', () => {
    const config = loadConfig({
      ...BASE_ENV,
      CONTROL_PLANE_AGENT_API_TOKENS: `t1:production:agent-1:${'d'.repeat(16)}`,
    });
    expect(config.agentApiTokens).toEqual([
      {
        tenant: 't1',
        environment: 'production',
        agentId: 'agent-1',
        token: 'd'.repeat(16),
      },
    ]);
  });

  it('rejects a plain agent token instead of silently treating it as a global wildcard', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_AGENT_API_TOKENS: 'd'.repeat(16),
      }),
    ).toThrow(/explicit development wildcard/);
  });

  it('allows an explicitly configured wildcard agent credential in development', () => {
    const config = loadConfig({
      ...BASE_ENV,
      CONTROL_PLANE_AGENT_API_TOKENS: `*:*:*:${'d'.repeat(16)}`,
    });
    expect(config.agentApiTokens).toEqual([
      { tenant: '*', environment: '*', agentId: '*', token: 'd'.repeat(16) },
    ]);
  });

  it('allows an explicit exporter wildcard only in development', () => {
    const config = loadConfig({
      ...BASE_ENV,
      CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS: `*:*:*:${'e'.repeat(16)}`,
    });
    expect(config.exporterEvidenceTokens).toEqual([
      { tenant: '*', environment: '*', agentId: '*', token: 'e'.repeat(16) },
    ]);
  });

  it('retains the legacy tenant-only agent form in development', () => {
    const config = loadConfig({
      ...BASE_ENV,
      CONTROL_PLANE_AGENT_API_TOKENS: `t1:${'d'.repeat(16)}`,
    });
    expect(config.agentApiTokens).toEqual([{ tenant: 't1', token: 'd'.repeat(16) }]);
  });

  it('rejects malformed three-part agent credentials', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_AGENT_API_TOKENS: `t1:production:${'d'.repeat(16)}`,
      }),
    ).toThrow(/expected tenant:environment:agentId:token/);
  });

  it('rejects an entry with an empty tenant instead of widening it to wildcard', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_API_TOKENS: `:${'a'.repeat(16)}`,
      }),
    ).toThrow(/require both a non-empty tenant and token/);
  });

  it('rejects an entry with an empty token instead of accepting the tenant name as a wildcard bearer', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_API_TOKENS: 'production-tenant:',
      }),
    ).toThrow(/require both a non-empty tenant and token/);
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

  // task.md §11.3 adversarial review: .env.example's own placeholder tokens
  // (e.g. "changeme-generate-a-strong-random-token", 39 chars) are long
  // enough to pass the plain min(16) length check and would otherwise start
  // the control plane successfully with a publicly-known credential.
  it('rejects the exact placeholder value shipped in .env.example for CONTROL_PLANE_API_TOKENS', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_API_TOKENS: 'changeme-generate-a-strong-random-token',
      }),
    ).toThrow(/CONTROL_PLANE_API_TOKENS still contains a placeholder value/);
  });

  it('rejects a placeholder token for CONTROL_PLANE_AGENT_API_TOKENS', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_AGENT_API_TOKENS:
          't1:development:agent-1:changeme-generate-a-different-strong-random-token',
      }),
    ).toThrow(/CONTROL_PLANE_AGENT_API_TOKENS still contains a placeholder value/);
  });

  it('rejects a placeholder token for CONTROL_PLANE_WEBHOOK_TOKENS', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_WEBHOOK_TOKENS: 'changeme-generate-a-third-strong-random-token',
      }),
    ).toThrow(/CONTROL_PLANE_WEBHOOK_TOKENS still contains a placeholder value/);
  });

  it('rejects a placeholder exporter evidence token without echoing it', () => {
    const placeholder = 'changeme-exporter-evidence-token-value';
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS: `t1:test:agent-1:${placeholder}`,
      }),
    ).toThrow(/CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS still contains a placeholder/);
    try {
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS: `t1:test:agent-1:${placeholder}`,
      });
    } catch (error) {
      expect(String(error)).not.toContain(placeholder);
    }
  });

  it('rejects a placeholder token even in tenant:token form', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_API_TOKENS: `acme-corp:${'changeme-acme-token'.padEnd(16, '0')}`,
      }),
    ).toThrow(/CONTROL_PLANE_API_TOKENS still contains a placeholder value/);
  });

  it('is case-insensitive so "ChangeMe..." is still caught', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_API_TOKENS: 'ChangeMe-still-a-placeholder-value',
      }),
    ).toThrow(/CONTROL_PLANE_API_TOKENS still contains a placeholder value/);
  });

  it('does not reject a real token that merely contains "changeme" somewhere other than the start', () => {
    const config = loadConfig({
      ...BASE_ENV,
      CONTROL_PLANE_API_TOKENS: `${'a'.repeat(16)}-notachangemeplaceholder`,
    });
    expect(config.apiTokens).toEqual([`${'a'.repeat(16)}-notachangemeplaceholder`]);
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

describe('loadConfig listener and rate-limit options', () => {
  it('defaults to the non-conflicting local control-plane port and existing limiter behavior', () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config.port).toBe(8090);
    expect(config.rateLimitMax).toBe(120);
    expect(config.rateLimitWindowMs).toBe(60_000);
  });

  it('requires an explicit detector policy file in production', () => {
    const productionBase = {
      ...BASE_ENV,
      CONTROL_PLANE_API_TOKENS: 'a'.repeat(64),
      CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS: `t1:production:agent-1:${'e'.repeat(64)}`,
    };
    expect(() =>
      loadConfig({
        ...productionBase,
        CONTROL_PLANE_DEPLOYMENT_ENVIRONMENT: 'production',
        CONTROL_PLANE_RATE_LIMIT_REDIS_URL: 'redis://redis.internal:6379',
      }),
    ).toThrow(/CONTROL_PLANE_DETECTOR_POLICY_FILE is required/);

    expect(
      loadConfig({
        ...productionBase,
        CONTROL_PLANE_DEPLOYMENT_ENVIRONMENT: 'production',
        CONTROL_PLANE_DETECTOR_POLICY_FILE: '/etc/fuse/policies/production.json',
        CONTROL_PLANE_RATE_LIMIT_REDIS_URL: 'redis://redis.internal:6379',
      }).detectorPolicyFile,
    ).toBe('/etc/fuse/policies/production.json');
  });

  it('accepts only exact agent credentials in production', () => {
    const productionEnv = {
      ...BASE_ENV,
      CONTROL_PLANE_API_TOKENS: 'a'.repeat(64),
      CONTROL_PLANE_DEPLOYMENT_ENVIRONMENT: 'production',
      CONTROL_PLANE_DETECTOR_POLICY_FILE: '/etc/fuse/policies/production.json',
      CONTROL_PLANE_RATE_LIMIT_REDIS_URL: 'redis://redis.internal:6379',
      CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS: `t1:production:agent-1:${'e'.repeat(64)}`,
    };
    const exact = loadConfig({
      ...productionEnv,
      CONTROL_PLANE_AGENT_API_TOKENS: `t1:production:agent-1:${'d'.repeat(64)}`,
    });
    expect(exact.agentApiTokens[0]).toMatchObject({
      tenant: 't1',
      environment: 'production',
      agentId: 'agent-1',
    });

    expect(() =>
      loadConfig({
        ...productionEnv,
        CONTROL_PLANE_AGENT_API_TOKENS: `*:*:*:${'d'.repeat(64)}`,
      }),
    ).toThrow(/production agent credentials must bind tenant, environment, and agentId/);
    expect(() =>
      loadConfig({
        ...productionEnv,
        CONTROL_PLANE_AGENT_API_TOKENS: `t1:${'d'.repeat(64)}`,
      }),
    ).toThrow(/production agent credentials must bind tenant, environment, and agentId/);
  });

  it('requires exact, complete exporter evidence credentials in production', () => {
    const productionEnv = {
      ...BASE_ENV,
      CONTROL_PLANE_API_TOKENS: 'a'.repeat(64),
      CONTROL_PLANE_DEPLOYMENT_ENVIRONMENT: 'production',
      CONTROL_PLANE_DETECTOR_POLICY_FILE: '/etc/fuse/policies/production.json',
      CONTROL_PLANE_RATE_LIMIT_REDIS_URL: 'redis://redis.internal:6379',
    };
    expect(() => loadConfig(productionEnv)).toThrow(
      /PREFLIGHT_EXPORTER_TOKENS requires at least one exact-scope credential/,
    );
    for (const value of [`*:*:*:${'e'.repeat(64)}`, `t1:${'e'.repeat(64)}`]) {
      expect(() =>
        loadConfig({
          ...productionEnv,
          CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS: value,
        }),
      ).toThrow(/production exporter evidence credentials must bind/);
    }
    expect(
      loadConfig({
        ...productionEnv,
        CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS: `t1:production:agent-1:${'e'.repeat(64)}`,
      }).exporterEvidenceTokens[0],
    ).toMatchObject({ tenant: 't1', environment: 'production', agentId: 'agent-1' });
  });

  it('rejects exporter token reuse across credential classes', () => {
    const reused = 'r'.repeat(64);
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_AGENT_API_TOKENS: `t1:test:agent-1:${reused}`,
        CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS: `t1:test:agent-1:${reused}`,
      }),
    ).toThrow(/must not reuse operator, agent, or webhook token values/);
  });

  it('rejects one exporter token bound to multiple scopes', () => {
    const reused = 'r'.repeat(64);
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS:
          `t1:test:agent-1:${reused},` + `t1:test:agent-2:${reused}`,
      }),
    ).toThrow(/unique token value for exactly one scope/);
  });

  it('parses explicit rate-limit overrides', () => {
    const config = loadConfig({
      ...BASE_ENV,
      CONTROL_PLANE_RATE_LIMIT_MAX: '5000',
      CONTROL_PLANE_RATE_LIMIT_WINDOW_MS: '10000',
    });
    expect(config.rateLimitMax).toBe(5000);
    expect(config.rateLimitWindowMs).toBe(10_000);
  });

  it('rejects production without shared rate-limit Redis', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_API_TOKENS: 'a'.repeat(64),
        CONTROL_PLANE_DEPLOYMENT_ENVIRONMENT: 'production',
        CONTROL_PLANE_DETECTOR_POLICY_FILE: '/etc/fuse/policies/production.json',
        CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS: `t1:production:agent-1:${'e'.repeat(64)}`,
      }),
    ).toThrow(/CONTROL_PLANE_RATE_LIMIT_REDIS_URL is required/);
  });

  it('requires independently generated 32-byte bearer credentials in production', () => {
    const productionEnv = {
      ...BASE_ENV,
      CONTROL_PLANE_DEPLOYMENT_ENVIRONMENT: 'production',
      CONTROL_PLANE_DETECTOR_POLICY_FILE: '/etc/fuse/policies/production.json',
      CONTROL_PLANE_RATE_LIMIT_REDIS_URL: 'rediss://redis.internal:6380/0',
      CONTROL_PLANE_API_TOKENS: `t1:${'a'.repeat(64)}`,
      CONTROL_PLANE_AGENT_API_TOKENS: `t1:production:agent-1:${'b'.repeat(64)}`,
      CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS: `t1:production:agent-1:${'d'.repeat(64)}`,
      CONTROL_PLANE_WEBHOOK_TOKENS: `t1:${'c'.repeat(64)}`,
    };

    expect(() => loadConfig(productionEnv)).not.toThrow();
    for (const [name, value] of [
      ['CONTROL_PLANE_API_TOKENS', `t1:${'a'.repeat(31)}`],
      ['CONTROL_PLANE_AGENT_API_TOKENS', `t1:production:agent-1:${'b'.repeat(31)}`],
      [
        'CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS',
        `t1:production:agent-1:${'d'.repeat(31)}`,
      ],
      ['CONTROL_PLANE_WEBHOOK_TOKENS', `t1:${'c'.repeat(31)}`],
    ] as const) {
      expect(() => loadConfig({ ...productionEnv, [name]: value })).toThrow(
        /at least 32 bytes in production/,
      );
    }
  });

  it('accepts redis and rediss URLs but rejects unrelated schemes', () => {
    expect(
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_RATE_LIMIT_REDIS_URL: 'rediss://redis.internal:6380/0',
      }).rateLimitRedisUrl,
    ).toBe('rediss://redis.internal:6380/0');
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_RATE_LIMIT_REDIS_URL: 'https://redis.internal',
      }),
    ).toThrow(/redis:\/\/ or rediss:\/\//);
  });

  it('rejects invalid rate-limit overrides', () => {
    expect(() => loadConfig({ ...BASE_ENV, CONTROL_PLANE_RATE_LIMIT_MAX: '0' })).toThrow(
      /invalid control-plane configuration/,
    );
    expect(() =>
      loadConfig({ ...BASE_ENV, CONTROL_PLANE_RATE_LIMIT_WINDOW_MS: 'not-a-number' }),
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

  it('leaves a completely agent-scoped token record unchanged', () => {
    const scoped = {
      token: 'abc',
      tenant: 't1',
      environment: 'prod',
      agentId: 'a1',
    };
    expect(normalizeToken(scoped)).toEqual(scoped);
  });

  it('normalizes a mixed list', () => {
    expect(normalizeTokens(['plain', { token: 'scoped', tenant: 't1' }])).toEqual([
      { token: 'plain', tenant: '*' },
      { token: 'scoped', tenant: 't1' },
    ]);
  });
});
