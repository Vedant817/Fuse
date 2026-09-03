import assert from 'node:assert/strict';
import process from 'node:process';
import { URL, URLSearchParams } from 'node:url';

const baseUrl = process.env.FUSE_SMOKE_URL ?? 'http://127.0.0.1:8090';
const suffix = process.env.FUSE_SMOKE_SUFFIX;
const operatorToken = process.env.FUSE_SMOKE_OPERATOR_TOKEN;

if (!suffix || !operatorToken) {
  throw new Error('FUSE_SMOKE_SUFFIX and FUSE_SMOKE_OPERATOR_TOKEN are required');
}

const detectorCases = [
  {
    detector: 'loop-signature',
    slug: 'loop',
    buildSteps(now, executionId) {
      return Array.from({ length: 6 }, (_, index) => ({
        executionId,
        timestampMs: now - (6 - index) * 1_000,
        canonicalShape: index % 2 === 0 ? 'analyzer:unchanged' : 'verifier:revise',
        inputTokens: 200,
        outputTokens: 40,
        pricingStatus: 'available',
        estimatedCostUsd: 0.001,
      }));
    },
  },
  {
    detector: 'context-bloat',
    slug: 'context',
    buildSteps(now, executionId) {
      return [
        {
          executionId,
          timestampMs: now - 1_000,
          canonicalShape: 'context:absolute-ceiling',
          inputTokens: 100_000,
          outputTokens: 40,
          pricingStatus: 'available',
          estimatedCostUsd: 0.001,
        },
      ];
    },
  },
  {
    detector: 'cost-velocity',
    slug: 'cost',
    buildSteps(now, executionId) {
      return [3_500, 2_000, 1_000].map((ageMs, index) => ({
        executionId,
        timestampMs: now - ageMs,
        canonicalShape: `cost:burst-${index}`,
        inputTokens: 300,
        outputTokens: 100,
        pricingStatus: 'available',
        estimatedCostUsd: 0.2,
      }));
    },
  },
];

function credential(kind, slug) {
  return `release-${kind}-${slug}-${suffix}-0123456789abcdef0123456789abcdef`;
}

async function requestJson(
  path,
  { token, method = 'GET', body, expectedStatuses = [200] } = {},
) {
  const response = await globalThis.fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `${method} ${path} returned non-JSON HTTP ${response.status}: ${text}`,
    );
  }
  assert.equal(
    expectedStatuses.includes(response.status),
    true,
    `${method} ${path}: ${text}`,
  );
  return value;
}

for (const detectorCase of detectorCases) {
  const agentId = `release-${detectorCase.slug}-${suffix}`;
  const agentToken = credential('agent', detectorCase.slug);
  const exporterToken = credential('exporter', detectorCase.slug);
  const scope = { tenant: 'release-tenant', environment: 'production', agentId };
  const executionId = `release-${detectorCase.slug}-${suffix}`;

  await requestJson('/v1/scopes/register', {
    token: operatorToken,
    method: 'POST',
    expectedStatuses: [200, 201],
    body: {
      scope,
      policyVersion: 'fuse-production-v1',
      actor: { type: 'manual', id: 'release-smoke' },
      reason: `release ${detectorCase.detector} smoke registration`,
      correlationId: `release-register-${detectorCase.slug}-${suffix}`,
    },
  });

  const initialPermit = await requestJson('/v1/permit', {
    token: agentToken,
    method: 'POST',
    body: {
      scope,
      correlationId: `release-initial-permit-${detectorCase.slug}-${suffix}`,
    },
  });
  assert.deepEqual(
    {
      allowed: initialPermit.allowed,
      degraded: initialPermit.degraded,
      state: initialPermit.state,
    },
    { allowed: true, degraded: false, state: 'armed' },
  );

  const now = Date.now();
  const exporterResult = await requestJson('/v1/preflight/exporter-evidence', {
    token: exporterToken,
    method: 'POST',
    body: {
      scope,
      spans: [
        {
          timestampMs: now,
          hasRequestModel: true,
          hasInputTokens: true,
          hasOutputTokens: true,
          hasScopedIdentity: true,
          hasValidTimestamps: true,
          isRootSpan: true,
          hasParent: false,
        },
      ],
      exporterDelivery: {
        status: 'success',
        observedAtMs: now,
        sourceInstanceId: `release-smoke-${detectorCase.slug}-${suffix}`,
        sequence: 1,
      },
    },
  });
  assert.deepEqual(exporterResult.result.scope, scope);

  const observation = await requestJson('/v1/detectors/observe', {
    token: agentToken,
    method: 'POST',
    body: { scope, steps: detectorCase.buildSteps(now, executionId) },
  });
  assert.deepEqual(
    observation.results.filter((result) => result.fired).map((result) => result.detector),
    [detectorCase.detector],
  );
  assert.deepEqual(observation.enforcement, [
    { detector: detectorCase.detector, outcome: 'tripped' },
  ]);

  const deniedPermit = await requestJson('/v1/permit', {
    token: agentToken,
    method: 'POST',
    body: {
      scope,
      correlationId: `release-denied-permit-${detectorCase.slug}-${suffix}`,
    },
  });
  assert.deepEqual(
    {
      allowed: deniedPermit.allowed,
      degraded: deniedPermit.degraded,
      state: deniedPermit.state,
    },
    { allowed: false, degraded: false, state: 'tripped' },
  );

  const query = new URLSearchParams({
    tenant: scope.tenant,
    environment: scope.environment,
    agentId: scope.agentId,
  });
  const diagnosis = await requestJson(`/v1/diagnosis/jobs?${query}`, {
    token: operatorToken,
  });
  assert.equal(diagnosis.jobs.length, 1);
  assert.deepEqual(diagnosis.jobs[0].scope, scope);
  assert.equal(diagnosis.jobs[0].detector, detectorCase.detector);
  assert.equal(diagnosis.jobs[0].tripEpoch, 1);
  assert.equal(diagnosis.jobs[0].measurement?.detectorVersion.length > 0, true);
}

process.stdout.write(
  `Exact-image detector, exporter, enforcement, and diagnosis smoke passed for ${suffix}.\n`,
);
