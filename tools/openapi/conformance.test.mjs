import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../services/control-plane/dist/app.js';
import {
  REQUIRED_MIGRATIONS,
  REQUIRED_SCHEMA,
} from '../../services/control-plane/dist/routes/health.js';
import { assertResponseConforms, loadOpenApiDocument } from './validator.mjs';

const OPERATOR_TOKEN = 'operator-openapi-contract-token-0001';
const AGENT_TOKEN = 'agent-openapi-contract-token-0000001';
const EXPORTER_TOKEN = 'exporter-openapi-contract-token-001';
const SCOPE = { tenant: 'tenant-a', environment: 'prod', agentId: 'agent-1' };
const OTHER_SCOPE = { ...SCOPE, tenant: 'tenant-b' };
const AUDIT_EVENT_ID = '00000000-0000-4000-8000-000000000001';
const NOW = '2026-08-24T12:00:00.000Z';

const CONFIG = {
  port: 0,
  host: '127.0.0.1',
  logLevel: 'silent',
  deploymentEnvironment: 'test',
  databaseUrl: '',
  dbPoolMax: 10,
  dbPoolIdleTimeoutMs: 30_000,
  dbPoolConnectionTimeoutMs: 2_000,
  dbStatementTimeoutMs: 5_000,
  maxRegisteredScopesPerTenant: 10_000,
  rateLimitMax: 100,
  rateLimitWindowMs: 60_000,
  storeOutageMode: 'fail-closed',
  apiTokens: [{ tenant: SCOPE.tenant, token: OPERATOR_TOKEN }],
  agentApiTokens: [{ ...SCOPE, token: AGENT_TOKEN }],
  exporterEvidenceTokens: [{ ...SCOPE, token: EXPORTER_TOKEN }],
  webhookTokens: [],
  webhookDefaultPolicyVersion: 'openapi-contract-v1',
  webhookDefaultCooldownSeconds: 300,
  webhookMaxAlertAgeMs: 600_000,
  webhookMaxClockSkewAheadMs: 60_000,
  preflightWindowMs: 300_000,
  preflightBlindCoverageThreshold: 0.5,
  preflightBlindOrphanRateThreshold: 0.5,
  preflightBlindTokenMissingRateThreshold: 0.3,
  preflightHeartbeatGraceMs: 120_000,
  preflightMaxEvidenceStalenessMs: 300_000,
  preflightMinRecoveryDwellMs: 60_000,
};

const DIAGNOSIS_CONFIG = {
  mcpServerUrl: undefined,
  slackBotToken: undefined,
  slackChannel: '#fuse-incidents',
  localSnapshotDir: 'output/incidents',
  slackSigningSecret: undefined,
  slackAuthorizedUserIds: [],
  slackTeamId: undefined,
  operatorTokens: [{ tenant: SCOPE.tenant, token: OPERATOR_TOKEN }],
  operatorToken: undefined,
};

const JOB = {
  auditEventId: AUDIT_EVENT_ID,
  scope: SCOPE,
  detector: 'loop-signature',
  measurement: {
    detectorVersion: 'loop-signature-v1',
    score: 4,
    threshold: 3,
    windowEnd: NOW,
  },
  reason: 'loop detector fired',
  correlationId: 'openapi-diagnosis-correlation',
  startsAt: NOW,
  tripEpoch: 1,
  notifySlack: true,
  status: 'dead-letter',
  attempts: 5,
  availableAt: NOW,
  leasedBy: null,
  leasedUntil: null,
  lastError: 'Slack unavailable',
  createdAt: NOW,
  updatedAt: NOW,
  completedAt: null,
};

const PREFLIGHT_RESULT = {
  scope: SCOPE,
  state: 'protected',
  reasonCode: 'healthy',
  reason: 'exporter delivery and structural evidence are healthy',
  evaluatedAt: NOW,
  lastGoodAt: NOW,
  requiredFieldCoveragePercent: 100,
  orphanRatePercent: 0,
  freshnessMs: 0,
  pendingRecoveryState: null,
  pendingSince: null,
};

function healthyPool() {
  return {
    async query(query) {
      if (query.includes('information_schema.columns')) {
        return {
          rows: Object.entries(REQUIRED_SCHEMA).flatMap(([table_name, columns]) =>
            columns.map((column_name) => ({ table_name, column_name })),
          ),
        };
      }
      return { rows: REQUIRED_MIGRATIONS.map((id) => ({ id })) };
    },
  };
}

