import {
  bootstrapOtel,
  type BootstrapOtelOptions,
  type FuseOtelHandle,
  type ScopeTraceExportResult,
} from '@fuse/otel';
import type { Scope } from '@fuse/contracts';
import { FuseGuard } from './guard.js';

export type FuseOtelRuntimeOptions = Omit<
  BootstrapOtelOptions,
  'onTraceExportResult' | 'traceExportSourceInstanceId'
>;

function scopeKey(scope: Scope): string {
  return `${scope.tenant}\u0000${scope.environment}\u0000${scope.agentId}`;
}

/**
 * Supported OTel/Preflight integration. One runtime owns one Node OTel SDK and
 * routes each real exporter result to exactly one guard registered for that
 * scope. `shutdown()` flushes OTel first, drains resulting Preflight reports,
 * and then stops every guard reporter.
 */
export class FuseOtelRuntime {
  private readonly guards = new Map<string, FuseGuard>();
  private readonly otel: FuseOtelHandle;
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: FuseOtelRuntimeOptions) {
    this.otel = bootstrapOtel({
      ...options,
      onTraceExportResult: (result) => this.routeExportResult(result),
    });
  }

  registerGuard(guard: FuseGuard): FuseGuard {
    if (this.shutdownPromise) {
      throw new Error('cannot register a guard after FuseOtelRuntime shutdown began');
    }
    const key = scopeKey(guard.scope);
    if (this.guards.has(key)) {
      throw new Error(
        `a FuseGuard is already registered for ${guard.scope.tenant}/${guard.scope.environment}/${guard.scope.agentId}`,
      );
    }
    this.guards.set(key, guard);
    return guard;
  }

  /** Forces all OTel signals out, then drains resulting Preflight reports. */
  async forceFlush(): Promise<void> {
    try {
      await this.otel.forceFlush();
    } finally {
      await Promise.all(
        [...this.guards.values()].map((guard) => guard.flushPreflightTelemetry()),
      );
    }
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownOnce();
    return this.shutdownPromise;
  }

  private async routeExportResult(result: ScopeTraceExportResult): Promise<void> {
    await this.guards.get(scopeKey(result.scope))?.recordTraceExportResult(result);
  }

  private async shutdownOnce(): Promise<void> {
    try {
      await this.otel.shutdown();
    } finally {
      await Promise.all(
        [...this.guards.values()].map((guard) => guard.shutdownPreflightReporting()),
      );
      this.guards.clear();
    }
  }
}

export function bootstrapFuseOtel(options: FuseOtelRuntimeOptions): FuseOtelRuntime {
  return new FuseOtelRuntime(options);
}
