/** Thrown when the store cannot be reached at all (connection refused, DNS
 * failure, timeout). Distinct from a normal query error so callers (the
 * control plane) can implement their configured fail-open/fail-closed
 * outage behavior specifically for this case. */
export class StoreUnavailableError extends Error {
  readonly cause_?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'StoreUnavailableError';
    this.cause_ = cause;
  }
}

/** Thrown when an idempotency key is reused with a materially different
 * request body — this is a caller bug or a forged replay, not a legitimate
 * duplicate delivery, so it must not silently reuse the old response. */
export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

/** Thrown when the CAS retry loop exhausts its bounded attempt count under
 * sustained write contention on one scope. Distinct from
 * `StoreUnavailableError` — the store is reachable, just heavily contended
 * — so callers can surface a specific "retry later" response instead of a
 * generic internal error. */
export class CasContentionExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CasContentionExhaustedError';
  }
}

/** The requested scope has not been explicitly registered by an operator.
 * This is a caller/onboarding error, not a store outage. No state row,
 * detector buffer, or metric series may be created for this scope. */
export class UnknownScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownScopeError';
  }
}

/** Registration would exceed the configured per-tenant scope ceiling.
 * The limit check and insert are serialized in Postgres, so concurrent
 * registrations cannot race past it. */
export class ScopeCapacityExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeCapacityExceededError';
  }
}
