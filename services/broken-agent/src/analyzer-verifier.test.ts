import { FuseGuard } from '@fuse/sdk';
import { describe, expect, it, vi } from 'vitest';
import { runAnalyzerVerifier } from './analyzer-verifier.js';
import { ABSOLUTE_MAX_CALLS, ABSOLUTE_MAX_TOTAL_TOKENS } from './safety.js';
import type { Model } from './types.js';

function allowingGuard(): FuseGuard {
  // mockImplementation (not mockResolvedValue) so every call gets a fresh
  // Response instance — reusing one Response across calls means its body
  // stream is already consumed after the first .json() read.
  const fetchImpl = vi.fn().mockImplementation(
    () =>
      new Response(
        JSON.stringify({
          allowed: true,
          state: 'armed',
          reason: 'armed',
          epoch: 0,
          degraded: false,
          correlationId: 'c1',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  return new FuseGuard({
    scope: { tenant: 't1', environment: 'test', agentId: 'broken-agent' },
    controlPlaneUrl: 'http://cp.internal',
    apiToken: 'tok',
    fetchImpl,
  });
}

describe('runAnalyzerVerifier', () => {
  it('normal scenario terminates via verifier-approved within a small bounded number of rounds', async () => {
    const result = await runAnalyzerVerifier({
      scenario: 'normal',
      seed: 1,
      guard: allowingGuard(),
    });
    expect(result.stopReason).toBe('verifier-approved');
    expect(result.totalCalls).toBeLessThan(10);
    expect(result.rounds.at(-1)?.approved).toBe(true);
  });

  it('loop scenario never approves and runs until the safety ceiling, with a canonicalizable repeated shape', async () => {
    const result = await runAnalyzerVerifier({
      scenario: 'loop',
      seed: 1,
      guard: allowingGuard(),
      maxCalls: 10,
    });
    expect(result.stopReason).toBe('safety-ceiling');
    expect(result.rounds.every((r) => r.role !== 'verifier' || r.approved !== true)).toBe(
      true,
    );

    const analyzerContents = result.rounds
      .filter((r) => r.role === 'analyzer')
      .map((r) => r.content);
    expect(new Set(analyzerContents).size).toBe(1); // byte-identical every round: the loop signature
  });

  it('context-bloat scenario produces strictly growing input tokens round over round', async () => {
    const result = await runAnalyzerVerifier({
      scenario: 'context-bloat',
      seed: 1,
      guard: allowingGuard(),
      maxCalls: 10,
    });
    expect(result.stopReason).toBe('safety-ceiling');
    const inputTokenSeries = result.rounds.map((r) => r.inputTokens);
    for (let i = 1; i < inputTokenSeries.length; i++) {
      expect(inputTokenSeries[i]).toBeGreaterThan(inputTokenSeries[i - 1]!);
    }
  });

  it('cost-velocity scenario (near-zero delay) completes far faster than the same call count with a real delay', async () => {
    const fast = await runAnalyzerVerifier({
      scenario: 'cost-velocity',
      seed: 1,
      guard: allowingGuard(),
      iterationDelayMs: 0,
    });
    const paced = await runAnalyzerVerifier({
      scenario: 'normal',
      seed: 1,
      guard: allowingGuard(),
      iterationDelayMs: 50,
    });
    // Same shape (both approve around the same round), wildly different pacing.
    expect(fast.elapsedMs).toBeLessThan(paced.elapsedMs);
  });

  it('clamps a configured ceiling far above the absolute maximum back down to it', async () => {
    const result = await runAnalyzerVerifier({
      scenario: 'loop',
      seed: 1,
      guard: allowingGuard(),
      maxCalls: 999_999,
    });
    expect(result.totalCalls).toBeLessThanOrEqual(ABSOLUTE_MAX_CALLS);
  });

  it('stops immediately on a breaker trip mid-run, with zero further model dispatches', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            allowed: true,
            state: 'armed',
            reason: 'armed',
            epoch: 0,
            degraded: false,
            correlationId: 'c1',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            allowed: false,
            state: 'tripped',
            reason: 'loop detected',
            epoch: 1,
            degraded: false,
            correlationId: 'c2',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const guard = new FuseGuard({
      scope: { tenant: 't1', environment: 'test', agentId: 'broken-agent' },
      controlPlaneUrl: 'http://cp.internal',
      apiToken: 'tok',
      fetchImpl,
    });

    const modelSpy = vi
      .fn()
      .mockResolvedValue({ content: 'x', inputTokens: 1, outputTokens: 1 });
    const model: Model = { call: modelSpy };

    const result = await runAnalyzerVerifier({
      scenario: 'loop',
      seed: 1,
      guard,
      model,
      maxCalls: 20,
    });
    expect(result.stopReason).toBe('breaker-tripped');
    expect(result.totalCalls).toBe(1); // only the first (allowed) call actually dispatched
    expect(modelSpy).toHaveBeenCalledTimes(1);
  });

  it('does not treat a negated rejection ("not approved") as approval', async () => {
    const model: Model = {
      call: vi.fn().mockResolvedValue({
        content: 'This draft is not approved and needs substantial revision.',
        inputTokens: 5,
        outputTokens: 5,
      }),
    };
    const result = await runAnalyzerVerifier({
      scenario: 'normal',
      seed: 1,
      guard: allowingGuard(),
      model,
      maxCalls: 4,
    });
    expect(result.stopReason).toBe('safety-ceiling');
    expect(result.rounds.every((r) => r.role !== 'verifier' || r.approved !== true)).toBe(
      true,
    );
  });

  it('stops immediately (not one round late) when a single call pushes total tokens past the ceiling', async () => {
    const model: Model = {
      call: vi.fn().mockResolvedValue({
        content: 'Needs revision: still not there.',
        inputTokens: 50_000,
        outputTokens: 50_000,
      }),
    };
    const result = await runAnalyzerVerifier({
      scenario: 'normal',
      seed: 1,
      guard: allowingGuard(),
      model,
      maxCalls: 20,
      maxTotalTokens: 80_000, // a single round's 100k tokens blows past this
    });
    expect(result.stopReason).toBe('safety-ceiling');
    expect(result.totalCalls).toBe(1); // caught right after the offending call, not on round 2
  });

  it('a NaN maxTotalTokens config does not disable the token ceiling', async () => {
    // Regression for a `clampCeilings` bug: `Math.min(NaN, absoluteMax)` is
    // `NaN`, and every `totalTokens >= ceilings.maxTotalTokens` check is
    // then `false` (comparisons against NaN are always false) — so a NaN
    // config value silently disabled the token ceiling instead of falling
    // back to the absolute maximum. Before the fix, this ran all 20 calls
    // (never stopping on the ceiling); after the fix it stops once
    // cumulative tokens reach ABSOLUTE_MAX_TOTAL_TOKENS (10 calls of 30k).
    const model: Model = {
      call: vi.fn().mockResolvedValue({
        content: 'Needs revision: still not there.',
        inputTokens: 15_000,
        outputTokens: 15_000,
      }),
    };
    const result = await runAnalyzerVerifier({
      scenario: 'normal',
      seed: 1,
      guard: allowingGuard(),
      model,
      maxCalls: 20,
      maxTotalTokens: NaN,
    });
    expect(result.stopReason).toBe('safety-ceiling');
    expect(result.totalCalls).toBe(10);
    expect(result.totalTokens).toBeLessThanOrEqual(ABSOLUTE_MAX_TOTAL_TOKENS);
  });
});
