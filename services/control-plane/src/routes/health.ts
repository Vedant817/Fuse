import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { getMigrationManifest } from '@fuse/breaker-store';
import {
  FUSE_OPERATIONAL_SLO_VERSION,
  getRedisReadinessCheckCounter,
  getRedisReadinessGauge,
} from '@fuse/otel';

const REDIS_READINESS_TIMEOUT_MS = 750;

export interface RedisPingClient {
  ping(): Promise<unknown>;
}

export const REQUIRED_SCHEMA = {
  schema_migrations: ['id', 'checksum', 'applied_at'],
  breaker_state: [
    'tenant',
    'environment',
    'agent_id',
    'state',
    'epoch',
    'reason',
    'policy_version',
    'cooldown_until',
    'updated_at',
    'updated_by_type',
    'updated_by_id',
  ],
  breaker_audit_log: [
    'id',
    'tenant',
    'environment',
    'agent_id',
    'from_state',
    'to_state',
    'epoch_before',
    'epoch_after',
    'actor_type',
    'actor_id',
    'reason',
    'correlation_id',
    'policy_version',
    'noop',
    'created_at',
  ],
  idempotency_keys: [
    'tenant',
    'environment',
    'agent_id',
    'key',
    'request_hash',
    'response_snapshot',
    'created_at',
    'expires_at',
  ],
  preflight_state: [
    'tenant',
    'environment',
    'agent_id',
    'state',
    'reason_code',
    'reason',
    'evaluated_at',
    'last_good_at',
    'required_field_coverage_percent',
    'orphan_rate_percent',
    'freshness_ms',
    'pending_recovery_state',
    'pending_since',
    'evidence_watermark_ms',
    'evidence_version',
    'exporter_source_instance_id',
    'exporter_sequence',
    'exporter_observed_at_ms',
    'exporter_status',
    'exporter_spans',
  ],
  preflight_source_evidence: [
    'tenant',
    'environment',
    'agent_id',
    'source_instance_id',
    'sequence',
    'observed_at_ms',
    'status',
    'spans',
    'received_at',
  ],
  diagnosis_jobs: [
    'audit_event_id',
    'detector',
    'detector_version',
    'score',
    'threshold',
    'starts_at',
    'window_end',
    'notify_slack',
    'status',
    'attempts',
    'available_at',
    'leased_by',
    'leased_until',
    'last_error',
    'created_at',
    'updated_at',
    'completed_at',
  ],
  diagnosis_job_replay_audit: [
    'id',
    'audit_event_id',
    'tenant',
    'environment',
    'agent_id',
    'actor_type',
    'actor_id',
    'reason',
    'idempotency_key',
    'request_hash',
    'created_at',
  ],
  registered_scopes: [
    'tenant',
    'environment',
    'agent_id',
    'policy_version',
    'registered_at',
    'registered_by_type',
    'registered_by_id',
    'registration_reason',
  ],
} as const;

export const REQUIRED_MIGRATION_MANIFEST = getMigrationManifest();
export const REQUIRED_MIGRATIONS = REQUIRED_MIGRATION_MANIFEST.map(({ id }) => id);

export class SchemaNotReadyError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`required database schema is missing or stale: ${missing.join(', ')}`);
    this.name = 'SchemaNotReadyError';
  }
}

export async function assertSchemaReady(pool: pg.Pool): Promise<void> {
  const tableNames = Object.keys(REQUIRED_SCHEMA);
  const columns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])`,
    [tableNames],
  );
  const presentColumns = new Set(
    columns.rows.map(({ table_name, column_name }) => `${table_name}.${column_name}`),
  );
  const missing = Object.entries(REQUIRED_SCHEMA).flatMap(([table, requiredColumns]) =>
    requiredColumns
      .filter((column) => !presentColumns.has(`${table}.${column}`))
      .map((column) => `${table}.${column}`),
  );
  if (missing.length > 0) throw new SchemaNotReadyError(missing);

  const migrations = await pool.query<{ id: string; checksum: string }>(
    'SELECT id, checksum FROM schema_migrations ORDER BY id',
  );
  const applied = new Map(migrations.rows.map(({ id, checksum }) => [id, checksum]));
  const expected = new Map(
    REQUIRED_MIGRATION_MANIFEST.map(({ id, checksum }) => [id, checksum]),
  );
  const migrationProblems = REQUIRED_MIGRATION_MANIFEST.flatMap(({ id, checksum }) => {
    const appliedChecksum = applied.get(id);
    if (appliedChecksum === undefined) return [`migration:${id}`];
    return appliedChecksum === checksum ? [] : [`migration-checksum:${id}`];
  });
  for (const id of applied.keys()) {
    if (!expected.has(id)) migrationProblems.push(`unexpected-migration:${id}`);
  }
  if (migrationProblems.length > 0) {
    throw new SchemaNotReadyError(migrationProblems);
  }
}

export async function assertRateLimitRedisReady(
  redis: RedisPingClient,
  timeoutMs = REDIS_READINESS_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      redis.ping(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('rate-limit Redis PING timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function registerHealthRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  rateLimitRedis?: RedisPingClient,
): void {
  // Liveness: process is up and able to answer HTTP at all. No dependency
  // checks — a flapping dependency must not cause a liveness-probe restart
  // loop; that is what readiness is for. Health probes bypass the global
  // limiter because asking its unavailable store whether liveness may run
  // would make Redis loss indistinguishable from a dead process.
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  // Readiness: can this instance actually serve permit/trip traffic right
  // now? A store outage must flip this to unready so a load balancer stops
  // routing here, without killing the process.
  app.get('/readyz', { config: { rateLimit: false } }, async (_request, reply) => {
    if (rateLimitRedis) {
      try {
        await assertRateLimitRedisReady(rateLimitRedis);
        getRedisReadinessGauge().record(1, {
          'fuse.slo.version': FUSE_OPERATIONAL_SLO_VERSION,
        });
        getRedisReadinessCheckCounter().add(1, {
          'fuse.slo.version': FUSE_OPERATIONAL_SLO_VERSION,
          'fuse.outcome': 'success',
        });
      } catch (err) {
        getRedisReadinessGauge().record(0, {
          'fuse.slo.version': FUSE_OPERATIONAL_SLO_VERSION,
        });
        getRedisReadinessCheckCounter().add(1, {
          'fuse.slo.version': FUSE_OPERATIONAL_SLO_VERSION,
          'fuse.outcome': 'failure',
        });
        app.log.warn({ err }, 'readiness check failed: rate-limit Redis unavailable');
        return reply.code(503).send({
          status: 'not-ready',
          reason: 'rate_limit_store_unavailable',
          dependency: 'redis',
        });
      }
    }
    try {
      await assertSchemaReady(pool);
      return { status: 'ready' };
    } catch (err) {
      if (err instanceof SchemaNotReadyError) {
        app.log.warn(
          { err },
          'readiness check failed: required schema is missing or stale',
        );
        return reply.code(503).send({ status: 'not-ready', reason: 'schema_not_ready' });
      }
      app.log.warn({ err }, 'readiness check failed: store unreachable');
      return reply.code(503).send({ status: 'not-ready', reason: 'store_unavailable' });
    }
  });
}
