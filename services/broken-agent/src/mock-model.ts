import type { Model, ModelCallArgs, ModelCallResult } from './types.js';

const REVISION_PHRASES = [
  'Needs revision: please reconsider the proposed approach.',
  'Please reconsider the proposed approach; it still needs revision.',
];

function progressLabel(round: number): string {
  let value = Math.floor(round / 2);
  let label = '';
  do {
    label = String.fromCharCode(97 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return `progress-${label}`;
}

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
    let inputTokens = Math.max(1, Math.ceil(historyLength / 4));
    let content: string;
    let stepStructure: readonly string[];

    if (role === 'analyzer') {
      if (scenario === 'context-bloat') {
        // Each round appends a large, never-compacted block — the input
        // token count on every *subsequent* call grows because of it.
        content = `Draft v${round}: ${'context-padding-'.repeat(50 + round * 20)}`;
        stepStructure = ['draft', 'context-growth', progressLabel(round)];
      } else if (scenario === 'loop') {
        // Volatile fields and modest wording vary, while the semantic phase
        // remains progress-free. The local canonicalizer must recover the
        // stable loop shape without exporting this content.
        const qualifier = round % 4 === 0 ? 'remains unchanged' : 'is unchanged';
        content =
          `Draft ${1000 + round} at 2026-08-24T10:${String(round).padStart(2, '0')}:00Z: ` +
          `the proposed answer ${qualifier} from the previous attempt; ` +
          `request 550e8400-e29b-41d4-a716-${String(446655440000 + round).padStart(12, '0')}.`;
        stepStructure = ['draft', 'no-progress'];
      } else {
        content = 'Draft: proposed answer.';
        stepStructure = ['draft', progressLabel(round)];
      }
    } else {
      // verifier
      if (scenario === 'loop' || scenario === 'context-bloat') {
        content = REVISION_PHRASES[(seed + round) % REVISION_PHRASES.length]!;
        stepStructure =
          scenario === 'loop'
            ? ['review', 'revision-request']
            : ['review', 'context-growth', progressLabel(round)];
      } else if (scenario === 'cost-velocity') {
        content = 'Synthetic high-cost batch continues without a cumulative budget stop.';
        stepStructure = ['review', 'cost-burst', progressLabel(round)];
      } else {
        // Normal approves on the second verifier turn.
        content = round >= 3 ? 'Approved.' : 'Needs minor revision.';
        stepStructure = [
          'review',
          round >= 3 ? 'approved' : 'revision-request',
          progressLabel(round),
        ];
      }
    }

    if (scenario === 'cost-velocity') {
      // Synthetic usage, deliberately large enough to exercise estimated-cost
      // velocity without making a provider request or claiming actual spend.
      inputTokens = 50_000;
    }

    const outputTokens = scenario === 'cost-velocity' ? 10_000 : estimateTokens(content);
    return { content, inputTokens, outputTokens, stepStructure };
  },
};
