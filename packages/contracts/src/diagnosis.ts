import { z } from 'zod';
import { DetectorTypeSchema } from './detector.js';
import { ScopeSchema } from './scope.js';

/**
 * The versioned output of Fuse's diagnosis step (task.md §7.2) — a
 * deterministic, rule-based summary derived from detector evidence, not an
 * LLM's free-text guess. "Optional LLM wording" is explicitly deferred
 * (task.md §7.2: "before adding optional LLM wording"), so every field
 * here is produced by plain code, never a model call — there is no
 * diagnosis-spend budget to bound yet because no model is ever invoked.
 */
export const DiagnosisConfidenceSchema = z.enum(['low', 'medium', 'high']);
export type DiagnosisConfidence = z.infer<typeof DiagnosisConfidenceSchema>;

export const EvidenceLinkSchema = z.object({
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  webUrl: z.string().optional(),
});
export type EvidenceLink = z.infer<typeof EvidenceLinkSchema>;

export const DiagnosisResultSchema = z.object({
  detector: DetectorTypeSchema,
  detectorVersion: z.string().min(1),
  scope: ScopeSchema,
  generatedAt: z.string().datetime(),
  /** Whether real SigNoz evidence (traces) backs this diagnosis, or the
   * hypothesis/recommendation are evidence-based only from the detector's
   * own result (task.md: "diagnosis/Slack outages do not weaken the
   * tripped breaker" — diagnosis must degrade honestly, not silently). */
  evidenceAvailable: z.boolean(),
  evidenceUnavailableReason: z.string().optional(),
  hypothesis: z.string().min(1),
  confidence: DiagnosisConfidenceSchema,
  /** Human-readable evidence references — detector evidence strings plus,
   * when available, a summary of the real spans inspected. Never raw
   * prompt/tool content. */
  supportingEvidence: z.array(z.string()),
  /** What is NOT verified/known — stated explicitly rather than implied
   * away, matching this repo's "no marketing ambiguity" standard. */
  limitations: z.array(z.string()),
  /** What is already true because the breaker already tripped, before any
   * diagnosis ran. */
  immediateContainment: z.string().min(1),
  recommendedFix: z.string().min(1),
  /** Bounded set of evidence links so a human can check every claim in
   * SigNoz directly (task.md §7.1: "preserve evidence links/IDs"). */
  evidenceLinks: z.array(EvidenceLinkSchema).max(10),
});
export type DiagnosisResult = z.infer<typeof DiagnosisResultSchema>;
