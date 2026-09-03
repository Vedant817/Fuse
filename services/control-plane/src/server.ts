import {
  BreakerStore,
  DiagnosisJobStore,
  PreflightStore,
  createPool,
} from '@fuse/breaker-store';
import { DetectorRunner } from './detector-runner.js';
import { bootstrapOtel, type FuseOtelHandle } from '@fuse/otel';
import {
  buildApp,
  closeRateLimitRedis,
  connectRateLimitRedis,
  createRateLimitRedis,
} from './app.js';
import { loadConfig } from './config.js';
import { createShutdownHandler } from './shutdown.js';
import { loadDetectorPolicyFile } from './policy-loader.js';
import { assertSchemaReady } from './routes/health.js';
import { loadDiagnosisWorkerConfig } from './diagnosis-worker.js';
import {
  DiagnosisDispatcher,
  loadDiagnosisDispatcherConfig,
} from './diagnosis-dispatcher.js';
import { PreflightSweeper } from './routes/preflight-sweeper.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const rateLimitRedis = createRateLimitRedis(config);
  if (rateLimitRedis) await connectRateLimitRedis(rateLimitRedis);

  // Must happen exactly once, before anything else touches OTel's global
  // tracer/meter providers (registration is a one-shot no-op on repeat) —
  // and only here in the real entrypoint, never inside buildApp(), which
  // every integration test also calls, often many times per process.
  const otel: FuseOtelHandle = bootstrapOtel({
    serviceName: 'fuse-control-plane',
    serviceVersion: process.env['npm_package_version'] ?? '0.0.0',
    deploymentEnvironment: config.deploymentEnvironment,
  });

  // `createPool` (not a raw `new pg.Pool(...)`) so this real, long-running
  // process gets the same idle-client-error safety net (`pool.on('error',
  // ...)`, preventing an idle pooled connection failure from crashing the
  // whole server) and connection/statement timeouts that @fuse/breaker-store
  // documents and tests — previously only test/CLI code paths constructed
  // pools this way; the actual server built its own, unguarded pool.
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: config.dbPoolIdleTimeoutMs,
    connectionTimeoutMillis: config.dbPoolConnectionTimeoutMs,
    statementTimeoutMillis: config.dbStatementTimeoutMs,
  });
  try {
    await assertSchemaReady(pool);
  } catch (err) {
    throw new Error(
      'required database migrations/schema are missing or stale. Run migrations first: ' +
        '`pnpm --filter @fuse/breaker-store run migrate` (or `infra/reset.sh` for a full local reset).',
      { cause: err },
    );
  }
  const diagnosisJobStore = new DiagnosisJobStore(pool);
  try {
    await diagnosisJobStore.assertReady();
  } catch (err) {
    throw new Error(
      'required diagnosis delivery schema is missing. Run migration 0005 before starting the control plane.',
      { cause: err },
    );
  }

  const store = new BreakerStore(pool, undefined, config.maxRegisteredScopesPerTenant);
  const preflightStore = new PreflightStore(pool);
  const detectorRunner = new DetectorRunner();
  const detectorPolicyResolver = config.detectorPolicyFile
    ? await loadDetectorPolicyFile(config.detectorPolicyFile)
    : undefined;
  const diagnosisConfig = loadDiagnosisWorkerConfig();
  const app = await buildApp({
    store,
    preflightStore,
    detectorRunner,
    pool,
    config,
    diagnosisConfig,
    diagnosisJobStore,
    ...(rateLimitRedis ? { rateLimitRedis } : {}),
    ...(detectorPolicyResolver ? { detectorPolicyResolver } : {}),
  });
  rateLimitRedis?.on('error', (err: Error) => {
    app.log.error({ err }, 'shared rate-limit Redis error');
  });
  const diagnosisDispatcher = new DiagnosisDispatcher(
    {
      store: diagnosisJobStore,
      diagnosisConfig,
      log: app.log,
    },
    loadDiagnosisDispatcherConfig(),
  );
  const preflightConfig = {
    windowMs: config.preflightWindowMs,
    blindCoverageThreshold: config.preflightBlindCoverageThreshold,
    blindOrphanRateThreshold: config.preflightBlindOrphanRateThreshold,
    blindTokenMissingRateThreshold: config.preflightBlindTokenMissingRateThreshold,
    heartbeatGraceMs: config.preflightHeartbeatGraceMs,
    maxEvidenceStalenessMs: config.preflightMaxEvidenceStalenessMs,
    minRecoveryDwellMs: config.preflightMinRecoveryDwellMs,
  };
  const preflightSweeper = new PreflightSweeper({
    store: preflightStore,
    config: preflightConfig,
    log: app.log,
    intervalMs: Math.max(
      1_000,
      Math.min(30_000, Math.floor(config.preflightMaxEvidenceStalenessMs / 2)),
    ),
    batchSize: 100,
  });
  app.addHook('onClose', () => preflightSweeper.stop());

  const shutdown = createShutdownHandler({
    log: app.log,
    closeApp: () => app.close(),
    stopDiagnosisDispatcher: () => diagnosisDispatcher.stop(),
    closeRateLimitRedis: () =>
      rateLimitRedis ? closeRateLimitRedis(rateLimitRedis) : Promise.resolve(),
    closePool: () => pool.end(),
    shutdownOtel: () => otel.shutdown(),
    exit: (code) => process.exit(code),
  });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  preflightSweeper.start();
  diagnosisDispatcher.start();
}

main().catch((err) => {
  console.error('control-plane failed to start:', err);
  process.exit(1);
});
