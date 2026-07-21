import pg from 'pg';
import { StoreUnavailableError } from './errors.js';

const CONNECTION_ERROR_CODES = new Set([
  // Node/TCP-level: the connection attempt itself never reached Postgres.
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ECONNRESET',
  // Postgres SQLSTATE class 08 (Connection Exception): node-postgres
  // surfaces these on the same `.code` property as the errno codes above,
  // but they mean the server itself rejected or dropped an established
  // connection (not a Node-level networking failure) — equally "the store
  // cannot be reached," so they must be classified the same way or an
  // in-flight Postgres restart/failover would surface as a generic
  // internal error instead of the documented store-outage behavior.
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
  '08007', // transaction_resolution_unknown
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
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
