/**
 * One observed model-call step, already stripped of volatile bits (round
 * numbers, timestamps, raw token counts embedded in content, request IDs)
 * by the caller before `canonicalShape` is computed — task.md §4.2:
 * "Canonicalize repeatable step/span shapes while excluding volatile IDs,
 * timestamps, and token counts." Detectors never see raw prompt/tool
 * content, only this already-reduced shape.
 */
export interface StepRecord {
  timestampMs: number;
  canonicalShape: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}
