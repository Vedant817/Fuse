import pg from 'pg';
import { BreakerStore, PreflightStore } from '@fuse/breaker-store';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function assertSchemaReady(pool: pg.Pool): Promise<void> {
  try {
    await pool.query('SELECT 1 FROM breaker_state LIMIT 1');
  } catch (err) {
    throw new Error(
      'breaker_state table is missing. Run migrations first: ' +
        '`pnpm --filter @fuse/breaker-store run migrate` (or `infra/reset.sh` for a full local reset).',
      { cause: err },
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  await assertSchemaReady(pool);

  const store = new BreakerStore(pool);
  const preflightStore = new PreflightStore(pool);
  const app = await buildApp({ store, preflightStore, pool, config });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error('control-plane failed to start:', err);
  process.exitCode = 1;
});
