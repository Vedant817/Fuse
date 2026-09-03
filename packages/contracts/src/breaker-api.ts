import { z } from 'zod';
import { ScopeSchema } from './scope.js';
import { ActorSchema, BreakerRecordSchema } from './breaker-state.js';
import { BreakerAuditEventSchema } from './audit.js';

const IdempotencyKeySchema = z.string().min(1).max(200);
const ExpectedEpochSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const PermitRequestSchema = z.object({
  scope: ScopeSchema,
  correlationId: z.string().min(1).max(200),
});
export type PermitRequest = z.infer<typeof PermitRequestSchema>;

/** Distinct from `BreakerStateSchema`: this is what a permit *response* may
 * report, which includes `unknown` for the honest case where the store was
 * unreachable and the real state could not be read. `BreakerStateSchema`
 * (used for stored/transitioned records) never has an `unknown` value —
 * every persisted record has a definite state. */
export const PermitStateSchema = z.enum(['armed', 'tripped', 'disabled', 'unknown']);
export type PermitState = z.infer<typeof PermitStateSchema>;

export const PermitResponseSchema = z.object({
  allowed: z.boolean(),
  state: PermitStateSchema,
  reason: z.string().max(2000),
  epoch: z.number().int(),
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
  /** Optional for explicit force-trip callers. Direct detector and SigNoz
   * fallback trips supply the source epoch before reaching the store. */
  expectedEpoch: ExpectedEpochSchema.optional(),
});
export type TripRequest = z.infer<typeof TripRequestSchema>;

export const ResumeRequestSchema = z.object({
  scope: ScopeSchema,
  reason: z.string().min(1).max(2000),
  actor: ActorSchema,
  correlationId: z.string().min(1).max(200),
  idempotencyKey: IdempotencyKeySchema,
  expectedEpoch: ExpectedEpochSchema,
});
export type ResumeRequest = z.infer<typeof ResumeRequestSchema>;

export const DisableRequestSchema = z.object({
  scope: ScopeSchema,
  reason: z.string().min(1).max(2000),
  actor: ActorSchema,
  correlationId: z.string().min(1).max(200),
  idempotencyKey: IdempotencyKeySchema,
  expectedEpoch: ExpectedEpochSchema,
});
export type DisableRequest = z.infer<typeof DisableRequestSchema>;

export const EnableRequestSchema = z.object({
  scope: ScopeSchema,
  reason: z.string().min(1).max(2000),
  actor: ActorSchema,
  correlationId: z.string().min(1).max(200),
  idempotencyKey: IdempotencyKeySchema,
  expectedEpoch: ExpectedEpochSchema,
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
