import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import type pg from 'pg';
import { FuseHttpError } from '@fuse/contracts';
import type { BreakerStore, PreflightStore } from '@fuse/breaker-store';
import type { ControlPlaneConfig } from './config.js';
import { extractTenantFromRequest, requireBearerAuth } from './auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPermitRoute } from './routes/permit.js';
import { registerBreakerRoutes } from './routes/breaker.js';
import { registerWebhookRoutes } from './routes/webhook.js';
import { registerPreflightRoutes } from './routes/preflight.js';
import { registerDetectorRoutes } from './routes/detectors.js';
import { registerSlackInteractiveRoute } from './routes/slack-interactive.js';
import { DetectorRunner } from './detector-runner.js';
import {
  loadDiagnosisWorkerConfig,
  type DiagnosisWorkerConfig,
} from './diagnosis-worker.js';

const MAX_BODY_BYTES = 64 * 1024;

export interface BuildAppDeps {
  store: BreakerStore;
  preflightStore: PreflightStore;
  /** Defaults to a fresh in-memory `DetectorRunner` if omitted — most
   * callers (existing tests, most of the app's own lifecycle) don't need
   * to observe or control its buffer directly. Pass one explicitly only
   * when a test needs to assert on it or share it with a fixed clock. */
  detectorRunner?: DetectorRunner;
  /** Defaults to `loadDiagnosisWorkerConfig()` (reads env) if omitted. */
  diagnosisConfig?: DiagnosisWorkerConfig;
  pool: pg.Pool;
  config: ControlPlaneConfig;
}

export async function buildApp(deps: BuildAppDeps): Promise<FastifyInstance> {
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
    // Authenticated callers are scoped per-token; unauthenticated ones
    // (health checks) are rate-limited per IP by the plugin default.
    keyGenerator: (request) => {
      const auth = request.headers.authorization;
      return auth ?? request.ip;
    },
  });

  registerHealthRoutes(app, deps.pool);

  const operatorTokens = deps.config.apiTokens;
  const agentAllowedTokens = [...deps.config.apiTokens, ...deps.config.agentApiTokens];
  const webhookAllowedTokens = [...deps.config.apiTokens, ...deps.config.webhookTokens];
  const allKnownTokens = [
    ...deps.config.apiTokens,
    ...deps.config.agentApiTokens,
    ...deps.config.webhookTokens,
  ];

  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/v1/permit')) {
      // Any known token (operator or agent-scoped) may check a permit. A
      // token bound to a specific tenant (not the '*' wildcard) may only
      // check permits for that tenant's own scope.
      await requireBearerAuth(
        agentAllowedTokens,
        allKnownTokens,
        extractTenantFromRequest,
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
        extractTenantFromRequest,
      )(request, reply);
    } else if (request.url.startsWith('/v1/detectors/')) {
      // An agent reports its own step telemetry for detector evaluation —
      // same trust tier as permit/Preflight reporting (it never mutates
      // enforcement state, only the in-memory detector buffer), and the
      // same tenant-scoping rule applies.
      await requireBearerAuth(
        agentAllowedTokens,
        allKnownTokens,
        extractTenantFromRequest,
      )(request, reply);
    } else if (request.url.startsWith('/v1/webhooks/')) {
      // The SigNoz alert webhook — its own least-privilege tier: this
      // token can only cause a trip for the scope named in an alert's own
      // labels, never resume/disable/force-trip arbitrarily. Deliberately
      // NOT tenant-bound even if configured with a `tenant:token` entry —
      // a single SigNoz instance may legitimately watch multiple tenants,
      // and one webhook delivery can carry alerts for several scopes at
      // once. See config.ts's `webhookTokens` doc comment and
      // docs/threat-model.md §3 for this still-open, separately-tracked
      // hardening item.
      await requireBearerAuth(webhookAllowedTokens, allKnownTokens)(request, reply);
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

  registerPermitRoute(app, deps.store, deps.config.storeOutageMode);
  registerBreakerRoutes(app, deps.store);
  registerWebhookRoutes(app, deps.store, deps.config, diagnosisConfig);
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
  registerDetectorRoutes(app, deps.detectorRunner ?? new DetectorRunner());

  app.setErrorHandler((err, request, reply) => {
    if (reply.sent) return;
    const correlationId = request.id;
    if (err instanceof FuseHttpError) {
      reply.code(err.httpStatus).send(err.toBody());
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
