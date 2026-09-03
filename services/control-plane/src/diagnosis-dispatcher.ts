import { randomUUID } from 'node:crypto';
import type { DiagnosisJob, DiagnosisJobStore } from '@fuse/breaker-store';
import { DetectorTypeSchema, type DetectorResult } from '@fuse/contracts';
import {
  FUSE_OPERATIONAL_SLO_VERSION,
  getDiagnosisDeliveryAttemptCounter,
  getDiagnosisDeliveryLatencyHistogram,
  getDiagnosisLeaseRenewalFailureCounter,
  getDiagnosisQueueDepthGauge,
} from '@fuse/otel';
import {
  runDiagnosisAndNotify,
  type DiagnosisDeliveryResult,
  type DiagnosisTrigger,
  type DiagnosisWorkerConfig,
} from './diagnosis-worker.js';

export interface DiagnosisDispatcherConfig {
  pollIntervalMs: number;
  concurrency: number;
  leaseMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  backoffJitterRatio: number;
}

interface DispatcherLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface DiagnosisDispatcherDependencies {
  store: DiagnosisJobStore;
  diagnosisConfig: DiagnosisWorkerConfig;
  log: DispatcherLogger;
  workerId?: string;
  random?: () => number;
  deliver?: (
    trigger: DiagnosisTrigger,
    config: DiagnosisWorkerConfig,
    log: (message: string, meta?: Record<string, unknown>) => void,
  ) => Promise<DiagnosisDeliveryResult>;
}

const DEFAULT_CONFIG: DiagnosisDispatcherConfig = {
  pollIntervalMs: 250,
  concurrency: 4,
  leaseMs: 60_000,
  maxAttempts: 5,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  backoffJitterRatio: 0.2,
};

function integerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function loadDiagnosisDispatcherConfig(
  env: NodeJS.ProcessEnv = process.env,
): DiagnosisDispatcherConfig {
  const jitterRaw = env['FUSE_DIAGNOSIS_BACKOFF_JITTER_RATIO'];
  const jitter =
    jitterRaw === undefined ? DEFAULT_CONFIG.backoffJitterRatio : Number(jitterRaw);
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new Error('FUSE_DIAGNOSIS_BACKOFF_JITTER_RATIO must be between 0 and 1');
  }
  const config = {
    pollIntervalMs: integerEnv(
      env,
      'FUSE_DIAGNOSIS_POLL_MS',
      DEFAULT_CONFIG.pollIntervalMs,
      10,
      60_000,
    ),
    concurrency: integerEnv(
      env,
      'FUSE_DIAGNOSIS_CONCURRENCY',
      DEFAULT_CONFIG.concurrency,
      1,
      100,
    ),
    leaseMs: integerEnv(
      env,
      'FUSE_DIAGNOSIS_LEASE_MS',
      DEFAULT_CONFIG.leaseMs,
      1_000,
      24 * 60 * 60_000,
    ),
    maxAttempts: integerEnv(
      env,
      'FUSE_DIAGNOSIS_MAX_ATTEMPTS',
      DEFAULT_CONFIG.maxAttempts,
      1,
      100,
    ),
    backoffBaseMs: integerEnv(
      env,
      'FUSE_DIAGNOSIS_BACKOFF_BASE_MS',
      DEFAULT_CONFIG.backoffBaseMs,
      1,
      24 * 60 * 60_000,
    ),
    backoffMaxMs: integerEnv(
      env,
      'FUSE_DIAGNOSIS_BACKOFF_MAX_MS',
      DEFAULT_CONFIG.backoffMaxMs,
      1,
      24 * 60 * 60_000,
    ),
    backoffJitterRatio: jitter,
  };
  if (config.backoffMaxMs < config.backoffBaseMs) {
    throw new Error(
      'FUSE_DIAGNOSIS_BACKOFF_MAX_MS must be greater than or equal to FUSE_DIAGNOSIS_BACKOFF_BASE_MS',
    );
  }
  return config;
}

