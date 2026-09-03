import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BreakerStore, PreflightStore, runMigrations } from '@fuse/breaker-store';
import type { Scope } from '@fuse/contracts';
import { buildApp } from './app.js';
import type { ControlPlaneConfig, ScopedToken } from './config.js';
import type { DiagnosisWorkerConfig } from './diagnosis-worker.js';

const SIGNING_SECRET = 'slack-integration-signing-secret';
const SLACK_USER_ID = 'U123';
const SLACK_TEAM_ID = 'T123';
const TENANT_A_TOKEN = 'operator-a-'.padEnd(32, 'a');
const TENANT_B_TOKEN = 'operator-b-'.padEnd(32, 'b');
const OPERATOR_TOKENS: ScopedToken[] = [
  { tenant: 'tenant-a', token: TENANT_A_TOKEN },
  { tenant: 'tenant-b', token: TENANT_B_TOKEN },
];

function config(port: number): ControlPlaneConfig {
  return {
    port,
    host: '127.0.0.1',
    logLevel: 'silent',
    deploymentEnvironment: 'test',
    databaseUrl: '',
    dbPoolMax: 10,
    dbPoolIdleTimeoutMs: 30_000,
    dbPoolConnectionTimeoutMs: 2_000,
    dbStatementTimeoutMs: 5_000,
    maxRegisteredScopesPerTenant: 10_000,
    rateLimitMax: 120,
    rateLimitWindowMs: 60_000,
    storeOutageMode: 'fail-closed',
    apiTokens: OPERATOR_TOKENS,
    agentApiTokens: [],
    exporterEvidenceTokens: [],
    webhookTokens: [],
    webhookDefaultPolicyVersion: 'test-policy-v1',
    webhookDefaultCooldownSeconds: 0,
    webhookMaxAlertAgeMs: 600_000,
    webhookMaxClockSkewAheadMs: 60_000,
    preflightWindowMs: 5 * 60_000,
    preflightBlindCoverageThreshold: 0.5,
    preflightBlindOrphanRateThreshold: 0.5,
    preflightBlindTokenMissingRateThreshold: 0.3,
    preflightHeartbeatGraceMs: 2 * 60_000,
    preflightMaxEvidenceStalenessMs: 5 * 60_000,
    preflightMinRecoveryDwellMs: 60_000,
  };
}

const DIAGNOSIS_CONFIG: DiagnosisWorkerConfig = {
  mcpServerUrl: undefined,
  slackBotToken: undefined,
  slackChannel: '#unused',
  localSnapshotDir: '/tmp/unused',
  slackSigningSecret: SIGNING_SECRET,
  slackAuthorizedUserIds: [SLACK_USER_ID],
  slackTeamId: SLACK_TEAM_ID,
  operatorTokens: OPERATOR_TOKENS,
  operatorToken: undefined,
};

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to reserve a local integration-test port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function scope(tenant: string, name: string): Scope {
  return {
    tenant,
    environment: 'test',
    agentId: `slack-${name}-${randomUUID().slice(0, 8)}`,
  };
}

function submissionPayload(params: {
  scope: Scope;
  expectedEpoch: number;
  viewId: string;
  correlationId?: string;
}) {
  return {
    type: 'view_submission',
    user: { id: SLACK_USER_ID },
    team: { id: SLACK_TEAM_ID },
    view: {
      id: params.viewId,
      private_metadata: JSON.stringify({
        version: 1,
        scope: params.scope,
        expectedEpoch: params.expectedEpoch,
        correlationId: params.correlationId ?? `incident-${params.viewId}`,
      }),
      state: {
        values: {
          reason_block: { reason_input: { value: 'verified remediation' } },
        },
      },
    },
  };
}

async function postSigned(baseUrl: string, payload: unknown) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const signature =
    'v0=' +
    createHmac('sha256', SIGNING_SECRET)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest('hex');
  const response = await fetch(`${baseUrl}/v1/slack/interactive`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    body: rawBody,
  });
  return { status: response.status, body: await response.text() };
}

