import { z } from 'zod';
import { ScopeSchema } from './scope.js';
import { ActorSchema, BreakerRecordSchema, BreakerStateSchema } from './breaker-state.js';
import { BreakerAuditEventSchema } from './audit.js';

const IdempotencyKeySchema = z.string().min(1).max(200);

export const PermitRequestSchema = z.object({
  scope: ScopeSchema,
  correlationId: z.string().min(1).max(200),
});
export type PermitRequest = z.infer<typeof PermitRequestSchema>;

export const PermitResponseSchema = z.object({
  allowed: z.boolean(),
  state: BreakerStateSchema,
  reason: z.string().max(2000),
  epoch: z.number().int().nonnegative(),
  /** Set when the decision was made under a degraded control-plane/store
   * condition rather than a clean read of current state. Never omitted
   * silently — the SDK and any dashboard must be able to show this. */
  degraded: z.boolean(),
  correlationId: z.string().min(1),
});
export type PermitResponse = z.infer<typeof PermitResponseSchema>;

export const TripRequestSchema = z.object({
  scope: ScopeSchema,
  reason: z.string().min(1).max(2000),
  policyVersion: z.string().min(1),
  cooldownSeconds: z.number().int().nonnegative(),
  actor: ActorSchema,
  correlationId: z.string().min(1).max(200),
  idempotencyKey: IdempotencyKeySchema,
  /** Optional: reject the trip if the caller's view of the epoch is stale.
   * Alert-driven trips normally omit this and apply blindly to whatever the
   * current state is; operator tooling may set it for optimistic locking. */
  expectedEpoch: z.number().int().nonnegative().optional(),
});
export type TripRequest = z.infer<typeof TripRequestSchema>;

export const ResumeRequestSchema = z.object({
  scope: ScopeSchema,
  reason: z.string().min(1).max(2000),
  actor: ActorSchema,
  correlationId: z.string().min(1).max(200),
  idempotencyKey: IdempotencyKeySchema,
  expectedEpoch: z.number().int().nonnegative().optional(),
});
export type ResumeRequest = z.infer<typeof ResumeRequestSchema>;

export const DisableRequestSchema = z.object({
  scope: ScopeSchema,
  reason: z.string().min(1).max(2000),
  actor: ActorSchema,
  correlationId: z.string().min(1).max(200),
  idempotencyKey: IdempotencyKeySchema,
});
export type DisableRequest = z.infer<typeof DisableRequestSchema>;

export const EnableRequestSchema = z.object({
  scope: ScopeSchema,
  reason: z.string().min(1).max(2000),
  actor: ActorSchema,
  correlationId: z.string().min(1).max(200),
  idempotencyKey: IdempotencyKeySchema,
});
export type EnableRequest = z.infer<typeof EnableRequestSchema>;

export const TransitionResponseSchema = z.object({
  record: BreakerRecordSchema,
  auditEvent: BreakerAuditEventSchema,
  /** true if this call did not change state (already in the target state,
   * or resolved via idempotency-key replay). */
  noop: z.boolean(),
});
export type TransitionResponse = z.infer<typeof TransitionResponseSchema>;

export const StatusResponseSchema = z.object({
  record: BreakerRecordSchema,
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;
