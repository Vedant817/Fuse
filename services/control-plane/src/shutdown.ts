interface ShutdownLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface ShutdownDependencies {
  log: ShutdownLogger;
  closeApp: () => Promise<unknown>;
  closePool: () => Promise<unknown>;
  shutdownOtel: () => Promise<unknown>;
  exit: (code: number) => void;
}

/** Creates a signal handler whose cleanup sequence can run at most once. */
export function createShutdownHandler(
  dependencies: ShutdownDependencies,
): (signal: string) => Promise<void> {
  let inFlight: Promise<void> | undefined;

  return (signal: string): Promise<void> => {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      dependencies.log.info({ signal }, 'shutting down');
      const failures: Array<{ step: string; error: unknown }> = [];
      const steps: Array<[string, () => Promise<unknown>]> = [
        ['app', dependencies.closeApp],
        ['pool', dependencies.closePool],
        ['otel', dependencies.shutdownOtel],
      ];

      for (const [step, close] of steps) {
        try {
          await close();
        } catch (error) {
          failures.push({ step, error });
        }
      }

      if (failures.length > 0) {
        dependencies.log.error({ signal, failures }, 'shutdown failed');
        dependencies.exit(1);
        return;
      }
      dependencies.exit(0);
    })();

    return inFlight;
  };
}
