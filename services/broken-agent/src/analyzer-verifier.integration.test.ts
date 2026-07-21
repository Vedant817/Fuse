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
import { FuseGuard } from '@fuse/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runAnalyzerVerifier } from './analyzer-verifier.js';
import type { Model } from './types.js';

const API_TOKEN = 'broken-agent-integration-test-token-0123';

describe('runAnalyzerVerifier against a real control plane: breaker trip mid-run', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let controlPlane: FastifyInstance;
  let controlPlaneUrl: string;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
    await runMigrations(pool);
    const store = new BreakerStore(pool);
    const preflightStore = new PreflightStore(pool);
    controlPlane = await buildApp({
      store,
      preflightStore,
      pool,
      config: {
        port: 0,
        host: '127.0.0.1',
        logLevel: 'silent',
        databaseUrl: pgContainer.getConnectionUri(),
        storeOutageMode: 'fail-closed',
        apiTokens: [API_TOKEN],
        agentApiTokens: [],
        webhookTokens: [],
        webhookDefaultPolicyVersion: 'signoz-webhook-v1',
        webhookDefaultCooldownSeconds: 300,
        webhookMaxAlertAgeMs: 600_000,
        webhookMaxClockSkewAheadMs: 60_000,
      },
    });
    await controlPlane.listen({ port: 0, host: '127.0.0.1' });
    const address = controlPlane.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('control plane failed to bind');
    controlPlaneUrl = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    await controlPlane.close();
    await pool.end();
    await pgContainer.stop();
  });

  function scopeFor(name: string): Scope {
    return {
      tenant: 't1',
      environment: 'test',
      agentId: `agent-${name}-${randomUUID().slice(0, 8)}`,
    };
  }

  it('a normal run completes via verifier-approved against the real control plane', async () => {
    const scope = scopeFor('normal-real-cp');
    const guard = new FuseGuard({
      scope,
      controlPlaneUrl,
      apiToken: API_TOKEN,
      timeoutMs: 2000,
    });
    const result = await runAnalyzerVerifier({ scenario: 'normal', seed: 1, guard });
    expect(result.stopReason).toBe('verifier-approved');
  });

  it('an external trip mid-run stops the fixture immediately, with zero further model dispatches', async () => {
    const scope = scopeFor('loop-real-cp');
    const guard = new FuseGuard({
      scope,
      controlPlaneUrl,
      apiToken: API_TOKEN,
      timeoutMs: 2000,
    });

    // A model wrapper that trips the real breaker (via the operational
    // API, exactly as a detector's webhook would) after the 3rd call, then
    // keeps counting invocations so we can prove none occur afterward.
    let calls = 0;
    const model: Model = {
      async call(args) {
        calls += 1;
        if (calls === 3) {
          const res = await fetch(`${controlPlaneUrl}/v1/breaker/trip`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${API_TOKEN}`,
            },
            body: JSON.stringify({
              scope,
              reason: 'loop-signature detected mid-run',
              policyVersion: 'v1',
              cooldownSeconds: 60,
              actor: { type: 'system', id: 'system:detector' },
              correlationId: `trip-${randomUUID()}`,
              idempotencyKey: `idem-${randomUUID()}`,
            }),
          });
          expect(res.status).toBe(200);
        }
        return { content: `mock-${args.round}`, inputTokens: 1, outputTokens: 1 };
      },
    };
    const modelSpy = vi.fn(model.call);

    const result = await runAnalyzerVerifier({
      scenario: 'loop',
      seed: 1,
      guard,
      model: { call: modelSpy },
      maxCalls: 20,
    });

    expect(result.stopReason).toBe('breaker-tripped');
    expect(result.totalCalls).toBe(3); // the 3rd call is the one that triggered the trip
    expect(modelSpy).toHaveBeenCalledTimes(3); // no 4th dispatch after the trip committed
  });

  it('a normal run reports its own real span telemetry to Preflight, with no extra wiring by the caller', async () => {
    const scope = scopeFor('preflight-live-wiring');
    const guard = new FuseGuard({
      scope,
      controlPlaneUrl,
      apiToken: API_TOKEN,
      timeoutMs: 2000,
    });

    await runAnalyzerVerifier({ scenario: 'normal', seed: 1, guard });
    await guard.flushPreflightTelemetry();
    guard.stopPreflightReporting();

    const statusRes = await fetch(
      `${controlPlaneUrl}/v1/preflight/status?tenant=${scope.tenant}&environment=${scope.environment}&agentId=${scope.agentId}`,
      { headers: { authorization: `Bearer ${API_TOKEN}` } },
    );
    expect(statusRes.status).toBe(200);
    const body = (await statusRes.json()) as { result: { state: string } };
    expect(body.result.state).toBe('protected');
  });
});
