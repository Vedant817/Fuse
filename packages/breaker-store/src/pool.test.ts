import { describe, expect, it } from 'vitest';
import { createPool, withStoreErrors } from './pool.js';
import { StoreUnavailableError } from './errors.js';

function errorWithCode(code: string): Error {
  const err = new Error(`simulated (${code})`);
  (err as { code?: string }).code = code;
  return err;
}

describe('withStoreErrors', () => {
  it('returns the result unchanged on success', async () => {
    await expect(withStoreErrors(async () => 'ok')).resolves.toBe('ok');
  });

  it('rethrows an error with no .code property untouched', async () => {
    const plain = new Error('not a connection issue');
    await expect(withStoreErrors(() => Promise.reject(plain))).rejects.toBe(plain);
  });

  it('rethrows an unrecognized .code untouched', async () => {
    const err = errorWithCode('23505'); // unique_violation — an app-level error, not connection loss
    await expect(withStoreErrors(() => Promise.reject(err))).rejects.toBe(err);
  });

  describe('wraps Node/TCP-level connection errors as StoreUnavailableError', () => {
    for (const code of [
      'ECONNREFUSED',
      'ENOTFOUND',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ECONNRESET',
    ]) {
      it(code, async () => {
        await expect(
          withStoreErrors(() => Promise.reject(errorWithCode(code))),
        ).rejects.toThrow(StoreUnavailableError);
      });
    }
  });

  describe('wraps Postgres SQLSTATE class-08 (connection exception) codes as StoreUnavailableError', () => {
    for (const code of ['08000', '08001', '08003', '08004', '08006', '08007']) {
      it(code, async () => {
        await expect(
          withStoreErrors(() => Promise.reject(errorWithCode(code))),
        ).rejects.toThrow(StoreUnavailableError);
      });
    }
  });

  describe('wraps Postgres server-shutdown SQLSTATE codes as StoreUnavailableError', () => {
    for (const code of ['57P01', '57P02', '57P03']) {
      it(code, async () => {
        await expect(
          withStoreErrors(() => Promise.reject(errorWithCode(code))),
        ).rejects.toThrow(StoreUnavailableError);
      });
    }
  });
});

describe('createPool', () => {
  it('attaches an idle-client "error" listener so it does not crash the process', async () => {
    const pool = createPool({
      connectionString: 'postgres://fuse:fuse@localhost:5432/fuse',
    });
    try {
      expect(pool.listenerCount('error')).toBeGreaterThan(0);
      // Emitting 'error' with zero listeners is what crashes a Node
      // process; asserting a listener exists confirms an idle-client
      // failure surfaces as a logged error, not an unhandled crash.
      expect(() =>
        pool.emit('error', new Error('simulated idle-client error')),
      ).not.toThrow();
    } finally {
      await pool.end();
    }
  });

  it('applies documented defaults when no overrides are given', async () => {
    const pool = createPool({
      connectionString: 'postgres://fuse:fuse@localhost:5432/fuse',
    });
    try {
      expect(pool.options.max).toBe(10);
      expect(pool.options.idleTimeoutMillis).toBe(30_000);
      expect(pool.options.connectionTimeoutMillis).toBe(2_000);
      expect(pool.options.statement_timeout).toBe(5_000);
    } finally {
      await pool.end();
    }
  });

  it('lets a caller override every tunable', async () => {
    const pool = createPool({
      connectionString: 'postgres://fuse:fuse@localhost:5432/fuse',
      max: 3,
      idleTimeoutMillis: 1_000,
      connectionTimeoutMillis: 500,
      statementTimeoutMillis: 250,
    });
    try {
      expect(pool.options.max).toBe(3);
      expect(pool.options.idleTimeoutMillis).toBe(1_000);
      expect(pool.options.connectionTimeoutMillis).toBe(500);
      expect(pool.options.statement_timeout).toBe(250);
    } finally {
      await pool.end();
    }
  });
});
