import type { PreflightStore } from '@fuse/breaker-store';
import type { PreflightEvaluatorConfig } from '@fuse/preflight';
import {
  FUSE_OPERATIONAL_SLO_VERSION,
  getPreflightSweepCounter,
  getPreflightSweepHealthGauge,
} from '@fuse/otel';
import { recordPreflightOutcome } from './preflight.js';

interface PreflightSweeperLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface PreflightSweeperOptions {
  store: PreflightStore;
  config: PreflightEvaluatorConfig;
  log: PreflightSweeperLogger;
  intervalMs?: number;
  batchSize?: number;
}

/** Bounded, non-overlapping DB-backed revalidation for scopes that nobody is
 * polling. Multiple control-plane replicas are safe: aggregate row locks make
 * alert transitions idempotent, while each pass remains batch bounded. */
export class PreflightSweeper {
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<number> | undefined;

  constructor(private readonly options: PreflightSweeperOptions) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.batchSize = options.batchSize ?? 100;
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 1_000) {
      throw new RangeError('Preflight sweep interval must be at least 1000ms');
    }
    if (
      !Number.isInteger(this.batchSize) ||
      this.batchSize < 1 ||
      this.batchSize > 1_000
    ) {
      throw new RangeError('Preflight sweep batch size must be from 1 to 1000');
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref?.();
    void this.runOnce();
  }

  runOnce(): Promise<number> {
    if (this.inFlight) return this.inFlight;
    const sweep = this.options.store
      .sweepStale(this.options.config, this.batchSize)
      .then((outcomes) => {
        for (const outcome of outcomes) {
          recordPreflightOutcome(outcome.result.scope, outcome, 'sweep');
        }
        getPreflightSweepCounter().add(1, {
          'fuse.slo.version': FUSE_OPERATIONAL_SLO_VERSION,
          'fuse.outcome': 'success',
        });
        getPreflightSweepHealthGauge().record(1, {
          'fuse.slo.version': FUSE_OPERATIONAL_SLO_VERSION,
        });
        return outcomes.length;
      })
      .catch((error: unknown) => {
        getPreflightSweepCounter().add(1, {
          'fuse.slo.version': FUSE_OPERATIONAL_SLO_VERSION,
          'fuse.outcome': 'failure',
        });
        getPreflightSweepHealthGauge().record(0, {
          'fuse.slo.version': FUSE_OPERATIONAL_SLO_VERSION,
        });
        this.options.log.error({ error }, 'Preflight revalidation sweep failed');
        return 0;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    this.inFlight = sweep;
    return sweep;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }
}
