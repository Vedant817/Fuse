import { randomUUID } from 'node:crypto';
import { withGenAiSpan } from '@fuse/otel';
import { BreakerTrippedError } from '@fuse/sdk';
import { defaultMockModel } from './mock-model.js';
import { clampCeilings, DEMO_PRICE_PER_TOKEN_USD } from './safety.js';
import type { RoundResult, RunConfig, RunResult, StopReason } from './types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_PROVIDER_NAME = 'fuse-mock';
const DEFAULT_REQUEST_MODEL = 'mock-model-v1';

/**
 * Runs a generic Analyzer↔Verifier reflection loop (Analyzer drafts,
 * Verifier critiques or approves) through `FuseGuard`, so every model call
 * is subject to the same pre-call permit check any real agent would be.
 * Hard safety ceilings (`safety.ts`) are checked before every single call,
 * unconditionally — independent of the breaker's own state — so this
 * fixture cannot run away even if the breaker were somehow bypassed.
 *
 * The whole run is one `invoke_agent` gen_ai span; each round is a nested
 * `chat` span underneath it (task.md §3.2: "preserve trace context...
 * no unexpected orphan step spans" — nesting is automatic here via
 * `withGenAiSpan`'s use of the OTel active-context API, not manual
 * parent-id plumbing).
 */
export async function runAnalyzerVerifier(config: RunConfig): Promise<RunResult> {
  const ceilings = clampCeilings(config);
  const model = config.model ?? defaultMockModel;
  const correlationPrefix =
    config.correlationIdPrefix ?? `broken-agent-${config.scenario}`;
  const sessionId = randomUUID();
  const providerName = config.providerName ?? DEFAULT_PROVIDER_NAME;
  const requestModel = config.requestModel ?? DEFAULT_REQUEST_MODEL;
  const scope = config.guard.scope;

  return withGenAiSpan(
    {
      operationName: 'invoke_agent',
      providerName,
      requestModel,
      tenant: scope.tenant,
      environment: scope.environment,
      agentId: scope.agentId,
      sessionId,
      scenario: config.scenario,
      stepIndex: -1, // root run span, not a per-round step
      correlationId: correlationPrefix,
      conversationId: sessionId,
    },
    async () => {
      const start = Date.now();
      const rounds: RoundResult[] = [];
      let historyLength = 0;
      let totalTokens = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      // Reaching the end of the loop below means the maxCalls ceiling was
      // exhausted without an earlier stop condition firing — that is
      // itself a safety-ceiling stop, so it is the correct default, not a
      // distinct "ran out of rounds" concept.
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
              withGenAiSpan(
                {
                  operationName: 'chat',
                  providerName,
                  requestModel,
                  tenant: scope.tenant,
                  environment: scope.environment,
                  agentId: scope.agentId,
                  sessionId,
                  scenario: config.scenario,
                  stepIndex: i,
                  correlationId: `${correlationPrefix}-${i}`,
                  conversationId: sessionId,
                },
                async () => {
                  const r = await model.call({
                    role,
                    round: i,
                    historyLength,
                    scenario: config.scenario,
                    seed: config.seed,
                  });
                  return {
                    result: r,
                    outcome: {
                      inputTokens: r.inputTokens,
                      outputTokens: r.outputTokens,
                      outcome: 'success',
                    },
                  };
                },
              ),
            `${correlationPrefix}-${i}`,
          );
        } catch (err) {
          if (err instanceof BreakerTrippedError) {
            stopReason = 'breaker-tripped';
            break;
          }
          throw err;
        }

        totalInputTokens += callResult.inputTokens;
        totalOutputTokens += callResult.outputTokens;
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

      const result: RunResult = {
        scenario: config.scenario,
        stopReason,
        rounds,
        totalCalls: rounds.length,
        totalTokens,
        estimatedSpendUsd: totalTokens * DEMO_PRICE_PER_TOKEN_USD,
        elapsedMs: Date.now() - start,
      };
      return {
        result,
        outcome: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          outcome: stopReason === 'breaker-tripped' ? 'denied' : 'success',
        },
      };
    },
  );
}
