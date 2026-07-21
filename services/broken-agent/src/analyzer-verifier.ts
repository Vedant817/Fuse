import { BreakerTrippedError } from '@fuse/sdk';
import { defaultMockModel } from './mock-model.js';
import { clampCeilings, DEMO_PRICE_PER_TOKEN_USD } from './safety.js';
import type { RoundResult, RunConfig, RunResult, StopReason } from './types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs a generic Analyzer↔Verifier reflection loop (Analyzer drafts,
 * Verifier critiques or approves) through `FuseGuard`, so every model call
 * is subject to the same pre-call permit check any real agent would be.
 * Hard safety ceilings (`safety.ts`) are checked before every single call,
 * unconditionally — independent of the breaker's own state — so this
 * fixture cannot run away even if the breaker were somehow bypassed.
 */
export async function runAnalyzerVerifier(config: RunConfig): Promise<RunResult> {
  const ceilings = clampCeilings(config);
  const model = config.model ?? defaultMockModel;
  const correlationPrefix =
    config.correlationIdPrefix ?? `broken-agent-${config.scenario}`;
  const start = Date.now();

  const rounds: RoundResult[] = [];
  let historyLength = 0;
  let totalTokens = 0;
  // Reaching the end of the loop below means the maxCalls ceiling was
  // exhausted without an earlier stop condition firing — that is itself a
  // safety-ceiling stop, so it is the correct default, not a distinct
  // "ran out of rounds" outcome.
  let stopReason: StopReason = 'safety-ceiling';

  for (let i = 0; i < ceilings.maxCalls; i++) {
    if (Date.now() - start >= ceilings.maxRuntimeMs) {
      stopReason = 'safety-ceiling';
      break;
    }
    if (totalTokens >= ceilings.maxTotalTokens) {
      stopReason = 'safety-ceiling';
      break;
    }
    if (totalTokens * DEMO_PRICE_PER_TOKEN_USD >= ceilings.maxSpendUsd) {
      stopReason = 'safety-ceiling';
      break;
    }

    const role = i % 2 === 0 ? 'analyzer' : 'verifier';
    let callResult;
    try {
      callResult = await config.guard.guard(
        () =>
          model.call({
            role,
            round: i,
            historyLength,
            scenario: config.scenario,
            seed: config.seed,
          }),
        `${correlationPrefix}-${i}`,
      );
    } catch (err) {
      if (err instanceof BreakerTrippedError) {
        stopReason = 'breaker-tripped';
        break;
      }
      throw err;
    }

    totalTokens += callResult.inputTokens + callResult.outputTokens;
    historyLength += callResult.content.length;
    const round: RoundResult = {
      index: i,
      role,
      inputTokens: callResult.inputTokens,
      outputTokens: callResult.outputTokens,
      content: callResult.content,
    };
    if (role === 'verifier') {
      round.approved = /\bapproved\b/i.test(callResult.content);
    }
    rounds.push(round);

    if (totalTokens * DEMO_PRICE_PER_TOKEN_USD >= ceilings.maxSpendUsd) {
      stopReason = 'safety-ceiling';
      break;
    }
    if (round.approved) {
      stopReason = 'verifier-approved';
      break;
    }

    if (config.iterationDelayMs) {
      await sleep(config.iterationDelayMs);
    }
  }

  return {
    scenario: config.scenario,
    stopReason,
    rounds,
    totalCalls: rounds.length,
    totalTokens,
    estimatedSpendUsd: totalTokens * DEMO_PRICE_PER_TOKEN_USD,
    elapsedMs: Date.now() - start,
  };
}
