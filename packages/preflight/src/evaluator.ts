import type { PreflightResult, Scope } from '@fuse/contracts';
import type {
  HeartbeatSignal,
  PreflightEvaluatorConfig,
  SpanTelemetrySample,
} from './types.js';

const STATE_RANK: Record<'blind' | 'degraded' | 'protected', number> = {
  blind: 0,
  degraded: 1,
  protected: 2,
};

interface RawEvaluation {
  rawState: 'protected' | 'degraded' | 'blind';
  reasonCode: PreflightResult['reasonCode'];
  reason: string;
  coveragePct: number;
  orphanPct: number;
  freshnessMs: number | null;
}

function evaluateRaw(
  spans: readonly SpanTelemetrySample[],
  heartbeat: HeartbeatSignal | undefined,
  nowMs: number,
  config: PreflightEvaluatorConfig,
): RawEvaluation {
  const latestTimestamp =
    spans.length > 0 ? Math.max(...spans.map((s) => s.timestampMs)) : null;
  const freshnessMs = latestTimestamp !== null ? nowMs - latestTimestamp : null;
  const evidenceIsCurrent =
    freshnessMs !== null && freshnessMs <= config.maxEvidenceStalenessMs;

  if (!evidenceIsCurrent) {
    const heartbeatAlive =
      heartbeat !== undefined &&
      nowMs - heartbeat.lastSeenAtMs <= config.heartbeatGraceMs;
    if (heartbeatAlive) {
      return {
        rawState: 'degraded',
        reasonCode: 'no-recent-telemetry',
        reason: `no fresh span evidence within ${config.maxEvidenceStalenessMs}ms, but a heartbeat confirms the agent is alive — treated as idle, not broken`,
        coveragePct: 0,
        orphanPct: 0,
        freshnessMs,
      };
    }
    return {
      rawState: 'blind',
      reasonCode: freshnessMs === null ? 'no-signal' : 'stale-evidence',
      reason:
        freshnessMs === null
          ? 'no spans and no heartbeat observed for this scope'
          : `most recent span is ${freshnessMs}ms old (limit ${config.maxEvidenceStalenessMs}ms) and no heartbeat confirms the agent is alive`,
      coveragePct: 0,
      orphanPct: 0,
      freshnessMs,
    };
  }

  const coverageFractions = spans.map((s) => {
    const checks = [
      s.hasRequestModel,
      s.hasInputTokens,
      s.hasOutputTokens,
      s.hasScopedIdentity,
      s.hasValidTimestamps,
    ];
    return checks.filter(Boolean).length / checks.length;
  });
  const coveragePct =
    (coverageFractions.reduce((a, b) => a + b, 0) / coverageFractions.length) * 100;

  const nonRootSpans = spans.filter((s) => !s.isRootSpan);
  const orphanCount = nonRootSpans.filter((s) => !s.hasParent).length;
  const orphanPct =
    nonRootSpans.length > 0 ? (orphanCount / nonRootSpans.length) * 100 : 0;

  const tokenMissingCount = spans.filter(
    (s) => !s.hasInputTokens || !s.hasOutputTokens,
  ).length;
  const tokenMissingFraction = tokenMissingCount / spans.length;

  const coverageFraction = coveragePct / 100;
  const orphanFraction = orphanPct / 100;

  if (
    coverageFraction < config.blindCoverageThreshold ||
    orphanFraction > config.blindOrphanRateThreshold ||
    tokenMissingFraction > config.blindTokenMissingRateThreshold
  ) {
    const reasonCode =
      tokenMissingFraction > config.blindTokenMissingRateThreshold
        ? 'missing-required-fields'
        : coverageFraction < config.blindCoverageThreshold
          ? 'missing-required-fields'
          : 'orphan-spans-detected';
    return {
      rawState: 'blind',
      reasonCode,
      reason:
        tokenMissingFraction > config.blindTokenMissingRateThreshold
          ? `${(tokenMissingFraction * 100).toFixed(1)}% of spans are missing input/output token counts — cost-velocity and context-bloat detection are blind regardless of other fields`
          : `required-field coverage ${coveragePct.toFixed(1)}%, orphan rate ${orphanPct.toFixed(1)}% — too broken to trust`,
      coveragePct,
      orphanPct,
      freshnessMs,
    };
  }
  if (coveragePct < 100 || orphanPct > 0) {
    return {
      rawState: 'degraded',
      reasonCode: coveragePct < 100 ? 'missing-required-fields' : 'orphan-spans-detected',
      reason: `required-field coverage ${coveragePct.toFixed(1)}%, orphan rate ${orphanPct.toFixed(1)}%`,
      coveragePct,
      orphanPct,
      freshnessMs,
    };
  }
  return {
    rawState: 'protected',
    reasonCode: 'healthy',
    reason: 'all required fields present, no orphan spans, fresh telemetry',
    coveragePct,
    orphanPct,
    freshnessMs,
  };
}

