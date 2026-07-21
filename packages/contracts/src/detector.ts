import { z } from 'zod';
import { ScopeSchema } from './scope.js';

export const DetectorTypeSchema = z.enum([
  'loop-signature',
  'context-bloat',
  'cost-velocity',
]);
export type DetectorType = z.infer<typeof DetectorTypeSchema>;

/**
 * The contract every detector's output conforms to, regardless of
 * implementation (task.md §4.1). `dedupeKey` lets a caller (the webhook,
 * a future in-process evaluator) collapse repeated firings of the same
 * underlying condition within a window instead of re-alerting on every
 * evaluation tick.
 */
export const DetectorResultSchema = z.object({
  detector: DetectorTypeSchema,
  detectorVersion: z.string().min(1),
  scope: ScopeSchema,
  fired: z.boolean(),
  score: z.number(),
  threshold: z.number(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  /** Human-readable evidence references (e.g. "3 identical step shapes at
   * indices 4,5,6") — never raw prompt/tool content. */
  evidence: z.array(z.string()).default([]),
  dedupeKey: z.string().min(1),
});
export type DetectorResult = z.infer<typeof DetectorResultSchema>;
