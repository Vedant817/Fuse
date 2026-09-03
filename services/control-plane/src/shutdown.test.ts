import { describe, expect, it, vi } from 'vitest';
import { createShutdownHandler } from './shutdown.js';

describe('createShutdownHandler', () => {
  it('runs cleanup and exit exactly once when duplicate signals arrive', async () => {
    let releaseApp!: () => void;
    const appClosed = new Promise<void>((resolve) => {
      releaseApp = resolve;
    });
    const closeApp = vi.fn(() => appClosed);
    const stopDiagnosisDispatcher = vi.fn(async () => undefined);
    const closeRateLimitRedis = vi.fn(async () => undefined);
    const closePool = vi.fn(async () => undefined);
    const shutdownOtel = vi.fn(async () => undefined);
    const exit = vi.fn();
    const log = { info: vi.fn(), error: vi.fn() };
    const shutdown = createShutdownHandler({
      log,
      closeApp,
      stopDiagnosisDispatcher,
      closeRateLimitRedis,
      closePool,
      shutdownOtel,
      exit,
    });

    const first = shutdown('SIGINT');
    const duplicate = shutdown('SIGINT');
    expect(duplicate).toBe(first);
    expect(closeApp).toHaveBeenCalledTimes(1);

    releaseApp();
    await Promise.all([first, duplicate]);

    expect(closePool).toHaveBeenCalledTimes(1);
    expect(stopDiagnosisDispatcher).toHaveBeenCalledTimes(1);
    expect(closeRateLimitRedis).toHaveBeenCalledTimes(1);
    expect(shutdownOtel).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.info).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('attempts every cleanup step and exits nonzero when one fails', async () => {
    const closeApp = vi.fn(async () => undefined);
    const stopDiagnosisDispatcher = vi.fn(async () => undefined);
    const closeRateLimitRedis = vi.fn(async () => undefined);
    const closePool = vi.fn(async () => {
      throw new Error('pool close failed');
    });
    const shutdownOtel = vi.fn(async () => undefined);
    const exit = vi.fn();
    const log = { info: vi.fn(), error: vi.fn() };
    const shutdown = createShutdownHandler({
      log,
      closeApp,
      stopDiagnosisDispatcher,
      closeRateLimitRedis,
      closePool,
      shutdownOtel,
      exit,
    });

    await shutdown('SIGTERM');

    expect(closeApp).toHaveBeenCalledOnce();
    expect(closePool).toHaveBeenCalledOnce();
    expect(stopDiagnosisDispatcher).toHaveBeenCalledOnce();
    expect(closeRateLimitRedis).toHaveBeenCalledOnce();
    expect(shutdownOtel).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('drains diagnosis work after HTTP closes and before the database pool closes', async () => {
    const order: string[] = [];
    const shutdown = createShutdownHandler({
      log: { info: vi.fn(), error: vi.fn() },
      closeApp: vi.fn(async () => {
        order.push('app');
      }),
      stopDiagnosisDispatcher: vi.fn(async () => {
        order.push('dispatcher');
      }),
      closeRateLimitRedis: vi.fn(async () => {
        order.push('redis');
      }),
      closePool: vi.fn(async () => {
        order.push('pool');
      }),
      shutdownOtel: vi.fn(async () => {
        order.push('otel');
      }),
      exit: vi.fn(),
    });

    await shutdown('SIGTERM');

    expect(order).toEqual(['app', 'dispatcher', 'redis', 'pool', 'otel']);
  });
});
