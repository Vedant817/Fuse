import { describe, expect, it } from 'vitest';
import { withStoreErrors } from './pool.js';
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
