import { z } from 'zod';
import { ScopeSchema } from './scope.js';

/**
 * Versioned breaker policy. `version` is carried through every trip/audit
 * event so a running incident can always be traced back to the policy that
 * produced it, even if the policy file changes mid-incident.
 */
export const OutageModeSchema = z.enum(['fail-open', 'fail-closed']);
export type OutageMode = z.infer<typeof OutageModeSchema>;

/**
 * Detector-specific config, one block per detector type (task.md §4.1:
 * "Keep detector configuration in the versioned policy file"). Every
 * default here MUST match its counterpart `DEFAULT_*_CONFIG` constant in
 * `@fuse/detectors` exactly — `packages/detectors/src/policy-defaults.test.ts`
 * asserts this so the two independently-defined sources of truth can't
 * silently drift apart. `@fuse/detectors` deliberately does not import from
 * `@fuse/contracts` for its own config type (it only depends on `@fuse/
 * contracts` for `DetectorResult`/`Scope`), so these are parallel
 * definitions by design, not a single shared source — the alternative
 * (detectors importing its own tunable config shape from contracts) would
 * make the pure-function detector library depend on the policy/wire-format
 * package for values that are really just its own internal algorithm
 * parameters.
 */
export const LoopSignatureDetectorConfigSchema = z.object({
  windowSize: z.number().int().positive().default(40),
  minRepetitions: z.number().int().positive().default(3),
  maxCycleLength: z.number().int().positive().default(4),
});
export type LoopSignatureDetectorConfig = z.infer<
  typeof LoopSignatureDetectorConfigSchema
>;

export const ContextBloatDetectorConfigSchema = z.object({
  absoluteCeilingTokens: z.number().int().positive().default(100_000),
  minConsecutiveGrowthSteps: z.number().int().positive().default(5),
  minGrowthRatio: z.number().positive().default(3),
  minInputTokensForGrowthSignal: z.number().int().nonnegative().default(8_000),
  minStepsRequired: z.number().int().positive().default(4),
});
export type ContextBloatDetectorConfig = z.infer<typeof ContextBloatDetectorConfigSchema>;

export const CostVelocityDetectorConfigSchema = z.object({
  windowMs: z.number().int().positive().default(60_000),
  thresholdUsdPerWindow: z.number().positive().default(0.5),
  minCallsForSignal: z.number().int().positive().default(3),
  minElapsedMsForSignal: z.number().int().nonnegative().default(2_000),
});
export type CostVelocityDetectorConfig = z.infer<typeof CostVelocityDetectorConfigSchema>;

export const DetectorsConfigSchema = z
  .object({
    'loop-signature': LoopSignatureDetectorConfigSchema.default({}),
    'context-bloat': ContextBloatDetectorConfigSchema.default({}),
    'cost-velocity': CostVelocityDetectorConfigSchema.default({}),
  })
  .partial()
  .strict();
export type DetectorsConfig = z.infer<typeof DetectorsConfigSchema>;

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
  detectors: DetectorsConfigSchema.default({}),
  notificationRoutes: z.array(z.enum(['slack'])).default([]),
});
export type Policy = z.infer<typeof PolicySchema>;

/** Explicit, clearly-named demo/test policy — never the production default.
 * Trips on a hardcoded call-count threshold with no detector evaluation,
 * to de-risk and prove the enforcement path before real detectors exist. */
export const DEMO_HARDCODED_THRESHOLD_POLICY_VERSION = 'demo-hardcoded-threshold-v1';
