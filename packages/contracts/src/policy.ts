import { z } from 'zod';
import { ScopeSchema } from './scope.js';

/**
 * Versioned breaker policy. `version` is carried through every trip/audit
 * event so a running incident can always be traced back to the policy that
 * produced it, even if the policy file changes mid-incident.
 *
 * This is intentionally minimal for the breaker-first vertical slice —
 * detector-specific configuration (loop-signature/context-bloat/cost-velocity
 * thresholds) is added in a later slice without breaking this schema, since
 * `detectors` is an open-ended additive record.
 */
export const OutageModeSchema = z.enum(['fail-open', 'fail-closed']);
export type OutageMode = z.infer<typeof OutageModeSchema>;

export const PolicySchema = z.object({
  policyVersion: z.string().min(1),
  scope: ScopeSchema.partial({ agentId: true }),
  /** Seconds a tripped breaker must stay tripped before a *policy-driven*
   * (non-manual) resume may succeed. Manual resume may explicitly override
   * this with an authorized reason; nothing resumes on a bare timer. */
  cooldownSeconds: z.number().int().nonnegative().default(300),
  /** Behavior when the state store cannot be reached during a permit check. */
  storeOutageMode: OutageModeSchema.default('fail-closed'),
  /** Behavior for the SDK when the control plane itself is unreachable. */
  controlPlaneOutageMode: OutageModeSchema.default('fail-closed'),
  detectors: z.record(z.string(), z.unknown()).default({}),
  notificationRoutes: z.array(z.string()).default([]),
});
export type Policy = z.infer<typeof PolicySchema>;

/** Explicit, clearly-named demo/test policy — never the production default.
 * Trips on a hardcoded call-count threshold with no detector evaluation,
 * to de-risk and prove the enforcement path before real detectors exist. */
export const DEMO_HARDCODED_THRESHOLD_POLICY_VERSION = 'demo-hardcoded-threshold-v1';
