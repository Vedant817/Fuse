import type { Model, ModelCallArgs, ModelCallResult } from './types.js';

const REVISION_PHRASES = [
  'Needs revision: please reconsider the approach.',
  'Needs revision: the reasoning does not hold up.',
];

/** ~4 characters per token — a documented heuristic, not a real
 * tokenizer. Good enough for deterministic demo telemetry shape. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Deterministic given (scenario, seed, round): no real randomness, no
 * network calls, no real cost. Default model for the broken-agent fixture
 * — a real provider adapter from `@fuse/sdk/providers` can be substituted
 * via `RunConfig.model`-equivalent wiring at the call site instead, behind
 * its own explicit opt-in and the safety ceilings in `safety.ts`.
 */
export const defaultMockModel: Model = {
  async call({
    role,
    round,
    historyLength,
    scenario,
    seed,
  }: ModelCallArgs): Promise<ModelCallResult> {
    const inputTokens = Math.max(1, Math.ceil(historyLength / 4));
    let content: string;

    if (role === 'analyzer') {
      if (scenario === 'context-bloat') {
        // Each round appends a large, never-compacted block — the input
        // token count on every *subsequent* call grows because of it.
        content = `Draft v${round}: ${'context-padding-'.repeat(50 + round * 20)}`;
      } else if (scenario === 'loop') {
        // Byte-identical shape every round (round number aside) — the
        // canonicalizable repeat a loop-signature detector looks for.
        content = 'Draft: proposed answer, unchanged from the previous attempt.';
      } else {
        content = 'Draft: proposed answer.';
      }
    } else {
      // verifier
      if (scenario === 'loop' || scenario === 'context-bloat') {
        content = REVISION_PHRASES[(seed + round) % REVISION_PHRASES.length]!;
      } else {
        // normal / cost-velocity: approve on the second verifier turn.
        content = round >= 3 ? 'Approved.' : 'Needs minor revision.';
      }
    }

    const outputTokens = estimateTokens(content);
    return { content, inputTokens, outputTokens };
  },
};
