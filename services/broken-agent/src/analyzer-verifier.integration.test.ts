import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@fuse/control-plane';
import { BreakerStore, PreflightStore, runMigrations } from '@fuse/breaker-store';
import type { DetectorResult, Scope } from '@fuse/contracts';
import { FuseGuard } from '@fuse/sdk';
import { bootstrapFuseOtel } from '@fuse/sdk/otel';
import { context, metrics, trace } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAnalyzerVerifier } from './analyzer-verifier.js';
import {
  startRequestCountingModelServer,
  type RequestCountingModelServer,
} from './request-counting-model.test-helper.js';
import type { Scenario } from './types.js';

const API_TOKEN = 'broken-agent-integration-test-token-0123';
const EXPORTER_TOKEN = 'broken-agent-exporter-test-token-0123';

async function startOtlpReceiver(status = 200): Promise<{
  url: string;
  requests: Array<{ path: string; status: number }>;
  setStatus: (status: number) => void;
  close: () => Promise<void>;
}> {
  let responseStatus = status;
  const requests: Array<{ path: string; status: number }> = [];
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ path: req.url ?? '', status: responseStatus });
      res.writeHead(responseStatus, { 'content-type': 'application/x-protobuf' });
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('OTLP test receiver failed to bind');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setStatus: (nextStatus) => {
      responseStatus = nextStatus;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe('runAnalyzerVerifier against a real control plane: breaker trip mid-run', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let controlPlane: FastifyInstance;
  let controlPlaneUrl: string;
  let modelServer: RequestCountingModelServer;
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
        exporterEvidenceTokens: [EXPORTER_TOKEN],
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
        // The exporter wrapper may emit more than one ordered batch during a
        // force-flush. Keep production hysteresis semantics while making the
        // integration test's recovery confirmation bounded.
        preflightMinRecoveryDwellMs: 1,
      },
    });
    await controlPlane.listen({ port: 0, host: '127.0.0.1' });
    const address = controlPlane.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('control plane failed to bind');
    controlPlaneUrl = `http://127.0.0.1:${address.port}`;
    modelServer = await startRequestCountingModelServer();
  }, 120_000);

  afterAll(async () => {
    await controlPlane.close();
    await pool.end();
    await pgContainer.stop();
    await modelServer.close();
  });

  function scopeFor(name: string): Scope {
    const scope = registeredScopes.pop();
    if (!scope) throw new Error(`registered scope pool exhausted at ${name}`);
    return scope;
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

  it.each([
    ['loop', 'loop-signature'],
    ['context-bloat', 'context-bloat'],
    ['cost-velocity', 'cost-velocity'],
  ] as const)(
    '%s: observe acknowledgment follows the matching committed trip and the next provider request is zero',
    async (scenario: Scenario, expectedDetector) => {
      const scope = scopeFor(`${scenario}-real-detector`);
      const acknowledgments: Array<{
        acknowledgedAtMs: number;
        results: DetectorResult[];
        enforcement: Array<{ detector: string; outcome: string }>;
      }> = [];
      const fetchImpl = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const response = await fetch(input, init);
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.endsWith('/v1/detectors/observe') && response.ok) {
          const body = (await response.clone().json()) as {
            results: DetectorResult[];
            enforcement: Array<{ detector: string; outcome: string }>;
          };
          acknowledgments.push({
            acknowledgedAtMs: Date.now(),
            results: body.results,
            enforcement: body.enforcement,
          });
        }
        return response;
      }) as typeof fetch;
      const guard = new FuseGuard({
        scope,
        controlPlaneUrl,
        apiToken: API_TOKEN,
        timeoutMs: 2_000,
        stepObservationTimeoutMs: 2_000,
        fetchImpl,
      });
      const before = modelServer.requestCount();

      const result = await runAnalyzerVerifier({
        scenario,
        seed: 1,
        guard,
        model: modelServer.model,
        maxCalls: scenario === 'loop' ? 20 : 30,
      });

      expect(result.stopReason).toBe('breaker-tripped');
      expect(modelServer.requestCount() - before).toBe(result.totalCalls);
      const firingAck = acknowledgments.find((ack) =>
        ack.enforcement.some(
          (entry) => entry.detector === expectedDetector && entry.outcome === 'tripped',
        ),
      );
      expect(firingAck).toBeDefined();
      const firingResult = firingAck!.results.find(
        (candidate) => candidate.detector === expectedDetector,
      );
      expect(firingResult).toMatchObject({ fired: true });
      expect(firingResult!.evidence.length).toBeGreaterThan(0);
      expect(
        firingAck!.results
          .filter((candidate) => candidate.fired)
          .map((candidate) => candidate.detector),
      ).toEqual([expectedDetector]);

      const committed = await pool.query<{
        state: string;
        epoch: number;
        actor_id: string;
        reason: string;
        created_at: Date;
        detector: string;
        detector_version: string;
        score: number;
        threshold: number;
      }>(
        `SELECT b.state, b.epoch::int, a.actor_id, a.reason, a.created_at,
                j.detector, j.detector_version, j.score, j.threshold
           FROM breaker_state b
           JOIN breaker_audit_log a
             ON a.tenant=b.tenant AND a.environment=b.environment
            AND a.agent_id=b.agent_id AND a.to_state='tripped' AND NOT a.noop
           JOIN diagnosis_jobs j ON j.audit_event_id=a.id
          WHERE b.tenant=$1 AND b.environment=$2 AND b.agent_id=$3`,
        [scope.tenant, scope.environment, scope.agentId],
      );
      expect(committed.rows).toHaveLength(1);
      expect(committed.rows[0]).toMatchObject({
        state: 'tripped',
        epoch: 1,
        actor_id: `system:detector:${expectedDetector}`,
        reason: expect.stringContaining(`${expectedDetector} detector`),
        detector: expectedDetector,
        detector_version: firingResult!.detectorVersion,
        score: firingResult!.score,
        threshold: firingResult!.threshold,
      });
      expect(committed.rows[0]!.created_at.getTime()).toBeLessThanOrEqual(
        firingAck!.acknowledgedAtMs,
      );

      const afterTrip = modelServer.requestCount();
      await expect(
        guard.guard(() =>
          modelServer.model.call({
            role: 'analyzer',
            round: 99,
            historyLength: 0,
            scenario,
            seed: 1,
          }),
        ),
      ).rejects.toMatchObject({ code: 'breaker_denied', state: 'tripped' });
      expect(modelServer.requestCount()).toBe(afterTrip);
    },
    30_000,
  );

  it('the public OTel runtime reports real exporter success and failure without callback routing', async () => {
    const protectedScope = scopeFor('preflight-live-wiring');
    const blindScope = scopeFor('preflight-export-failure');
    const receiver = await startOtlpReceiver();
    const runtime = bootstrapFuseOtel({
      serviceName: 'broken-agent-integration',
      serviceVersion: 'test',
      deploymentEnvironment: 'test',
      otlpEndpoint: receiver.url,
      metricExportIntervalMillis: 100_000,
    });
    try {
      const protectedGuard = runtime.registerGuard(
        new FuseGuard({
          scope: protectedScope,
          controlPlaneUrl,
          apiToken: API_TOKEN,
          exporterEvidenceToken: EXPORTER_TOKEN,
          timeoutMs: 2000,
        }),
      );

      await runAnalyzerVerifier({ scenario: 'normal', seed: 1, guard: protectedGuard });
      await runtime.forceFlush();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await runAnalyzerVerifier({ scenario: 'normal', seed: 2, guard: protectedGuard });
      await runtime.forceFlush();

      const statusRes = await fetch(
        `${controlPlaneUrl}/v1/preflight/status?tenant=${protectedScope.tenant}&environment=${protectedScope.environment}&agentId=${protectedScope.agentId}`,
        { headers: { authorization: `Bearer ${API_TOKEN}` } },
      );
      expect(statusRes.status).toBe(200);
      const body = (await statusRes.json()) as {
        result: { state: string; reasonCode: string };
      };
      expect(body.result).toMatchObject({ state: 'protected', reasonCode: 'healthy' });

      receiver.setStatus(400);
      const blindGuard = runtime.registerGuard(
        new FuseGuard({
          scope: blindScope,
          controlPlaneUrl,
          apiToken: API_TOKEN,
          exporterEvidenceToken: EXPORTER_TOKEN,
          timeoutMs: 2000,
        }),
      );
      await runAnalyzerVerifier({ scenario: 'normal', seed: 1, guard: blindGuard });
      await runtime.forceFlush().catch(() => {});
      expect(
        receiver.requests.filter((request) => request.path === '/v1/traces'),
      ).toEqual([
        { path: '/v1/traces', status: 200 },
        { path: '/v1/traces', status: 200 },
        { path: '/v1/traces', status: 400 },
      ]);

      const blindStatusRes = await fetch(
        `${controlPlaneUrl}/v1/preflight/status?tenant=${blindScope.tenant}&environment=${blindScope.environment}&agentId=${blindScope.agentId}`,
        { headers: { authorization: `Bearer ${API_TOKEN}` } },
      );
      expect(blindStatusRes.status).toBe(200);
      const blindBody = (await blindStatusRes.json()) as {
        result: { state: string; reasonCode: string };
      };
      expect(blindBody.result).toMatchObject({
        state: 'blind',
        reasonCode: 'exporter-delivery-failed',
      });
    } finally {
      await runtime.shutdown().catch(() => {});
      await receiver.close();
      trace.disable();
      metrics.disable();
      context.disable();
    }
  });
});
