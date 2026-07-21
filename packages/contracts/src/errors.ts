import { z } from 'zod';

/**
 * Stable, versioned error codes returned across every external boundary
 * (webhook, operational API, permit endpoint). Codes are additive-only —
 * never remove or repurpose a code once shipped; add new ones instead.
 */
export const FuseErrorCodeSchema = z.enum([
  'invalid_request',
  'unauthenticated',
  'unauthorized',
  'unknown_scope',
  'stale_epoch',
  'idempotency_conflict',
  'invalid_transition',
  'cooldown_active',
  'rate_limited',
  'store_unavailable',
  'internal_error',
]);
export type FuseErrorCode = z.infer<typeof FuseErrorCodeSchema>;

export const FuseErrorSchema = z.object({
  error: FuseErrorCodeSchema,
  message: z.string(),
  correlationId: z.string(),
});
export type FuseError = z.infer<typeof FuseErrorSchema>;

export class FuseHttpError extends Error {
  readonly code: FuseErrorCode;
  readonly httpStatus: number;
  readonly correlationId: string;

  constructor(
    code: FuseErrorCode,
    message: string,
    httpStatus: number,
    correlationId: string,
  ) {
    super(message);
    this.name = 'FuseHttpError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.correlationId = correlationId;
  }

  toBody(): FuseError {
    return { error: this.code, message: this.message, correlationId: this.correlationId };
  }
}

export const HTTP_STATUS_BY_CODE: Record<FuseErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  unauthorized: 403,
  unknown_scope: 404,
  stale_epoch: 409,
  idempotency_conflict: 409,
  invalid_transition: 409,
  cooldown_active: 409,
  rate_limited: 429,
  store_unavailable: 503,
  internal_error: 500,
};
