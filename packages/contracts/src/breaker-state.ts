import { z } from 'zod';
import { ScopeSchema } from './scope.js';

/**
 * `armed`     — normal operation; permits are granted.
 * `tripped`   — enforcement engaged; permits are denied until resume.
 * `disabled`  — operator has turned enforcement off entirely for this scope;
 *               permits are always granted regardless of any trip attempt.
 *               This is distinct from Preflight's telemetry-health
 *               protected/degraded/blind/disabled states (see the Preflight
 *               slice) — this enum describes *enforcement* state only.
 */
export const BreakerStateSchema = z.enum(['armed', 'tripped', 'disabled']);
export type BreakerState = z.infer<typeof BreakerStateSchema>;

export const ActorTypeSchema = z.enum(['system', 'policy', 'manual']);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const ActorSchema = z.object({
  type: ActorTypeSchema,
  id: z.string().min(1).max(256),
});
export type Actor = z.infer<typeof ActorSchema>;

export const BreakerRecordSchema = z.object({
  scope: ScopeSchema,
  state: BreakerStateSchema,
  epoch: z.number().int().nonnegative(),
  reason: z.string().max(2000),
  policyVersion: z.string().min(1),
  cooldownUntil: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  updatedBy: ActorSchema,
});
export type BreakerRecord = z.infer<typeof BreakerRecordSchema>;
