import pg from 'pg';
import { StoreUnavailableError } from './errors.js';

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ECONNRESET',
]);

export interface CreatePoolOptions {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  statementTimeoutMillis?: number;
}

export function createPool(opts: CreatePoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 2_000,
    statement_timeout: opts.statementTimeoutMillis ?? 5_000,
  });
  // Idle-client errors (e.g. the server closing a pooled connection) must
  // not crash the process; surface them as ordinary pool exhaustion on the
  // next query instead.
  pool.on('error', (err) => {
    console.error('unexpected error on idle Postgres client', err);
  });
  return pool;
}

/** Wraps a store operation so any connection-level failure becomes a typed
 * `StoreUnavailableError`, letting callers distinguish "store is down" from
 * "the request was invalid" or another application-level error. */
export async function withStoreErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code && CONNECTION_ERROR_CODES.has(code)) {
      throw new StoreUnavailableError(`Postgres connection failed (${code})`, err);
    }
    throw err;
  }
}
