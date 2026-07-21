import { metrics, type Counter, type Histogram } from '@opentelemetry/api';
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
