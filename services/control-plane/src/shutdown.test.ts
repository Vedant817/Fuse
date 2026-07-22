import { describe, expect, it, vi } from 'vitest';
import { createShutdownHandler } from './shutdown.js';

describe('createShutdownHandler', () => {
  it('runs cleanup and exit exactly once when duplicate signals arrive', async () => {
    let releaseApp!: () => void;
    const appClosed = new Promise<void>((resolve) => {
      releaseApp = resolve;
    });
    const closeApp = vi.fn(() => appClosed);
    const closePool = vi.fn(async () => undefined);
    const shutdownOtel = vi.fn(async () => undefined);
    const exit = vi.fn();
    const log = { info: vi.fn(), error: vi.fn() };
    const shutdown = createShutdownHandler({
      log,
      closeApp,
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
    expect(shutdownOtel).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.info).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('attempts every cleanup step and exits nonzero when one fails', async () => {
    const closeApp = vi.fn(async () => undefined);
    const closePool = vi.fn(async () => {
      throw new Error('pool close failed');
    });
    const shutdownOtel = vi.fn(async () => undefined);
    const exit = vi.fn();
    const log = { info: vi.fn(), error: vi.fn() };
    const shutdown = createShutdownHandler({
      log,
      closeApp,
      closePool,
      shutdownOtel,
      exit,
    });

    await shutdown('SIGTERM');

    expect(closeApp).toHaveBeenCalledOnce();
    expect(closePool).toHaveBeenCalledOnce();
    expect(shutdownOtel).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
