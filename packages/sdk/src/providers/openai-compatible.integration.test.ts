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
import { FuseGuard } from '../guard.js';
import { BreakerTrippedError } from '../errors.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import {
  startMockOpenAiCompatibleServer,
  type MockOpenAiCompatibleServer,
} from './openai-compatible-mock.js';

const API_TOKEN = 'provider-adapter-integration-token-0123';

/**
 * The same dispatch-counter proof as guard.integration.test.ts, but using
 * the real Groq/NVIDIA-shaped adapter (OpenAiCompatibleProvider) against a
 * faithful local mock instead of the generic fake-provider fixture —
 * confirms the concrete adapter code path (request shaping, auth header,
 * response parsing) also respects the breaker, not just the generic
 * dispatch-wrapper contract.
 */
describe('OpenAiCompatibleProvider through FuseGuard: dispatch-counter proof', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let controlPlane: FastifyInstance;
  let controlPlaneUrl: string;
  let mockProvider: MockOpenAiCompatibleServer;
  const registeredScopes: Scope[] = [];

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
    await runMigrations(pool);
    const store = new BreakerStore(pool);
    for (let index = 0; index < 6; index++) {
      const scope: Scope = {
        tenant: 't1',
        environment: 'test',
        agentId: `agent-registered-${index}-${randomUUID().slice(0, 8)}`,
      };
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
    mockProvider = await startMockOpenAiCompatibleServer();
  }, 120_000);

  afterAll(async () => {
    await controlPlane.close();
    await pool.end();
    await pgContainer.stop();
    await mockProvider.close();
  });

  function scopeFor(name: string): Scope {
    const scope = registeredScopes.pop();
    if (!scope) throw new Error(`registered scope pool exhausted at ${name}`);
    return scope;
  }

  it('while armed, the adapter reaches the real HTTP endpoint with the correct auth header', async () => {
    const scope = scopeFor('armed');
    const guard = new FuseGuard({
      scope,
      controlPlaneUrl,
      apiToken: API_TOKEN,
      timeoutMs: 2000,
    });
    const provider = new OpenAiCompatibleProvider({
      baseUrl: mockProvider.url,
      apiKey: 'sk-test-key',
    });

    const result = await guard.guard(() =>
      provider.chatCompletion({
        model: 'demo-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(result.choices[0]?.message.content).toBe('mock response');
    expect(mockProvider.lastAuthorizationHeader()).toBe('Bearer sk-test-key');
  });

  it('after a committed trip, the adapter is never dispatched — zero new requests to the real endpoint', async () => {
    const scope = scopeFor('tripped');
    const guard = new FuseGuard({
      scope,
      controlPlaneUrl,
      apiToken: API_TOKEN,
      timeoutMs: 2000,
    });
    const provider = new OpenAiCompatibleProvider({
      baseUrl: mockProvider.url,
      apiKey: 'sk-test-key',
    });

    await guard.guard(() =>
      provider.chatCompletion({
        model: 'demo-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    const before = mockProvider.requestCount();

    await fetch(`${controlPlaneUrl}/v1/breaker/trip`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        scope,
        reason: 'cost velocity spike',
        policyVersion: 'v1',
        cooldownSeconds: 60,
        actor: { type: 'system', id: 'system:detector' },
        correlationId: `trip-${randomUUID()}`,
        idempotencyKey: `idem-${randomUUID()}`,
      }),
    });

    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        guard.guard(() =>
          provider.chatCompletion({
            model: 'demo-model',
            messages: [{ role: 'user', content: 'hi' }],
          }),
        ),
      ),
    );
    expect(
      attempts.every(
        (a) => a.status === 'rejected' && a.reason instanceof BreakerTrippedError,
      ),
    ).toBe(true);
    expect(mockProvider.requestCount()).toBe(before);
  });
});
