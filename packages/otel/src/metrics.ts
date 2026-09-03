import { metrics, type Counter, type Gauge, type Histogram } from '@opentelemetry/api';
import {
  METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
  METRIC_GEN_AI_CLIENT_TOKEN_USAGE,
} from '@opentelemetry/semantic-conventions/incubating';

const METER_NAME = 'fuse';
const METER_VERSION = '1.0.0';

/** Initial operational targets are intentionally provisional until a
 * representative production baseline exists. Keep this value in emitted
 * attributes and SigNoz rule labels so target changes are reviewable. */
export const FUSE_OPERATIONAL_SLO_VERSION = 'v1-provisional';

function meter() {
  return metrics.getMeter(METER_NAME, METER_VERSION);
}

let tokenUsageHistogram: Histogram | undefined;
let operationDurationHistogram: Histogram | undefined;
let breakerDecisionCounter: Counter | undefined;
let detectorScoreGauge: Gauge | undefined;
let detectorFiredGauge: Gauge | undefined;
let estimatedCostCounter: Counter | undefined;
export interface PreflightSelfAlertMetricTransition {
  kind: 'opened' | 'recovered';
  state: string;
  reasonCode: string;
}

export interface PreflightStateGauge extends Gauge {
  recordSelfAlertState(active: boolean, scopeAttributes: Record<string, string>): void;
  recordSelfAlertTransition(
    transition: PreflightSelfAlertMetricTransition,
    scopeAttributes: Record<string, string>,
  ): void;
}

let preflightStateGauge: PreflightStateGauge | undefined;
let preflightSelfAlertActiveGauge: Gauge | undefined;
let preflightSelfAlertTransitionCounter: Counter | undefined;
let diagnosisQueueDepthGauge: Gauge | undefined;
let diagnosisDeliveryLatencyHistogram: Histogram | undefined;
let diagnosisDeliveryAttemptCounter: Counter | undefined;
let permitRequestCounter: Counter | undefined;
let permitLatencyHistogram: Histogram | undefined;
let detectorObservationRequestCounter: Counter | undefined;
let detectorObservationLatencyHistogram: Histogram | undefined;
let webhookRequestCounter: Counter | undefined;
let webhookLatencyHistogram: Histogram | undefined;
let diagnosisLeaseRenewalFailureCounter: Counter | undefined;
let redisReadinessGauge: Gauge | undefined;
let redisReadinessCheckCounter: Counter | undefined;
let preflightEvaluationCounter: Counter | undefined;
let preflightSweepCounter: Counter | undefined;
let preflightSweepHealthGauge: Gauge | undefined;

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
export function getPreflightStateGauge(): PreflightStateGauge {
  preflightStateGauge ??= Object.assign(
    meter().createGauge('fuse.preflight.state', {
      unit: '1',
      description:
        'Always 1 for the most recently reported Preflight state, by scope and state label — read the latest value per scope/state to see current status.',
    }),
    {
      recordSelfAlertState(
        active: boolean,
        scopeAttributes: Record<string, string>,
      ): void {
        getPreflightSelfAlertActiveGauge().record(active ? 1 : 0, scopeAttributes);
      },
      recordSelfAlertTransition(
        transition: PreflightSelfAlertMetricTransition,
        scopeAttributes: Record<string, string>,
      ): void {
        getPreflightSelfAlertTransitionCounter().add(1, {
          ...scopeAttributes,
          'fuse.preflight.transition': transition.kind,
          'fuse.preflight.state': transition.state,
          'fuse.preflight.reason_code': transition.reasonCode,
        });
      },
    },
  );
  return preflightStateGauge;
}

/** Alerting signal, not a dashboard-only encoding. It is written only on a
 * persisted incident edge: `1` when protection first becomes degraded/blind,
 * and `0` once recovery dwell commits protected. Scope-only attributes ensure
 * the recovery updates the exact same series and resolves the SigNoz alert. */
export function getPreflightSelfAlertActiveGauge(): Gauge {
  preflightSelfAlertActiveGauge ??= meter().createGauge(
    'fuse.preflight.self_alert.active',
    {
      unit: '1',
      description:
        'Transition-driven Preflight self-alert state: 1 opened, 0 recovered, by scope.',
    },
  );
  return preflightSelfAlertActiveGauge;
}

/** Auditable transition event count. Unlike the active gauge, this includes
 * reason/state labels because each edge is intentionally a separate event. */
export function getPreflightSelfAlertTransitionCounter(): Counter {
  preflightSelfAlertTransitionCounter ??= meter().createCounter(
    'fuse.preflight.self_alert.transitions',
    {
      unit: '{transition}',
      description:
        'Count of deduplicated Preflight self-alert open/recovery transitions.',
    },
  );
  return preflightSelfAlertTransitionCounter;
}

/** Current durable queue depth. Only SLO version and the finite status enum
 * (`pending`, `running`, `dead-letter`) are permitted; job, tenant, and
 * correlation identities deliberately stay in logs/traces. */
export function getDiagnosisQueueDepthGauge(): Gauge {
  diagnosisQueueDepthGauge ??= meter().createGauge('fuse.diagnosis.queue.jobs', {
    unit: '{job}',
    description:
      'Current durable diagnosis queue depth by status (pending, running, or dead-letter).',
  });
  return diagnosisQueueDepthGauge;
}

