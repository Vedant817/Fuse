import { z } from 'zod';
import { DetectorResultSchema } from './detector.js';
import { ScopeSchema } from './scope.js';

/**
 * The wire shape for one reported step, mirroring `@fuse/detectors`'
 * `StepRecord` field for field (task.md §4: the detector-runner evaluates
 * real telemetry, not synthetic fixtures). Kept independent of
 * `@fuse/detectors`' own type — the same reasoning as `DetectorResultSchema`
 * already living in this package while the pure detection functions live
 * in `@fuse/detectors`: this is the versioned wire contract, detectors is
 * the algorithm.
 */
export const StepObservationSchema = z.object({
  timestampMs: z.number().int().nonnegative(),
  canonicalShape: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
});
export type StepObservationWire = z.infer<typeof StepObservationSchema>;

/** A caller (SDK, or any direct integration) reports one or more steps for
 * a scope in a single request — batched the same way Preflight reporting
 * batches spans, so a bursty agent doesn't make one HTTP call per step. */
export const ObserveStepsRequestSchema = z.object({
  scope: ScopeSchema,
  steps: z.array(StepObservationSchema).min(1).max(200),
});
export type ObserveStepsRequest = z.infer<typeof ObserveStepsRequestSchema>;

/** The result of evaluating all three detectors against the scope's
 * updated buffer, after processing every step in the request — lets a
 * caller (or a test) see the exact same result the emitted `fuse.detector.
 * score` gauges reflect, without a separate read path. */
export const ObserveStepsResponseSchema = z.object({
  results: z.array(DetectorResultSchema),
});
export type ObserveStepsResponse = z.infer<typeof ObserveStepsResponseSchema>;
