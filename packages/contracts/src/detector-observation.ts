import { z } from 'zod';
import { DetectorResultSchema } from './detector.js';
import { ScopeSchema } from './scope.js';

export const MAX_STEP_OBSERVATIONS_PER_REQUEST = 200;
export const MAX_DETECTOR_EXECUTION_ID_LENGTH = 128;

export const DetectorExecutionIdSchema = z
  .string()
  .min(1)
  .max(MAX_DETECTOR_EXECUTION_ID_LENGTH)
  .regex(/^[A-Za-z0-9._:-]+$/);
export type DetectorExecutionId = z.infer<typeof DetectorExecutionIdSchema>;

export const DetectorPricingStatusSchema = z.enum(['available', 'unavailable']);
export type DetectorPricingStatus = z.infer<typeof DetectorPricingStatusSchema>;

/**
 * The wire shape for one reported step, mirroring `@fuse/detectors`'
 * `StepRecord` field for field (task.md §4: the detector-runner evaluates
 * real telemetry, not synthetic fixtures). Kept independent of
 * `@fuse/detectors`' own type — the same reasoning as `DetectorResultSchema`
 * already living in this package while the pure detection functions live
 * in `@fuse/detectors`: this is the versioned wire contract, detectors is
 * the algorithm.
 */
const StepObservationBaseSchema = z.object({
  executionId: DetectorExecutionIdSchema,
  timestampMs: z.number().int().nonnegative(),
  canonicalShape: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const StepObservationSchema = z.discriminatedUnion('pricingStatus', [
  StepObservationBaseSchema.extend({
    pricingStatus: z.literal('available'),
    estimatedCostUsd: z.number().nonnegative(),
  }),
  StepObservationBaseSchema.extend({
    pricingStatus: z.literal('unavailable'),
    estimatedCostUsd: z.null(),
  }),
]);

/** Truthful external observation shape. An unavailable price is `null`, never
 * a numeric zero that a consumer could mistake for a free provider call. */
export type StepObservationInputWire = z.infer<typeof StepObservationSchema>;

/** Normalized shape consumed by the pure detector algorithms. The pricing
 * status remains authoritative; the numeric normalized value must never be
 * interpreted as cost-velocity coverage when status is unavailable. */
export interface StepObservationWire {
  executionId: DetectorExecutionId;
  timestampMs: number;
  canonicalShape: string;
  inputTokens: number;
  outputTokens: number;
  pricingStatus: DetectorPricingStatus;
  estimatedCostUsd: number;
}

/** A caller (SDK, or any direct integration) reports one or more steps for
 * a scope in a single request — batched the same way Preflight reporting
 * batches spans, so a bursty agent doesn't make one HTTP call per step. */
export const ObserveStepsRequestSchema = z
  .object({
    scope: ScopeSchema,
    steps: z.array(StepObservationSchema).min(1).max(MAX_STEP_OBSERVATIONS_PER_REQUEST),
  })
  .superRefine((request, ctx) => {
    const executionIds = request.steps.map((step) => step.executionId);
    const executionId = executionIds[0];
    if (executionIds.some((candidate) => candidate !== executionId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps'],
        message: 'one detector request may contain observations from only one execution',
      });
    }
  })
  .transform((request) => ({
    ...request,
    // Loop/context detectors do not consume cost. Cost-velocity protection is
    // explicitly degraded for this window when pricingStatus is unavailable.
    // Normalize null only for the numeric detector invocation; pricingStatus
    // remains required and prevents that value from claiming cost coverage.
    steps: request.steps.map((step): StepObservationWire => ({
      ...step,
      estimatedCostUsd: step.estimatedCostUsd ?? 0,
    })),
  }));
export type ObserveStepsRequest = z.infer<typeof ObserveStepsRequestSchema>;

export const DetectorProtectionStatusSchema = z.object({
  detector: z.enum(['loop-signature', 'context-bloat', 'cost-velocity']),
  status: z.enum(['protected', 'degraded']),
  reasonCode: z.enum([
    'healthy',
    'no-observations',
    'pricing-unavailable',
    'reporting-unavailable',
  ]),
  reason: z.string().min(1).max(500),
});
export type DetectorProtectionStatus = z.infer<typeof DetectorProtectionStatusSchema>;

/** The result of evaluating all three detectors against the scope's
 * updated buffer, after processing every step in the request — lets a
 * caller (or a test) see the exact same result the emitted `fuse.detector.
 * score` gauges reflect, without a separate read path. */
export const ObserveStepsResponseSchema = z.object({
  results: z.array(DetectorResultSchema),
  enforcement: z.array(
    z.object({
      detector: DetectorResultSchema.shape.detector,
      outcome: z.enum(['tripped', 'already-tripped', 'breaker-disabled']),
    }),
  ),
});
export type ObserveStepsResponse = z.infer<typeof ObserveStepsResponseSchema>;
