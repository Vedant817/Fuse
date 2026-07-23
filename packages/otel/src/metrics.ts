import { metrics, type Counter, type Gauge, type Histogram } from '@opentelemetry/api';
import {
  METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
  METRIC_GEN_AI_CLIENT_TOKEN_USAGE,
} from '@opentelemetry/semantic-conventions/incubating';

const METER_NAME = 'fuse';
const METER_VERSION = '1.0.0';

function meter() {
  return metrics.getMeter(METER_NAME, METER_VERSION);
}

let tokenUsageHistogram: Histogram | undefined;
let operationDurationHistogram: Histogram | undefined;
let breakerDecisionCounter: Counter | undefined;
let detectorScoreGauge: Gauge | undefined;
let detectorFiredGauge: Gauge | undefined;
let estimatedCostCounter: Counter | undefined;
let preflightStateGauge: Gauge | undefined;

/** `{token}` unit histogram, dimensioned by `gen_ai.token.type` (input/
 * output) plus operation/provider/model — deliberately NOT by
 * tenant/agent/session/correlation id, which would make this an
 * unbounded-cardinality metric. Per-agent breakdowns belong on the
 * bounded `fuse.breaker.permit.decisions` counter or on spans, not here. */
export function getTokenUsageHistogram(): Histogram {
  tokenUsageHistogram ??= meter().createHistogram(METRIC_GEN_AI_CLIENT_TOKEN_USAGE, {
    unit: '{token}',
    description: 'Measures number of input and output tokens used per gen_ai operation.',
  });
  return tokenUsageHistogram;
}

/** `s` unit histogram of gen_ai client operation duration. */
export function getOperationDurationHistogram(): Histogram {
  operationDurationHistogram ??= meter().createHistogram(
    METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
    {
      unit: 's',
      description: 'Duration of gen_ai client operations.',
    },
  );
  return operationDurationHistogram;
}

/** Bounded cardinality by design: tenant/environment/agent_id is a finite,
 * pre-registered set in any real deployment (unlike a session or
 * correlation id), which is exactly the dimension the breaker
 * trip/deny/resume history dashboard (task.md §8) needs. Recorded
 * server-side in `services/control-plane/src/routes/permit.ts` — the one
 * place a permit decision is actually authoritative, network-wide across
 * every SDK/agent caller — not client-side per `FuseGuard` instance. */
export function getBreakerDecisionCounter(): Counter {
  breakerDecisionCounter ??= meter().createCounter('fuse.breaker.permit.decisions', {
    unit: '{decision}',
    description: 'Count of breaker permit decisions, by scope/state/allowed/degraded.',
  });
  return breakerDecisionCounter;
}

/**
 * A **gauge**, deliberately not a counter — a detector's `score` (task.md
 * §4) is a point-in-time evaluation result recomputed on every new step
 * observation, not something that accumulates. This matters for how a
 * SigNoz alert rule reads it: a gauge lets the rule use
 * `timeAggregation: "latest"` / `spaceAggregation: "max"` (trivially
 * correct — "is the most recent reported score above threshold"), where a
 * monotonic counter would need `"increase"`/`"rate"` and return 0 for a
 * brand-new series until it has at least two samples to diff against (see
 * `docs/adr/006-signoz-alert-rule-provisioning.md`). Dimensioned by
 * detector type + scope (tenant/environment/agent_id) — bounded cardinality
 * in any real deployment, same reasoning as `getBreakerDecisionCounter`.
 */
export function getDetectorScoreGauge(): Gauge {
  detectorScoreGauge ??= meter().createGauge('fuse.detector.score', {
    unit: '1',
    description:
      'Most recent detector evaluation score, by detector type and scope. Compare against the threshold configured in the corresponding SigNoz alert rule.',
  });
  return detectorScoreGauge;
}

/**
 * A second, deliberately simpler gauge alongside `fuse.detector.score`:
 * `1` when the detector's own `fired` boolean is true, `0` otherwise —
 * always the same unit (a 0/1 indicator), regardless of detector type.
 * `score`'s *units* are not comparable across detectors or even within
 * one: `context-bloat`'s score is a raw token count when its absolute-
 * ceiling path fires, a small consecutive-growth-step count when its
 * growth-run path fires, or a ratio when its ratio path fires — three
 * different scales on one number. A SigNoz alert rule thresholding
 * directly on `score` would need a different, fragile per-path target;
 * thresholding on `fired >= 1` is exact and detector-agnostic by
 * construction, since `@fuse/detectors` has already done the real
 * evaluation work. `score` is kept for dashboards/debugging, not as the
 * alerting signal.
 */
export function getDetectorFiredGauge(): Gauge {
  detectorFiredGauge ??= meter().createGauge('fuse.detector.fired', {
    unit: '1',
    description:
      '1 if the detector fired on its most recent evaluation, 0 otherwise, by detector type and scope.',
  });
  return detectorFiredGauge;
}

/**
 * A monotonic counter (spend only ever accumulates), dimensioned by
 * tenant/environment/agent_id/provider/model — the "spend by agent/model"
 * task.md §8 dashboard panel needs a real metric to sum, and until now
 * `fuse.estimated_cost.usd` existed only as a per-span attribute
 * (`packages/otel/src/gen-ai-span.ts`), never aggregated anywhere a
 * dashboard could query. Explicitly an *estimate* (see `pricing.ts`) —
 * never presented as reconciled provider billing.
 */
export function getEstimatedCostCounter(): Counter {
  estimatedCostCounter ??= meter().createCounter('fuse.estimated_cost.usd.total', {
    unit: 'usd',
    description:
      'Cumulative estimated spend (never reconciled provider billing), by scope/provider/model.',
  });
  return estimatedCostCounter;
}

/**
 * A gauge that is always `1` for whichever single state a scope's Preflight
 * evaluation most recently reported — never a numeric encoding of the
 * enum, which would invite a misleading "average state" query. Grouping by
 * the `fuse.preflight.state` attribute and reading the latest value per
 * scope (task.md §8's Preflight-status dashboard panel) reconstructs
 * "what is this scope's current state" without pretending state is a
 * continuous quantity.
 */
export function getPreflightStateGauge(): Gauge {
  preflightStateGauge ??= meter().createGauge('fuse.preflight.state', {
    unit: '1',
    description:
      'Always 1 for the most recently reported Preflight state, by scope and state label — read the latest value per scope/state to see current status.',
  });
  return preflightStateGauge;
}
