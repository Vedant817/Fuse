import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { FuseHttpError } from '@fuse/contracts';
import {
  FUSE_OPERATIONAL_SLO_VERSION,
  getDetectorObservationLatencyHistogram,
  getDetectorObservationRequestCounter,
  getWebhookLatencyHistogram,
  getWebhookRequestCounter,
} from '@fuse/otel';
import {
  DiagnosisJobStore,
  type BreakerStore,
  type PreflightStore,
} from '@fuse/breaker-store';
import {
  assertSecureAgentTokenConfiguration,
  assertSecureExporterEvidenceTokenConfiguration,
  assertExporterCredentialSeparation,
  assertProductionCredentialConfiguration,
  assertProductionRateLimitConfiguration,
  normalizeTokens,
  type ControlPlaneConfig,
} from './config.js';
import {
  extractScopeFromRequest,
  extractTenantFromRequest,
  extractTenantFromWebhookRequest,
  requireBearerAuth,
} from './auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPermitRoute } from './routes/permit.js';
import { registerBreakerRoutes } from './routes/breaker.js';
import { registerWebhookRoutes } from './routes/webhook.js';
import { registerPreflightRoutes } from './routes/preflight.js';
import { registerDetectorRoutes } from './routes/detectors.js';
import { registerSlackInteractiveRoute } from './routes/slack-interactive.js';
import { registerScopeRoutes } from './routes/scopes.js';
import { registerPolicyRoutes } from './routes/policies.js';
import { registerDiagnosisRoutes } from './routes/diagnosis.js';
import { DetectorRunner } from './detector-runner.js';
import type { DetectorPolicyResolver } from './policy-loader.js';
import {
  loadDiagnosisWorkerConfig,
  type DiagnosisWorkerConfig,
} from './diagnosis-worker.js';

const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_REDIS_CONNECT_TIMEOUT_MS = 2_000;
const RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS = 1_000;
const RATE_LIMIT_REDIS_MAX_RETRIES_PER_REQUEST = 1;

type OperationalHttpOutcome =
  'success' | 'auth_failure' | 'client_error' | 'server_error';

function operationalHttpOutcome(statusCode: number): OperationalHttpOutcome {
  if (statusCode === 401 || statusCode === 403) return 'auth_failure';
  if (statusCode >= 500) return 'server_error';
  if (statusCode >= 400) return 'client_error';
  return 'success';
}