/** Wall-clock duration of one delivery attempt, including MCP, snapshot, and
 * Slack work. SLO version plus finite outcome are the only dimensions. */
export function getDiagnosisDeliveryLatencyHistogram(): Histogram {
  diagnosisDeliveryLatencyHistogram ??= meter().createHistogram(
    'fuse.diagnosis.delivery.latency',
    {
      unit: 's',
      description: 'Duration of diagnosis delivery attempts by bounded outcome.',
    },
  );
  return diagnosisDeliveryLatencyHistogram;
}

/** One increment for every completed delivery attempt. Attempt number and
 * audit identity are intentionally excluded to prevent unbounded series. */
export function getDiagnosisDeliveryAttemptCounter(): Counter {
  diagnosisDeliveryAttemptCounter ??= meter().createCounter(
    'fuse.diagnosis.delivery.attempts',
    {
      unit: '{attempt}',
      description: 'Count of diagnosis delivery attempts by bounded outcome.',
    },
  );
  return diagnosisDeliveryAttemptCounter;
}

/** Infrastructure-wide permit traffic. The only dimensions allowed by the
 * contract are the fixed SLO version and bounded outcome enum; scope identity
 * remains on the existing product metric and traces. */
export function getPermitRequestCounter(): Counter {
  permitRequestCounter ??= meter().createCounter('fuse.control_plane.permit.requests', {
    unit: '{request}',
    description:
      'Permit requests by bounded outcome for the provisional operational SLO.',
  });
  return permitRequestCounter;
}

export function getPermitLatencyHistogram(): Histogram {
  permitLatencyHistogram ??= meter().createHistogram(
    'fuse.control_plane.permit.duration',
    {
      unit: 's',
      description:
        'Permit request duration by bounded outcome for p95 and denial-latency SLOs.',
    },
  );
  return permitLatencyHistogram;
}

export function getDetectorObservationRequestCounter(): Counter {
  detectorObservationRequestCounter ??= meter().createCounter(
    'fuse.control_plane.detector_observation.requests',
    {
      unit: '{request}',
      description: 'Detector observation HTTP requests by bounded outcome.',
    },
  );
  return detectorObservationRequestCounter;
}

export function getDetectorObservationLatencyHistogram(): Histogram {
  detectorObservationLatencyHistogram ??= meter().createHistogram(
    'fuse.control_plane.detector_observation.duration',
    {
      unit: 's',
      description: 'Detector observation HTTP request duration by bounded outcome.',
    },
  );
  return detectorObservationLatencyHistogram;
}

export function getWebhookRequestCounter(): Counter {
  webhookRequestCounter ??= meter().createCounter('fuse.control_plane.webhook.requests', {
    unit: '{request}',
    description:
      'SigNoz webhook requests by bounded success, auth-failure, client-error, or server-error outcome.',
  });
  return webhookRequestCounter;
}

export function getWebhookLatencyHistogram(): Histogram {
  webhookLatencyHistogram ??= meter().createHistogram(
    'fuse.control_plane.webhook.duration',
    {
      unit: 's',
      description: 'SigNoz webhook processing duration by bounded HTTP outcome.',
    },
  );
  return webhookLatencyHistogram;
}

export function getDiagnosisLeaseRenewalFailureCounter(): Counter {
  diagnosisLeaseRenewalFailureCounter ??= meter().createCounter(
    'fuse.diagnosis.lease_renewal.failures',
    {
      unit: '{failure}',
      description: 'Diagnosis lease renewal failures by bounded reason.',
    },
  );
  return diagnosisLeaseRenewalFailureCounter;
}

/** Readiness is expected to be polled continuously. Recording both a latest
 * gauge and a check counter lets the alert resolve on recovery and distinguish
 * an explicit outage from an absent control-plane telemetry stream. */
export function getRedisReadinessGauge(): Gauge {
  redisReadinessGauge ??= meter().createGauge('fuse.rate_limit.redis.ready', {
    unit: '1',
    description: 'Latest rate-limit Redis readiness result: 1 ready, 0 unavailable.',
  });
  return redisReadinessGauge;
}

export function getRedisReadinessCheckCounter(): Counter {
  redisReadinessCheckCounter ??= meter().createCounter(
    'fuse.rate_limit.redis.readiness_checks',
    {
      unit: '{check}',
      description: 'Rate-limit Redis readiness checks by bounded outcome.',
    },
  );
  return redisReadinessCheckCounter;
}

export function getPreflightEvaluationCounter(): Counter {
  preflightEvaluationCounter ??= meter().createCounter('fuse.preflight.evaluations', {
    unit: '{evaluation}',
    description:
      'Committed Preflight evaluations by bounded health class and evaluation source.',
  });
  return preflightEvaluationCounter;
}

export function getPreflightSweepCounter(): Counter {
  preflightSweepCounter ??= meter().createCounter('fuse.preflight.sweep.runs', {
    unit: '{run}',
    description: 'Bounded Preflight stale-evidence sweep runs by outcome.',
  });
  return preflightSweepCounter;
}

export function getPreflightSweepHealthGauge(): Gauge {
  preflightSweepHealthGauge ??= meter().createGauge('fuse.preflight.sweep.healthy', {
    unit: '1',
    description: 'Latest Preflight stale-evidence sweep result: 1 success, 0 failure.',
  });
  return preflightSweepHealthGauge;
}
