import type { FuseGuard } from '@fuse/sdk';

/**
 * `normal`         — bounded, well-behaved run (verifier approves quickly).
 * `loop`           — Analyzer/Verifier ping-pong with near-identical
 *                    content every round; the verifier never approves.
 *                    Mirrors the brief's "Analyzer↔Verifier ping-pong,
 *                    thousands of iterations/hour" pathology.
 * `context-bloat`  — each round appends a large, never-compacted block to
 *                    the running history, so input tokens grow every step.
 * `cost-velocity`  — bounded synthetic high-cost calls spanning enough
 *                    logical time for the real detector's incomplete-window
 *                    safeguard; all prices remain explicitly estimated.
 */
export type Scenario = 'normal' | 'loop' | 'context-bloat' | 'cost-velocity';

/** `safety-ceiling` covers every ceiling in `safety.ts`, including
 * `maxCalls` itself — exhausting the call budget is exhausting a ceiling,
 * not a separate "ran out of rounds" concept. */
export type StopReason = 'verifier-approved' | 'breaker-tripped' | 'safety-ceiling';

export interface RoundResult {
  index: number;
  role: 'analyzer' | 'verifier';
  inputTokens: number;
  outputTokens: number;
  content: string;
  approved?: boolean;
}

export interface RunResult {
  scenario: Scenario;
  stopReason: StopReason;
  rounds: RoundResult[];
  totalCalls: number;
  totalTokens: number;
  estimatedSpendUsd: number;
  elapsedMs: number;
}

export interface ModelCallArgs {
  role: 'analyzer' | 'verifier';
  round: number;
  historyLength: number;
  scenario: Scenario;
  seed: number;
}

export interface ModelCallResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  /** Non-sensitive semantic phase labels. These let canonicalization preserve
   * genuine progress without exporting model text. */
  stepStructure?: readonly string[];
}

export interface Model {
  call(args: ModelCallArgs): Promise<ModelCallResult>;
}

export interface SafetyCeilingsConfig {
  maxCalls?: number;
  maxRuntimeMs?: number;
  maxTotalTokens?: number;
  maxSpendUsd?: number;
}

export interface RunConfig extends SafetyCeilingsConfig {
  scenario: Scenario;
  seed: number;
  guard: FuseGuard;
  model?: Model;
  iterationDelayMs?: number;
  correlationIdPrefix?: string;
  /** gen_ai.provider.name / gen_ai.request.model attribute values for the
   * emitted spans/metrics. Default to a clearly-fake identifier so mock
   * runs are never mistaken for real provider telemetry. Override these
   * when substituting a real provider adapter for `model`. */
  providerName?: string;
  requestModel?: string;
}