function appDependencies(overrides = {}) {
  const store = {
    async permit(_scope, correlationId) {
      return {
        allowed: true,
        state: 'armed',
        reason: 'breaker armed',
        epoch: 0,
        degraded: false,
        correlationId,
      };
    },
    async getRecord() {
      return {
        scope: SCOPE,
        state: 'armed',
        epoch: 0,
        reason: 'initialized',
        policyVersion: 'openapi-contract-v1',
        cooldownUntil: null,
        updatedAt: NOW,
        updatedBy: { type: 'system', id: 'system:init' },
      };
    },
  };
  const preflightStore = {
    async evaluateWithTransition() {
      return { result: PREFLIGHT_RESULT, selfAlertTransition: null };
    },
    async getRevalidatedResult() {
      return { result: PREFLIGHT_RESULT, selfAlertTransition: null };
    },
  };
  const detectorRunner = {
    evaluateWindow() {
      return [
        {
          detector: 'loop-signature',
          detectorVersion: 'loop-signature-v1',
          scope: SCOPE,
          fired: false,
          score: 1,
          threshold: 3,
          windowStart: NOW,
          windowEnd: NOW,
          evidence: ['one unique shape in one observation'],
          dedupeKey: 'loop-signature:tenant-a/prod/agent-1',
        },
      ];
    },
  };
  const diagnosisJobStore = {
    async list() {
      return { jobs: [JOB], nextCursor: null };
    },
    async replay() {
      return { kind: 'requeued', job: { ...JOB, status: 'pending', attempts: 0 } };
    },
  };
  return {
    store,
    preflightStore,
    detectorRunner,
    diagnosisJobStore,
    pool: healthyPool(),
    config: CONFIG,
    diagnosisConfig: DIAGNOSIS_CONFIG,
    ...overrides,
  };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function unavailableRateLimitRedis() {
  const redis = {
    status: 'ready',
    defineCommand(name) {
      redis[name] = (...args) => {
        const callback = args.at(-1);
        callback(new Error('injected rate-limit Redis outage'));
      };
    },
    async ping() {
      return 'PONG';
    },
  };
  return redis;
}

async function injectConforming(document, app, contract, options) {
  const response = await app.inject(options);
  const body = response.body.length === 0 ? undefined : response.json();
  assertResponseConforms(document, {
    method: contract.method,
    path: contract.path,
    statusCode: response.statusCode,
    body,
  });
  return response;
}

test('representative buildApp responses conform to the checked-in OpenAPI contract', async (t) => {
  const document = loadOpenApiDocument();
  const apps = [];
  t.after(async () => {
    await Promise.allSettled(apps.map((app) => app.close()));
  });

  const app = await buildApp(appDependencies());
  apps.push(app);
  await app.ready();

  await injectConforming(
    document,
    app,
    { method: 'get', path: '/healthz' },
    { method: 'GET', url: '/healthz' },
  );
  await injectConforming(
    document,
    app,
    { method: 'get', path: '/readyz' },
    { method: 'GET', url: '/readyz' },
  );

  const permit = await injectConforming(
    document,
    app,
    { method: 'post', path: '/v1/permit' },
    {
      method: 'POST',
      url: '/v1/permit',
      headers: bearer(AGENT_TOKEN),
      payload: { scope: SCOPE, correlationId: 'openapi-permit' },
    },
  );
  assert.equal(permit.statusCode, 200);

  const detector = await injectConforming(
    document,
    app,
    { method: 'post', path: '/v1/detectors/observe' },
    {
      method: 'POST',
      url: '/v1/detectors/observe',
      headers: bearer(AGENT_TOKEN),
      payload: {
        scope: SCOPE,
        steps: [
          {
            executionId: 'execution-openapi-1',
            timestampMs: Date.parse(NOW),
            canonicalShape: 'analyzer:stable-shape',
            inputTokens: 100,
            outputTokens: 20,
            pricingStatus: 'unavailable',
            estimatedCostUsd: null,
          },
        ],
      },
    },
  );
  assert.equal(detector.statusCode, 200);

  const forgedExporterEvidence = await injectConforming(
    document,
    app,
    { method: 'post', path: '/v1/preflight/report' },
    {
      method: 'POST',
      url: '/v1/preflight/report',
      headers: bearer(AGENT_TOKEN),
      payload: {
        scope: SCOPE,
        spans: [],
        exporterDelivery: {
          status: 'success',
          observedAtMs: Date.parse(NOW),
          sourceInstanceId: 'forged-agent-process',
          sequence: 1,
        },
      },
    },
  );
  assert.equal(forgedExporterEvidence.statusCode, 400);

  const exporterEvidence = await injectConforming(
    document,
    app,
    { method: 'post', path: '/v1/preflight/exporter-evidence' },
    {
      method: 'POST',
      url: '/v1/preflight/exporter-evidence',
      headers: bearer(EXPORTER_TOKEN),
      payload: {
        scope: SCOPE,
        spans: [],
        exporterDelivery: {
          status: 'success',
          observedAtMs: Date.parse(NOW),
          sourceInstanceId: 'otel-exporter-1',
          sequence: 1,
        },
      },
    },
  );
  assert.equal(exporterEvidence.statusCode, 200);

  const diagnosisList = await injectConforming(
    document,
    app,
    { method: 'get', path: '/v1/diagnosis/jobs' },
    {
      method: 'GET',
      url: `/v1/diagnosis/jobs?tenant=${SCOPE.tenant}`,
      headers: bearer(OPERATOR_TOKEN),
    },
  );
  assert.equal(diagnosisList.statusCode, 200);

  const diagnosisReplay = await injectConforming(
    document,
    app,
    { method: 'post', path: '/v1/diagnosis/jobs/{auditEventId}/replay' },
    {
      method: 'POST',
      url: `/v1/diagnosis/jobs/${AUDIT_EVENT_ID}/replay`,
      headers: bearer(OPERATOR_TOKEN),
      payload: {
        scope: SCOPE,
        actor: { type: 'manual', id: 'operator:openapi' },
        reason: 'replay after repairing Slack',
        idempotencyKey: 'openapi-replay-1',
      },
    },
  );
  assert.equal(diagnosisReplay.statusCode, 200);

  const unauthenticated = await injectConforming(
    document,
    app,
    { method: 'post', path: '/v1/permit' },
    {
      method: 'POST',
      url: '/v1/permit',
      payload: { scope: SCOPE, correlationId: 'openapi-no-auth' },
    },
  );
  assert.equal(unauthenticated.statusCode, 401);

  const tenantDenied = await injectConforming(
    document,
    app,
    { method: 'post', path: '/v1/permit' },
    {
      method: 'POST',
      url: '/v1/permit',
      headers: bearer(AGENT_TOKEN),
      payload: { scope: OTHER_SCOPE, correlationId: 'openapi-tenant-denial' },
    },
  );
  assert.equal(tenantDenied.statusCode, 403);

  const notReadyApp = await buildApp(
    appDependencies({
      pool: { query: async () => Promise.reject(new Error('database unavailable')) },
    }),
  );
  apps.push(notReadyApp);
  await notReadyApp.ready();
  const notReady = await injectConforming(
    document,
    notReadyApp,
    { method: 'get', path: '/readyz' },
    { method: 'GET', url: '/readyz' },
  );
  assert.equal(notReady.statusCode, 503);

  const rateLimitedApp = await buildApp(
    appDependencies({ config: { ...CONFIG, rateLimitMax: 1 } }),
  );
  apps.push(rateLimitedApp);
  await rateLimitedApp.ready();
  const limitedRequest = {
    method: 'POST',
    url: '/v1/permit',
    headers: bearer(AGENT_TOKEN),
    payload: { scope: SCOPE, correlationId: 'openapi-rate-limit' },
  };
  assert.equal((await rateLimitedApp.inject(limitedRequest)).statusCode, 200);
  const rateLimited = await injectConforming(
    document,
    rateLimitedApp,
    { method: 'post', path: '/v1/permit' },
    limitedRequest,
  );
  assert.equal(rateLimited.statusCode, 429);
  assert.equal(
    (await rateLimitedApp.inject({ method: 'GET', url: '/healthz' })).statusCode,
    200,
  );

  const unavailableLimiterApp = await buildApp(
    appDependencies({ rateLimitRedis: unavailableRateLimitRedis() }),
  );
  apps.push(unavailableLimiterApp);
  await unavailableLimiterApp.ready();
  const storeUnavailable = await injectConforming(
    document,
    unavailableLimiterApp,
    { method: 'post', path: '/v1/permit' },
    {
      method: 'POST',
      url: '/v1/permit',
      headers: {
        ...bearer(AGENT_TOKEN),
        'x-correlation-id': 'openapi-rate-limit-store-outage',
      },
      payload: { scope: SCOPE, correlationId: 'openapi-rate-limit-store-outage' },
    },
  );
  assert.equal(storeUnavailable.statusCode, 503);
  assert.deepEqual(storeUnavailable.json(), {
    error: 'store_unavailable',
    message: 'rate limit store is unavailable; request denied',
    correlationId: 'openapi-rate-limit-store-outage',
  });

  const internalErrorApp = await buildApp(
    appDependencies({
      store: {
        async permit() {
          throw new Error('representative internal failure');
        },
      },
    }),
  );
  apps.push(internalErrorApp);
  await internalErrorApp.ready();
  const internalError = await injectConforming(
    document,
    internalErrorApp,
    { method: 'post', path: '/v1/permit' },
    {
      method: 'POST',
      url: '/v1/permit',
      headers: bearer(AGENT_TOKEN),
      payload: { scope: SCOPE, correlationId: 'openapi-internal-error' },
    },
  );
  assert.equal(internalError.statusCode, 500);
});
