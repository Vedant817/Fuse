import { z } from 'zod';
import { ActorSchema, BreakerRecordSchema } from './breaker-state.js';
import { ScopeSchema } from './scope.js';

export const RegisterScopeRequestSchema = z.object({
  scope: ScopeSchema,
  policyVersion: z.string().min(1).max(200),
  actor: ActorSchema,
  reason: z.string().min(1).max(2000),
  correlationId: z.string().min(1).max(200),
});
export type RegisterScopeRequest = z.infer<typeof RegisterScopeRequestSchema>;

export const ScopeRegistrationSchema = z.object({
  scope: ScopeSchema,
  policyVersion: z.string().min(1).max(200),
  registeredAt: z.string().datetime(),
  registeredBy: ActorSchema,
  reason: z.string().min(1).max(2000),
});
export type ScopeRegistration = z.infer<typeof ScopeRegistrationSchema>;

export const RegisterScopeResponseSchema = z.object({
  registration: ScopeRegistrationSchema,
  breaker: BreakerRecordSchema,
  /** `false` means this exact scope was already registered. The original
   * registration metadata is returned; repeated registration never rewrites
   * ownership/audit evidence or consumes another capacity slot. */
  created: z.boolean(),
});
export type RegisterScopeResponse = z.infer<typeof RegisterScopeResponseSchema>;