export class DiagnosisDispatcher {
  private readonly workerId: string;
  private readonly random: () => number;
  private readonly deliver: NonNullable<DiagnosisDispatcherDependencies['deliver']>;
  private readonly inFlight = new Set<Promise<void>>();
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling: Promise<void> | undefined;

  constructor(
    private readonly dependencies: DiagnosisDispatcherDependencies,
    private readonly config: DiagnosisDispatcherConfig = loadDiagnosisDispatcherConfig(),
  ) {
    this.workerId = dependencies.workerId ?? `diagnosis-${process.pid}-${randomUUID()}`;
    this.random = dependencies.random ?? Math.random;
    this.deliver = dependencies.deliver ?? runDiagnosisAndNotify;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  /** Stops claiming, then waits for the bounded in-flight batch to finish.
   * Each dependency call has its own timeout, so drain itself is bounded by
   * the configured attempt path rather than abandoning live leases early. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.polling;
    await Promise.allSettled([...this.inFlight]);
  }

  /** Runs one claim batch and waits for it. Exposed for deterministic tests
   * and operational probes; the production loop calls the same method. */
  async runOnce(): Promise<number> {
    const capacity = this.config.concurrency - this.inFlight.size;
    if (capacity <= 0) return 0;
    const jobs = await this.dependencies.store.claim(
      this.workerId,
      capacity,
      this.config.leaseMs,
      this.config.maxAttempts,
    );
    await this.refreshQueueMetrics();
    const attempts = jobs.map((job) => this.launch(job));
    await Promise.allSettled(attempts);
    await this.refreshQueueMetrics();
    return jobs.length;
  }

  private launch(job: DiagnosisJob): Promise<void> {
    const attempt = this.process(job).finally(() => this.inFlight.delete(attempt));
    this.inFlight.add(attempt);
    return attempt;
  }

  private async process(job: DiagnosisJob): Promise<void> {
    const startedAt = Date.now();
    const renewal = this.startLeaseRenewal(job);
    let result: DiagnosisDeliveryResult;
    try {
      const detector = DetectorTypeSchema.safeParse(job.detector);
      const detectorResult: DetectorResult | undefined =
        detector.success && job.measurement
          ? {
              detector: detector.data,
              detectorVersion: job.measurement.detectorVersion,
              scope: job.scope,
              fired: true,
              score: job.measurement.score,
              threshold: job.measurement.threshold,
              windowStart: job.startsAt,
              windowEnd: job.measurement.windowEnd,
              evidence: [],
              dedupeKey: job.correlationId,
            }
          : undefined;
      result = await this.deliver(
        {
          auditEventId: job.auditEventId,
          scope: job.scope,
          detector: job.detector,
          reason: job.reason,
          correlationId: job.correlationId,
          startsAt: job.startsAt,
          tripEpoch: job.tripEpoch,
          notifySlack: job.notifySlack,
          ...(detectorResult ? { detectorResult } : {}),
        },
        this.dependencies.diagnosisConfig,
        (message, meta) =>
          this.dependencies.log.info(
            { auditEventId: job.auditEventId, ...meta },
            message,
          ),
      );
    } catch (error) {
      result = {
        delivered: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const leaseOwned = await renewal.stop();
    if (!leaseOwned) {
      this.dependencies.log.error(
        { auditEventId: job.auditEventId },
        'diagnosis delivery lost its lease during delivery',
      );
      this.recordAttempt(startedAt, 'lease-lost');
      return;
    }

    if (result.delivered) {
      const completed = await this.dependencies.store.complete(
        job.auditEventId,
        this.workerId,
      );
      if (!completed) {
        this.dependencies.log.error(
          { auditEventId: job.auditEventId },
          'diagnosis completion lost its lease',
        );
        this.recordAttempt(startedAt, 'lease-lost');
      } else {
        this.recordAttempt(startedAt, 'succeeded');
      }
      return;
    }

    const disposition = await this.dependencies.store.fail(
      job.auditEventId,
      this.workerId,
      result.reason,
      this.retryDelay(job.attempts),
      this.config.maxAttempts,
    );
    const bindings = {
      auditEventId: job.auditEventId,
      attempt: job.attempts,
      disposition,
      reason: result.reason,
    };
    if (disposition === 'dead-letter') {
      this.dependencies.log.error(bindings, 'diagnosis job exhausted attempts');
    } else {
      this.dependencies.log.info(bindings, 'diagnosis job delivery deferred');
    }
    this.recordAttempt(startedAt, disposition);
  }

  private startLeaseRenewal(job: DiagnosisJob): {
    stop: () => Promise<boolean>;
  } {
    const intervalMs = Math.max(10, Math.floor(this.config.leaseMs / 3));
    let stopped = false;
    let leaseOwned = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeRenewal: Promise<void> = Promise.resolve();

    const schedule = () => {
      if (stopped || !leaseOwned) return;
      timer = setTimeout(() => {
        activeRenewal = this.dependencies.store
          .renewLease(job.auditEventId, this.workerId, this.config.leaseMs)
          .then((renewed) => {
            leaseOwned = renewed;
            if (!renewed) {
              getDiagnosisLeaseRenewalFailureCounter().add(1, {
                'fuse.slo.version': FUSE_OPERATIONAL_SLO_VERSION,
                'fuse.reason': 'rejected',
              });
              this.dependencies.log.error(
                { auditEventId: job.auditEventId },
                'diagnosis lease renewal rejected',
              );
            }
          })
          .catch((error) => {
            leaseOwned = false;
            getDiagnosisLeaseRenewalFailureCounter().add(1, {
              'fuse.slo.version': FUSE_OPERATIONAL_SLO_VERSION,
              'fuse.reason': 'error',
            });
            this.dependencies.log.error(
              {
                auditEventId: job.auditEventId,
                error: error instanceof Error ? error.message : String(error),
              },
              'diagnosis lease renewal failed',
            );
          })
          .finally(schedule);
      }, intervalMs);
      timer.unref?.();
    };
    schedule();

    return {
      stop: async () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        await activeRenewal;
        return leaseOwned;
      },
    };
  }

  private recordAttempt(
    startedAt: number,
    outcome: 'succeeded' | 'retry' | 'dead-letter' | 'lease-lost',
  ): void {
    const attributes = {
      'fuse.slo.version': FUSE_OPERATIONAL_SLO_VERSION,
      'fuse.diagnosis.outcome': outcome,
    };
    getDiagnosisDeliveryAttemptCounter().add(1, attributes);
    getDiagnosisDeliveryLatencyHistogram().record(
      Math.max(0, Date.now() - startedAt) / 1_000,
      attributes,
    );
  }

  private async refreshQueueMetrics(): Promise<void> {
    try {
      const counts = await this.dependencies.store.countQueue();
      const gauge = getDiagnosisQueueDepthGauge();
      for (const status of ['pending', 'running', 'dead-letter'] as const) {
        gauge.record(counts[status], {
          'fuse.slo.version': FUSE_OPERATIONAL_SLO_VERSION,
          'fuse.diagnosis.status': status,
        });
      }
    } catch (error) {
      this.dependencies.log.error(
        { error: error instanceof Error ? error.message : String(error) },
        'diagnosis queue metrics refresh failed',
      );
    }
  }

  private retryDelay(attempt: number): number {
    const exponential = Math.min(
      this.config.backoffMaxMs,
      this.config.backoffBaseMs * 2 ** Math.max(0, attempt - 1),
    );
    const jitter = 1 + (this.random() * 2 - 1) * this.config.backoffJitterRatio;
    return Math.max(0, Math.round(exponential * jitter));
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.polling = this.runOnce()
        .catch((error) => {
          this.dependencies.log.error(
            { error: error instanceof Error ? error.message : String(error) },
            'diagnosis dispatcher poll failed',
          );
        })
        .then(() => undefined)
        .finally(() => {
          this.polling = undefined;
          this.schedule(this.config.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }
}
