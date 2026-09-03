import type { DetectorProtectionStatus, PreflightResult, Scope } from '@fuse/contracts';
import type {
  DetectorProtectionEvidence,
  ExporterDeliverySignal,
  HeartbeatSignal,
  PreflightEvaluatorConfig,
  SpanTelemetrySample,
} from './types.js';

/**
 * Evaluates direct-detector protection independently of overall OTel health.
 * Loop signature, context bloat, and cost velocity all aggregate within one
 * execution window. Missing prices degrade only cost velocity; structural
 * loop and token-growth protection remains usable.
 */
export function evaluateDetectorProtection(
  evidence: DetectorProtectionEvidence,
): DetectorProtectionStatus[] {
  const detectors = ['loop-signature', 'context-bloat', 'cost-velocity'] as const;
  if (!evidence.reportingAvailable) {
    return detectors.map((detector) => ({
      detector,
      status: 'degraded',
      reasonCode: 'reporting-unavailable',
      reason: `direct detector reporting is unavailable for execution ${evidence.executionId}`,
    }));
  }
  if (evidence.pricingStatuses.length === 0) {
    return detectors.map((detector) => ({
      detector,
      status: 'degraded',
      reasonCode: 'no-observations',
      reason: `no completed observations exist for execution ${evidence.executionId}`,
    }));
  }
  return detectors.map((detector) =>
    detector === 'cost-velocity' &&
    evidence.pricingStatuses.some((status) => status === 'unavailable')
      ? {
          detector,
          status: 'degraded',
          reasonCode: 'pricing-unavailable',
          reason: `pricing is unavailable for at least one call in execution ${evidence.executionId}`,
        }
      : {
          detector,
          status: 'protected',
          reasonCode: 'healthy',
          reason: `required direct-detector evidence is available for execution ${evidence.executionId}`,
        },
  );
}

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
  exporterDelivery: ExporterDeliverySignal | undefined,
  nowMs: number,
  config: PreflightEvaluatorConfig,
): RawEvaluation {
  // Clock-skewed future timestamps are not evidence about health "now". In
  // particular, clamping their age to zero would let a future-dated sample
  // claim protection until wall time caught up with it.
  const currentSpans = spans.filter((span) => span.timestampMs <= nowMs);
  const latestTimestamp =
    currentSpans.length > 0
      ? Math.max(...currentSpans.map((span) => span.timestampMs))
      : null;
  const freshnessMs = latestTimestamp !== null ? nowMs - latestTimestamp : null;
  const evidenceIsCurrent =
    freshnessMs !== null && freshnessMs <= config.maxEvidenceStalenessMs;

  // A current failure acknowledgement is authoritative even if every span in
  // the rejected batch is stale. Checking freshness first would let a caller
  // mask exporter failure as a less-specific idle/stale condition.
  if (exporterDelivery?.status === 'failure' && exporterDelivery.observedAtMs <= nowMs) {
    return {
      rawState: 'blind',
      reasonCode: 'exporter-delivery-failed',
      reason:
        'the exporter-evidence role reported that the OTLP exporter failed to deliver this scope to its configured endpoint',
      coveragePct: 0,
      orphanPct: 0,
      freshnessMs,
    };
  }

  if (!evidenceIsCurrent) {
    const heartbeatAgeMs =
      heartbeat !== undefined ? nowMs - heartbeat.lastSeenAtMs : null;
    const heartbeatAlive =
      heartbeatAgeMs !== null &&
      heartbeatAgeMs >= 0 &&
      heartbeatAgeMs <= config.heartbeatGraceMs;
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

  if (!exporterDelivery || exporterDelivery.observedAtMs > nowMs) {
    return {
      rawState: 'degraded',
      reasonCode: 'exporter-delivery-unconfirmed',
      reason:
        'span callbacks ran locally, but the exporter-evidence role has not reported a successful OTLP export for this scope',
      coveragePct: 0,
      orphanPct: 0,
      freshnessMs,
    };
  }

  const exporterDeliveryFreshnessMs = nowMs - exporterDelivery.observedAtMs;
  if (exporterDeliveryFreshnessMs > config.maxEvidenceStalenessMs) {
    return {
      rawState: 'blind',
      reasonCode: 'exporter-delivery-stale',
      reason: `last successful OTLP export reported by the exporter-evidence role is ${exporterDeliveryFreshnessMs}ms old (limit ${config.maxEvidenceStalenessMs}ms)`,
      coveragePct: 0,
      orphanPct: 0,
      freshnessMs,
    };
  }

  const coverageFractions = currentSpans.map((s) => {
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

  const nonRootSpans = currentSpans.filter((s) => !s.isRootSpan);
  const orphanCount = nonRootSpans.filter((s) => !s.hasParent).length;
  const orphanPct =
    nonRootSpans.length > 0 ? (orphanCount / nonRootSpans.length) * 100 : 0;

  const tokenMissingCount = currentSpans.filter(
    (s) => !s.hasInputTokens || !s.hasOutputTokens,
  ).length;
  const tokenMissingFraction = tokenMissingCount / currentSpans.length;

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
  exporterDelivery?: ExporterDeliverySignal | undefined;
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

  const raw = evaluateRaw(
    args.spans,
    args.heartbeat,
    args.exporterDelivery,
    nowMs,
    args.config,
  );

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