function hashRateLimitValue(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function rateLimitKey(
  request: {
    ip: string;
    url: string;
    headers: { authorization?: string | undefined };
  },
  knownAuthorizationHashes: ReadonlySet<string> = new Set(),
): string {
  if (request.url.startsWith('/healthz') || request.url.startsWith('/readyz')) {
    return `ip:${request.ip}`;
  }
  const authorization = request.headers.authorization;
  if (authorization) {
    const authorizationHash = hashRateLimitValue(authorization);
    if (knownAuthorizationHashes.has(authorizationHash)) {
      return `auth:${authorizationHash}`;
    }
  }
  return `ip:${request.ip}`;
}

/** Creates the documented ioredis integration with bounded connection and
 * command retries. `lazyConnect` lets the real entrypoint prove connectivity
 * before Fastify starts accepting traffic. */
export function createRateLimitRedis(
  config: Pick<ControlPlaneConfig, 'rateLimitRedisUrl'>,
): Redis | undefined {
  if (!config.rateLimitRedisUrl) return undefined;
  return new Redis(config.rateLimitRedisUrl, {
    connectionName: 'fuse-control-plane-rate-limit',
    lazyConnect: true,
    connectTimeout: RATE_LIMIT_REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: RATE_LIMIT_REDIS_MAX_RETRIES_PER_REQUEST,
    enableOfflineQueue: false,
    // Retry connection establishment indefinitely with bounded backoff, while
    // each individual limiter command still fails quickly and closed.
    retryStrategy: (attempt: number) => Math.min(attempt * 100, 5_000),
  });
}

export async function connectRateLimitRedis(redis: Redis): Promise<void> {
  try {
    await redis.connect();
    await redis.ping();
  } catch (error) {
    redis.disconnect(false);
    throw new Error('shared rate-limit Redis is unavailable; startup refused', {
      cause: error,
    });
  }
}

export async function closeRateLimitRedis(redis: Redis): Promise<void> {
  if (redis.status === 'end') return;
  if (redis.status !== 'ready') {
    redis.disconnect(false);
    return;
  }
  try {
    await redis.quit();
  } finally {
    redis.disconnect(false);
  }
}

export interface BuildAppDeps {
  store: BreakerStore;
  preflightStore: PreflightStore;
  /** Defaults to a stateless `DetectorRunner` if omitted. Pass one
   * explicitly only when a test needs a controlled implementation. */
  detectorRunner?: DetectorRunner;
  detectorPolicyResolver?: DetectorPolicyResolver;
  /** Defaults to `loadDiagnosisWorkerConfig()` (reads env) if omitted. */
  diagnosisConfig?: DiagnosisWorkerConfig;
  diagnosisJobStore?: DiagnosisJobStore;
  /** Required in production and passed directly to @fastify/rate-limit's
   * documented `redis` option. Local/test callers may omit it. */
  rateLimitRedis?: Redis;
  pool: pg.Pool;
  config: ControlPlaneConfig;
}

export async function buildApp(deps: BuildAppDeps): Promise<FastifyInstance> {
  assertSecureAgentTokenConfiguration(deps.config);
  assertSecureExporterEvidenceTokenConfiguration(deps.config);
  assertExporterCredentialSeparation(deps.config);
  assertProductionCredentialConfiguration(deps.config);
  assertProductionRateLimitConfiguration(deps.config);
  if (
    deps.config.deploymentEnvironment === 'production' &&
    deps.rateLimitRedis?.status !== 'ready'
  ) {
    throw new Error(
      'invalid control-plane configuration: a connected shared rate-limit Redis client is required in production',
    );
  }
  // No @fastify/cors is registered anywhere in this app, deliberately: every
  // route requires a bearer token (see the preHandler hook below), this API
  // has no browser-facing frontend, and Fastify sets no CORS headers unless
  // a plugin adds them — so a browser's same-origin policy already blocks
  // any cross-origin page from reading a response, with no explicit opt-out
  // needed. Do not add @fastify/cors without a concrete browser caller that
  // needs it, and if one appears, scope its `origin` allowlist explicitly
  // rather than reflecting the request's Origin or using '*'.
  const app = Fastify({
    logger: { level: deps.config.logLevel },
    bodyLimit: MAX_BODY_BYTES,
    // Left `false` deliberately: this process has no reverse proxy in the
    // documented local/dev topology (infra/docker-compose.yml exposes it
    // directly), so trusting X-Forwarded-* here would let any caller spoof
    // `request.ip` (used only for unauthenticated health-route rate-limit
    // keys, but still). A production deployment behind a real reverse proxy
    // must set this appropriately for that topology — tracked in the
    // operability runbook (docs/runbooks/), not assumed here.
    trustProxy: false,
    genReqId: () => crypto.randomUUID(),
  });

  // Slack's interactive payload arrives as application/x-www-form-urlencoded
  // with a `payload` field containing URL-encoded JSON. The raw string (not
  // a parsed object) is preserved as `request.body` because HMAC signature
  // verification (routes/slack-interactive.ts) needs the exact bytes Slack
  // signed, not a re-serialized reconstruction of them.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, body);
    },
  );

  const diagnosisConfig = deps.diagnosisConfig ?? loadDiagnosisWorkerConfig();
  const rateLimitHookPending = new WeakSet<object>();
  const knownAuthorizationHashes = new Set(
    normalizeTokens([
      ...deps.config.apiTokens,
      ...deps.config.agentApiTokens,
      ...deps.config.exporterEvidenceTokens,
      ...deps.config.webhookTokens,
    ]).map(({ token }) => hashRateLimitValue(`Bearer ${token}`)),
  );

  // Baseline response headers (X-Content-Type-Options, X-Frame-Options,
  // Referrer-Policy, etc.) — this is a JSON-only API with no browser
  // audience by design (see CORS below), so these are defense-in-depth
  // against a caller ever rendering a response in a browser context, not a
  // primary control. Defaults from @fastify/helmet are safe for a JSON API:
  // there is no HTML/inline-script response for a CSP to break.
  await app.register(helmet);

  await app.register(rateLimit, {
    max: deps.config.rateLimitMax,
    timeWindow: deps.config.rateLimitWindowMs,
    ...(deps.rateLimitRedis ? { redis: deps.rateLimitRedis } : {}),
    nameSpace: `fuse-rate-limit:${hashRateLimitValue(deps.config.deploymentEnvironment).slice(0, 16)}:`,
    // A storage outage must deny the request rather than silently create
    // unbounded access. This is also @fastify/rate-limit's documented default,
    // kept explicit because it is a production safety property.
    skipOnError: false,
    keyGenerator: (request) => {
      // The Redis store call follows immediately inside the plugin's route-level
      // onRequest hook. preParsing clears this only after every onRequest hook
      // completed, so a raw store error can be identified without inspecting
      // unstable ioredis error classes or conflating later route failures.
      rateLimitHookPending.add(request);
      return rateLimitKey(request, knownAuthorizationHashes);
    },
    errorResponseBuilder: (request) =>
      new FuseHttpError('rate_limited', 'rate limit exceeded', 429, request.id),
  });

  app.addHook('preParsing', async (request) => {
    rateLimitHookPending.delete(request);
  });

  registerHealthRoutes(app, deps.pool, deps.rateLimitRedis);

  const operatorTokens = deps.config.apiTokens;
  const agentAllowedTokens = [...deps.config.apiTokens, ...deps.config.agentApiTokens];
  const webhookAllowedTokens = [...deps.config.apiTokens, ...deps.config.webhookTokens];
  const exporterEvidenceTokens = deps.config.exporterEvidenceTokens;
  const allKnownTokens = [
    ...deps.config.apiTokens,
    ...deps.config.agentApiTokens,
    ...deps.config.exporterEvidenceTokens,
    ...deps.config.webhookTokens,
  ];

  // These are infrastructure-wide SLO series. They intentionally carry no
  // tenant, agent, token, correlation, alert, or detector identity.
  app.addHook('onResponse', async (request, reply) => {
    const attributes = {
      'fuse.slo.version': FUSE_OPERATIONAL_SLO_VERSION,
      'fuse.outcome': operationalHttpOutcome(reply.statusCode),
    };
    const durationSeconds = Math.max(0, reply.elapsedTime) / 1_000;
    if (request.url.startsWith('/v1/detectors/observe')) {
      getDetectorObservationRequestCounter().add(1, attributes);
      getDetectorObservationLatencyHistogram().record(durationSeconds, attributes);
    } else if (request.url.startsWith('/v1/webhooks/signoz')) {
      getWebhookRequestCounter().add(1, attributes);
      getWebhookLatencyHistogram().record(durationSeconds, attributes);
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (
      request.url.startsWith('/v1/scopes/') ||
      request.url.startsWith('/v1/policies/') ||
      request.url.startsWith('/v1/diagnosis/')
    ) {
      await requireBearerAuth(
        operatorTokens,
        allKnownTokens,
        extractTenantFromRequest,
      )(request, reply);
    } else if (request.url.startsWith('/v1/permit')) {
      // Any known token (operator or agent-scoped) may check a permit. A
      // token bound to a specific tenant (not the '*' wildcard) may only
      // check permits for that tenant's own scope.
      await requireBearerAuth(
        agentAllowedTokens,
        allKnownTokens,
        extractScopeFromRequest,
      )(request, reply);
    } else if (request.url.startsWith('/v1/preflight/exporter-evidence')) {
      // Exporter delivery is a separate capability from agent observations.
      // Only exact-scope exporter credentials reach this endpoint; operator,
      // agent, and webhook credentials are known but intentionally forbidden.
      await requireBearerAuth(
        exporterEvidenceTokens,
        allKnownTokens,
        extractScopeFromRequest,
      )(request, reply);
    } else if (request.url.startsWith('/v1/preflight/')) {
      // An agent reports and reads its own telemetry-health evidence —
      // same trust tier as the permit check, not the operator-only
      // enforcement API — and the same tenant-scoping rule applies.
      const body = request.body;
      const changesDisabledState =
        request.method === 'POST' &&
        typeof body === 'object' &&
        body !== null &&
        (Object.prototype.hasOwnProperty.call(body, 'disabled') ||
          Object.prototype.hasOwnProperty.call(body, 'disabledReason'));
      await requireBearerAuth(
        changesDisabledState ? operatorTokens : agentAllowedTokens,
        allKnownTokens,
        extractScopeFromRequest,
      )(request, reply);
    } else if (request.url.startsWith('/v1/detectors/')) {
      // An agent reports its own step telemetry for detector evaluation —
      // same trust tier as permit/Preflight reporting. A firing detector
      // atomically trips that registered scope, so tenant binding and the
      // explicit scope registry bound this self-denial capability.
      await requireBearerAuth(
        agentAllowedTokens,
        allKnownTokens,
        extractScopeFromRequest,
      )(request, reply);
    } else if (request.url.startsWith('/v1/webhooks/')) {
      // The SigNoz alert webhook — its own least-privilege tier: this
      // token can only cause a trip for the scope named in an alert's own
      // labels, never resume/disable/force-trip arbitrarily. Tenant-bound
      // credentials must match every alert in a grouped delivery; a plain
      // wildcard token is the explicit escape hatch for a shared SigNoz.
      await requireBearerAuth(
        webhookAllowedTokens,
        allKnownTokens,
        extractTenantFromWebhookRequest,
      )(request, reply);
    } else if (request.url.startsWith('/v1/breaker/')) {
      // Force-trip/resume/disable/enable/status require an operator token;
      // an agent-scoped or webhook-scoped token is a valid credential but
      // gets 403, not a silent pass — see auth.ts for why that distinction
      // matters. A tenant-bound operator token may only act on its own
      // tenant's breakers.
      await requireBearerAuth(
        operatorTokens,
        allKnownTokens,
        extractTenantFromRequest,
      )(request, reply);
    }
  });

  registerPermitRoute(
    app,
    deps.store,
    deps.detectorPolicyResolver
      ? (scope) => deps.detectorPolicyResolver!.resolve(scope).storeOutageMode
      : deps.config.storeOutageMode,
  );
  registerScopeRoutes(app, deps.store);
  registerPolicyRoutes(
    app,
    deps.store,
    (scope) =>
      deps.detectorPolicyResolver?.resolve(scope) ?? {
        policyVersion: deps.config.webhookDefaultPolicyVersion,
        cooldownSeconds: deps.config.webhookDefaultCooldownSeconds,
        storeOutageMode: deps.config.storeOutageMode,
        controlPlaneOutageMode: 'fail-closed',
        detectors: {},
        notificationRoutes: ['slack'],
      },
  );
  registerDiagnosisRoutes(
    app,
    deps.diagnosisJobStore ?? new DiagnosisJobStore(deps.pool),
  );
  registerBreakerRoutes(app, deps.store);
  registerWebhookRoutes(
    app,
    deps.store,
    deps.config,
    deps.detectorPolicyResolver
      ? (scope) => deps.detectorPolicyResolver!.resolve(scope)
      : undefined,
  );
  registerSlackInteractiveRoute(
    app,
    diagnosisConfig,
    `http://127.0.0.1:${deps.config.port}`,
  );
  registerPreflightRoutes(app, deps.preflightStore, {
    windowMs: deps.config.preflightWindowMs,
    blindCoverageThreshold: deps.config.preflightBlindCoverageThreshold,
    blindOrphanRateThreshold: deps.config.preflightBlindOrphanRateThreshold,
    blindTokenMissingRateThreshold: deps.config.preflightBlindTokenMissingRateThreshold,
    heartbeatGraceMs: deps.config.preflightHeartbeatGraceMs,
    maxEvidenceStalenessMs: deps.config.preflightMaxEvidenceStalenessMs,
    minRecoveryDwellMs: deps.config.preflightMinRecoveryDwellMs,
  });
  registerDetectorRoutes(app, deps.detectorRunner ?? new DetectorRunner(), deps.store, {
    policyVersion: deps.config.webhookDefaultPolicyVersion,
    cooldownSeconds: deps.config.webhookDefaultCooldownSeconds,
    ...(deps.detectorPolicyResolver
      ? { resolvePolicy: (scope) => deps.detectorPolicyResolver!.resolve(scope) }
      : {}),
  });

  app.setErrorHandler((err, request, reply) => {
    if (reply.sent) return;
    const correlationHeader = request.headers['x-correlation-id'];
    const correlationId =
      typeof correlationHeader === 'string' && correlationHeader.length > 0
        ? correlationHeader
        : request.id;
    if (err instanceof FuseHttpError) {
      reply.code(err.httpStatus).send(err.toBody());
      return;
    }

    if (deps.rateLimitRedis && rateLimitHookPending.has(request)) {
      request.log.warn({ err }, 'rate-limit store unavailable; request denied');
      const httpErr = new FuseHttpError(
        'store_unavailable',
        'rate limit store is unavailable; request denied',
        503,
        correlationId,
      );
      reply.code(httpErr.httpStatus).send(httpErr.toBody());
      return;
    }

    // Fastify's own framework errors (oversized body past `bodyLimit`,
    // malformed JSON, unsupported content-type, ...) carry a genuine
    // client-error `statusCode` before ever reaching a route handler.
    // Forcing every non-`FuseHttpError` to a generic 500 hid these real
    // 4xx failures as "internal error" — e.g. a body over MAX_BODY_BYTES
    // was reported as a server fault instead of the caller's mistake.
    const frameworkErr = err as { statusCode?: number; message?: string };
    const fastifyStatus = frameworkErr.statusCode;
    if (fastifyStatus !== undefined && fastifyStatus >= 400 && fastifyStatus < 500) {
      const httpErr = new FuseHttpError(
        'invalid_request',
        frameworkErr.message ?? 'invalid request',
        fastifyStatus,
        correlationId,
      );
      reply.code(httpErr.httpStatus).send(httpErr.toBody());
      return;
    }

    request.log.error({ err }, 'unhandled error');
    const httpErr = new FuseHttpError(
      'internal_error',
      'internal error',
      500,
      correlationId,
    );
    reply.code(httpErr.httpStatus).send(httpErr.toBody());
  });

  return app;
}
