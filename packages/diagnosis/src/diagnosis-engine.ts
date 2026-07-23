import type { DetectorResult, DiagnosisResult } from '@fuse/contracts';
import type { EvidenceBundle } from './evidence.js';

/**
 * Per-detector deterministic mapping (task.md §7.2: "Map loop -> cumulative
 * ceiling/progress guard, context bloat -> history deduplication/
 * compaction/caching, velocity -> workload/release/model-price
 * investigation"). Plain data, not a template engine or an LLM prompt —
 * every recommendation here is a fixed string chosen ahead of time, so
 * there is nothing to hallucinate.
 */
const DETECTOR_KNOWLEDGE: Record<
  DetectorResult['detector'],
  { hypothesisTemplate: (r: DetectorResult) => string; recommendedFix: string }
> = {
  'loop-signature': {
    hypothesisTemplate: (r) =>
      `A repeating step-shape cycle was detected (score ${r.score}, threshold ${r.threshold}), consistent with a progress-free Analyzer/Verifier-style loop that has no concept of its own cumulative cost.`,
    recommendedFix:
      'Add a cumulative per-session/task cost or step ceiling, and a progress/novelty check that breaks the loop when the last few steps are canonically identical (not just bounded iteration).',
  },
  'context-bloat': {
    hypothesisTemplate: (r) =>
      `Input token count grew past the configured safeguard (score ${r.score}, threshold ${r.threshold}), consistent with a conversation history that is never compacted, deduplicated, or cached.`,
    recommendedFix:
      'Add history compaction/summarization, prompt caching for the stable prefix, or a hard context-size ceiling with a truncation/summarization fallback.',
  },
  'cost-velocity': {
    hypothesisTemplate: (r) =>
      `Estimated spend in the trailing window crossed the configured threshold (score $${r.score.toFixed(4)}, threshold $${r.threshold.toFixed(4)}), consistent with an abnormal call rate, a retry storm, or a pricing/model change.`,
    recommendedFix:
      'Investigate recent workload/traffic changes, provider pricing or model-version changes, and retry/backoff configuration; a session-level cost ceiling is a useful backstop but not a substitute for finding the root cause.',
  },
};

/**
 * Builds a deterministic diagnosis from a fired detector result and
 * (optionally unavailable) SigNoz evidence — task.md §7.2. Never throws:
 * a missing/degraded evidence bundle produces an honestly-labeled lower-
 * confidence diagnosis, not a crash (the breaker has already tripped by
 * the time this runs, so diagnosis failure must never look like
 * enforcement failure).
 */
export function buildDiagnosis(
  detectorResult: DetectorResult,
  evidence: EvidenceBundle,
  now: Date = new Date(),
): DiagnosisResult {
  const knowledge = DETECTOR_KNOWLEDGE[detectorResult.detector];
  const limitations: string[] = [
    'This diagnosis is generated deterministically from detector evidence and a bounded trace sample — it is a hypothesis, not a certainty.',
    `Evidence is capped at ${evidence.spans.length} span(s) from the incident window; the true root cause may involve steps outside this sample.`,
  ];
  if (!evidence.available) {
    limitations.push(
      `SigNoz trace evidence was unavailable (${evidence.reason ?? 'unknown reason'}) — this diagnosis relies on the detector's own result only.`,
    );
  }

  const supportingEvidence = [...detectorResult.evidence];
  if (evidence.available && evidence.spans.length > 0) {
    supportingEvidence.push(
      `${evidence.spans.length} matching span(s) found in SigNoz for this scope in the incident window (query: ${evidence.queryFilter}).`,
    );
  } else if (evidence.available) {
    supportingEvidence.push(
      `No matching spans were found in SigNoz for this scope in the incident window (query: ${evidence.queryFilter}) — the detector fired on telemetry that may have since aged out of the query window.`,
    );
  }

  return {
    detector: detectorResult.detector,
    detectorVersion: detectorResult.detectorVersion,
    scope: detectorResult.scope,
    generatedAt: now.toISOString(),
    evidenceAvailable: evidence.available,
    ...(evidence.available
      ? {}
      : { evidenceUnavailableReason: evidence.reason ?? 'unknown' }),
    hypothesis: knowledge.hypothesisTemplate(detectorResult),
    // Lower confidence when we can't back the detector's own result with
    // real trace evidence — an honest signal, not a cosmetic one.
    confidence: evidence.available && evidence.spans.length > 0 ? 'high' : 'medium',
    supportingEvidence,
    limitations,
    immediateContainment: `The breaker for ${detectorResult.scope.tenant}/${detectorResult.scope.environment}/${detectorResult.scope.agentId} has already tripped — no further model calls will be dispatched for this scope until an authorized resume.`,
    recommendedFix: knowledge.recommendedFix,
    evidenceLinks: evidence.spans
      .slice(0, 10)
      .map((s) => ({ traceId: s.traceId, spanId: s.spanId, webUrl: s.webUrl })),
  };
}