describe('Slack interactive resume (two replicas + real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let replicaPool: pg.Pool;
  let store: BreakerStore;
  let app: FastifyInstance;
  let replica: FastifyInstance;
  let appUrl: string;
  let replicaUrl: string;
  // node-postgres emits 'error' on idle clients whose backend the server
  // terminates; without a listener that is an uncaught exception. Record
  // mid-test errors so the suite still fails loudly, but stop recording at
  // teardown where container SIGTERM (57P01) after pool.end() is benign.
  let tearingDownPool = false;
  const poolErrors: unknown[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    replicaPool = new pg.Pool({ connectionString: container.getConnectionUri() });
    for (const tracked of [pool, replicaPool]) {
      tracked.on('error', (err) => {
        if (!tearingDownPool) poolErrors.push(err);
      });
    }
    await runMigrations(pool);
    store = new BreakerStore(pool);

    const [appPort, replicaPort] = await Promise.all([availablePort(), availablePort()]);
    app = await buildApp({
      store,
      preflightStore: new PreflightStore(pool),
      pool,
      config: config(appPort),
      diagnosisConfig: DIAGNOSIS_CONFIG,
    });
    replica = await buildApp({
      store: new BreakerStore(replicaPool),
      preflightStore: new PreflightStore(replicaPool),
      pool: replicaPool,
      config: config(replicaPort),
      diagnosisConfig: DIAGNOSIS_CONFIG,
    });
    appUrl = await app.listen({ port: appPort, host: '127.0.0.1' });
    replicaUrl = await replica.listen({ port: replicaPort, host: '127.0.0.1' });
  }, 120_000);

  afterAll(async () => {
    tearingDownPool = true;
    await app.close();
    await replica.close();
    await pool.end();
    await replicaPool.end();
    await container.stop();
    expect(poolErrors).toEqual([]);
  });

  async function trip(target: Scope, expectedEpoch: number, label: string) {
    if (!(await store.isScopeRegistered(target))) {
      await store.registerScope({
        scope: target,
        policyVersion: 'test-policy-v1',
        actor: { type: 'system', id: 'test:setup' },
        reason: 'Slack integration test registration',
        correlationId: `register-${label}`,
      });
    }
    const result = await store.trip({
      scope: target,
      reason: `test incident ${label}`,
      policyVersion: 'test-policy-v1',
      cooldownSeconds: 0,
      actor: { type: 'system', id: 'system:test:trip' },
      expectedEpoch,
      correlationId: `trip-${label}-${randomUUID()}`,
      idempotencyKey: `trip-${label}-${randomUUID()}`,
    });
    expect(result).toMatchObject({ kind: 'applied', noop: false });
  }

  async function slackResumeAuditCount(target: Scope): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM breaker_audit_log
        WHERE tenant=$1 AND environment=$2 AND agent_id=$3
          AND actor_type='manual' AND actor_id=$4
          AND from_state='tripped' AND to_state='armed' AND NOT noop`,
      [target.tenant, target.environment, target.agentId, `slack:${SLACK_USER_ID}`],
    );
    return Number(rows[0]!.count);
  }

  it('deduplicates the same Slack view ID delivered concurrently to two replicas', async () => {
    const target = scope('tenant-a', 'same-view');
    await trip(target, 0, 'same-view');
    const payload = submissionPayload({
      scope: target,
      expectedEpoch: 1,
      viewId: 'V-SAME-VIEW',
    });

    const [left, right] = await Promise.all([
      postSigned(appUrl, payload),
      postSigned(replicaUrl, payload),
    ]);
    expect(left).toEqual({ status: 200, body: '' });
    expect(right).toEqual(left);
    expect(await store.getRecord(target)).toMatchObject({ state: 'armed', epoch: 2 });
    expect(await slackResumeAuditCount(target)).toBe(1);

    expect(await postSigned(replicaUrl, payload)).toEqual(left);
    expect(await slackResumeAuditCount(target)).toBe(1);
  });

  it('allows exactly one of two different Slack views racing the same trip epoch', async () => {
    const target = scope('tenant-a', 'different-views');
    await trip(target, 0, 'different-views');
    const leftPayload = submissionPayload({
      scope: target,
      expectedEpoch: 1,
      viewId: 'V-RACE-LEFT',
      correlationId: 'incident-view-race',
    });
    const rightPayload = submissionPayload({
      scope: target,
      expectedEpoch: 1,
      viewId: 'V-RACE-RIGHT',
      correlationId: 'incident-view-race',
    });

    const [left, right] = await Promise.all([
      postSigned(appUrl, leftPayload),
      postSigned(replicaUrl, rightPayload),
    ]);
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    expect([left.body, right.body].filter((body) => body === '')).toHaveLength(1);
    expect(
      [left.body, right.body].filter((body) => body.includes('expected epoch 1')),
    ).toHaveLength(1);
    expect(await store.getRecord(target)).toMatchObject({ state: 'armed', epoch: 2 });
    expect(await slackResumeAuditCount(target)).toBe(1);

    expect(await postSigned(appUrl, leftPayload)).toEqual(left);
    expect(await postSigned(replicaUrl, rightPayload)).toEqual(right);
    expect(await slackResumeAuditCount(target)).toBe(1);
  });

  it('rejects an old incident card after resume and retrip without touching the later episode', async () => {
    const target = scope('tenant-a', 'old-card');
    await trip(target, 0, 'old-card-first');
    const firstResume = await postSigned(
      appUrl,
      submissionPayload({
        scope: target,
        expectedEpoch: 1,
        viewId: 'V-OLD-CARD-FIRST',
      }),
    );
    expect(firstResume).toEqual({ status: 200, body: '' });
    await trip(target, 2, 'old-card-later');
    expect(await store.getRecord(target)).toMatchObject({ state: 'tripped', epoch: 3 });

    const stalePayload = submissionPayload({
      scope: target,
      expectedEpoch: 1,
      viewId: 'V-OLD-CARD-DELAYED',
      correlationId: 'first-incident-card',
    });
    const stale = await postSigned(replicaUrl, stalePayload);
    expect(stale.status).toBe(200);
    expect(stale.body).toContain('expected epoch 1, current epoch is 3');
    expect(await postSigned(appUrl, stalePayload)).toEqual(stale);
    expect(await store.getRecord(target)).toMatchObject({
      state: 'tripped',
      epoch: 3,
      reason: 'test incident old-card-later',
    });
    expect(await slackResumeAuditCount(target)).toBe(1);
  });

  it('selects the exact tenant credential and never resumes the matching cross-tenant scope', async () => {
    const sharedAgentId = `slack-shared-${randomUUID().slice(0, 8)}`;
    const tenantA: Scope = {
      tenant: 'tenant-a',
      environment: 'test',
      agentId: sharedAgentId,
    };
    const tenantB: Scope = { ...tenantA, tenant: 'tenant-b' };
    await trip(tenantA, 0, 'tenant-a');
    await trip(tenantB, 0, 'tenant-b');

    const response = await postSigned(
      appUrl,
      submissionPayload({
        scope: tenantB,
        expectedEpoch: 1,
        viewId: 'V-TENANT-B',
      }),
    );
    expect(response).toEqual({ status: 200, body: '' });
    expect(await store.getRecord(tenantB)).toMatchObject({ state: 'armed', epoch: 2 });
    expect(await store.getRecord(tenantA)).toMatchObject({ state: 'tripped', epoch: 1 });
    expect(await slackResumeAuditCount(tenantB)).toBe(1);
    expect(await slackResumeAuditCount(tenantA)).toBe(0);
  });
});
