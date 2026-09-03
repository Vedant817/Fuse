import { context, metrics, trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FuseGuard } from './guard.js';
import { bootstrapFuseOtel, FuseOtelRuntime } from './otel-runtime.js';

const SCOPE = { tenant: 't1', environment: 'test', agentId: 'agent-1' };

describe('FuseOtelRuntime', () => {
  let runtime: FuseOtelRuntime | undefined;

  afterEach(async () => {
    await runtime?.shutdown().catch(() => {});
    runtime = undefined;
    trace.disable();
    metrics.disable();
    context.disable();
  });

  it('rejects duplicate scope registration and registration after shutdown starts', async () => {
    runtime = bootstrapFuseOtel({
      serviceName: 'sdk-otel-runtime-test',
      serviceVersion: 'test',
      deploymentEnvironment: 'test',
      otlpEndpoint: 'http://127.0.0.1:1',
      metricExportIntervalMillis: 100_000,
    });
    const guard = new FuseGuard({
      scope: SCOPE,
      controlPlaneUrl: 'http://cp',
      apiToken: 'token',
      fetchImpl: vi.fn(),
    });
    runtime.registerGuard(guard);
    expect(() =>
      runtime!.registerGuard(
        new FuseGuard({
          scope: SCOPE,
          controlPlaneUrl: 'http://cp',
          apiToken: 'token',
          fetchImpl: vi.fn(),
        }),
      ),
    ).toThrow(/already registered/);

    const shutdown = runtime.shutdown().catch(() => {});
    expect(() =>
      runtime!.registerGuard(
        new FuseGuard({
          scope: { ...SCOPE, agentId: 'agent-2' },
          controlPlaneUrl: 'http://cp',
          apiToken: 'token',
          fetchImpl: vi.fn(),
        }),
      ),
    ).toThrow(/shutdown began/);
    await shutdown;
  });
});
