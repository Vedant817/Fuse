import { z } from 'zod';
import { ScopeSchema } from './scope.js';
import { ActorSchema, BreakerStateSchema } from './breaker-state.js';

/**
 * One row per committed breaker transition. Append-only. This is the
 * evidence trail required by AGENTS.md for every state-changing decision:
 * who/what/why/when.
 */
export const BreakerAuditEventSchema = z.object({
  id: z.string().uuid(),
  scope: ScopeSchema,
  fromState: BreakerStateSchema,
  toState: BreakerStateSchema,
  epochBefore: z.number().int().nonnegative(),
  epochAfter: z.number().int().nonnegative(),
  actor: ActorSchema,
  reason: z.string().max(2000),
  correlationId: z.string().min(1),
  policyVersion: z.string().min(1),
  /** true when the underlying state did not actually change (e.g. a
   * duplicate trip while already tripped) — still recorded for evidence,
   * but callers can distinguish a no-op from a real transition. */
  noop: z.boolean(),
  createdAt: z.string().datetime(),
});
export type BreakerAuditEvent = z.infer<typeof BreakerAuditEventSchema>;