export interface EvaluatePreflightArgs {
  scope: Scope;
  spans: readonly SpanTelemetrySample[];
  heartbeat?: HeartbeatSignal | undefined;
  now: Date;
  config: PreflightEvaluatorConfig;
  /** The previous evaluation for this scope, or undefined for the very
   * first evaluation. Required for hysteresis — without it, recovery
   * would commit instantly on the first good sample after a break. */
  previous?: PreflightResult | undefined;
  /** Operator override: monitoring explicitly disabled for this scope. */
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
}

/**
 * Pure, deterministic Preflight evaluation. Degradation always commits
 * immediately (fail fast on breakage); recovery to a better state must
 * dwell for `config.minRecoveryDwellMs` before committing (fail slow on
 * recovery) — this asymmetry is deliberate: operators need to know the
 * instant telemetry breaks, but a single good sample right after a break
 * shouldn't instantly re-claim full protection.
 */
export function evaluatePreflight(args: EvaluatePreflightArgs): PreflightResult {
  const nowMs = args.now.getTime();
  const nowIso = args.now.toISOString();

  if (args.disabled) {
    return {
      scope: args.scope,
      state: 'disabled',
      reasonCode: 'operator-disabled',
      reason: args.disabledReason ?? 'Preflight monitoring disabled for this scope',
      evaluatedAt: nowIso,
      lastGoodAt: args.previous?.lastGoodAt ?? null,
      requiredFieldCoveragePercent: 0,
      orphanRatePercent: 0,
      freshnessMs: null,
      pendingRecoveryState: null,
      pendingSince: null,
    };
  }

  const raw = evaluateRaw(args.spans, args.heartbeat, nowMs, args.config);

  // `lastGoodAt` must reflect the last time `protected` was actually
  // COMMITTED as the reported state — not merely proposed by this call's
  // raw evaluation. `buildCommitted()` always reports `raw.rawState` as
  // the committed state, so bumping it here on `raw.rawState ===
  // 'protected'` is correct for that path specifically (previously this
  // was computed once, upfront, and reused for the "recovering" hold
  // path below too — where the committed state is `previous.state`, NOT
  // protected — falsely advancing `lastGoodAt` to "now" while the
  // officially reported state was still `blind`/`degraded`).
  const buildCommitted = (): PreflightResult => ({
    scope: args.scope,
    state: raw.rawState,
    reasonCode: raw.reasonCode,
    reason: raw.reason,
    evaluatedAt: nowIso,
    lastGoodAt:
      raw.rawState === 'protected' ? nowIso : (args.previous?.lastGoodAt ?? null),
    requiredFieldCoveragePercent: raw.coveragePct,
    orphanRatePercent: raw.orphanPct,
    freshnessMs: raw.freshnessMs,
    pendingRecoveryState: null,
    pendingSince: null,
  });

  // No usable previous baseline (first-ever evaluation, or coming out of
  // an operator-disabled period) — nothing to hold hysteresis against.
  const previous =
    args.previous && args.previous.state !== 'disabled' ? args.previous : undefined;
  if (!previous) {
    return buildCommitted();
  }

  const prevRank = STATE_RANK[previous.state as 'blind' | 'degraded' | 'protected'];
  const rawRank = STATE_RANK[raw.rawState];

  if (rawRank <= prevRank) {
    // Same or worse: commit immediately, clearing any pending recovery.
    return buildCommitted();
  }

  // An improvement is being proposed — dwell before committing it.
  const alreadyPendingThisState =
    previous.pendingRecoveryState === raw.rawState && previous.pendingSince !== null;
  const pendingSince = alreadyPendingThisState ? previous.pendingSince! : nowIso;
  const dwellSatisfied =
    nowMs - new Date(pendingSince).getTime() >= args.config.minRecoveryDwellMs;

  if (dwellSatisfied) {
    return buildCommitted();
  }

  return {
    scope: args.scope,
    state: previous.state, // hold the previous (worse) committed state
    reasonCode: 'recovering',
    reason: `telemetry looks healthy again, confirming before recovering: ${raw.reason}`,
    evaluatedAt: nowIso,
    // NOT bumped to `now` here: the committed `state` above is still the
    // previous (worse) one, not `protected`, however healthy this call's
    // raw evaluation looks — `lastGoodAt` must only ever advance when
    // `protected` is actually the reported state, or an operator reading
    // it mid-dwell would see a just-now timestamp while the scope is
    // still officially unprotected.
    lastGoodAt: previous.lastGoodAt,
    requiredFieldCoveragePercent: raw.coveragePct,
    orphanRatePercent: raw.orphanPct,
    freshnessMs: raw.freshnessMs,
    pendingRecoveryState: raw.rawState,
    pendingSince,
  };
}
