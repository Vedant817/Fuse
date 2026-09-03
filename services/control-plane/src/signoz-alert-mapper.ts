import {
  ScopeSchema,
  SourceBreakerEpochSchema,
  type NormalizedAlertEvent,
  type SignozAlertmanagerAlert,
} from '@fuse/contracts';

/**
 * Maps one Alertmanager-shaped alert instance to Fuse's normalized event.
 * Returns `undefined` when the alert's labels don't resolve to a known
 * scope — callers must treat that as "reject/skip," never as "trip
 * something anyway." Tolerant of both dotted (`fuse.tenant`, matching
 * OTel resource-attribute naming) and underscored (`fuse_tenant`,
 * matching typical Prometheus/SigNoz label-name constraints) label key
 * variants. Checked directly against a real self-hosted instance
 * (ADR-005): querying `signoz_metrics.distributed_time_series_v4`'s
 * `labels` column for spans/metrics emitted by `@fuse/otel` shows SigNoz
 * stores OTel resource attributes verbatim, dots and all
 * (`deployment.environment.name`, `service.name`, `gen_ai.request.model`
 * all appear with dots, never converted to underscores) — unlike a
 * vanilla Prometheus/OTel-Prometheus-bridge, which would sanitize dots to
 * underscores since Prometheus label names disallow them. Since alert
 * rules are built from these same stored labels, the dotted form
 * (`fuse.tenant`) is very likely the one that actually reaches a webhook
 * in practice, not the underscored one this comment previously assumed
 * was equally or more likely. Both forms are still accepted defensively
 * — this is real evidence at the label-storage layer, not a live
 * end-to-end "watched a real Alertmanager payload arrive" proof (creating
 * an alert rule requires the SigNoz UI's session-based auth, which was
 * not reverse-engineered — a further, optional step, not done here).
 */
export function mapSignozAlertToNormalizedEvent(
  alert: SignozAlertmanagerAlert,
): NormalizedAlertEvent | undefined {
  const tenant = findLabel(alert.labels, 'fuse.tenant', 'fuse_tenant', 'tenant');
  const environment = findLabel(
    alert.labels,
    'fuse.environment',
    'fuse_environment',
    'environment',
    'deployment.environment.name',
    'deployment_environment_name',
  );
  const agentId = findLabel(
    alert.labels,
    'fuse.agent_id',
    'fuse_agent_id',
    'agent_id',
    'agentId',
  );
  if (!tenant || !environment || !agentId) {
    return undefined;
  }
  const scopeResult = ScopeSchema.safeParse({ tenant, environment, agentId });
  if (!scopeResult.success) {
    return undefined;
  }

  // Truncated defensively (matching `reason` below) rather than trusting
  // NormalizedAlertEventSchema's own max(200) to be enforced downstream —
  // this value is never actually run through that schema's safeParse/parse
  // anywhere on the real webhook path (task.md §11.3 adversarial review), so
  // truncation has to happen here to be load-bearing at all.
  const detector = (
    findLabel(alert.labels, 'fuse.detector', 'fuse_detector', 'detector') ?? 'unknown'
  ).slice(0, 200);
  const reason =
    alert.annotations['summary'] ??
    alert.annotations['description'] ??
    `SigNoz alert ${alert.fingerprint} (${detector}) fired`;
  const sourceEpoch = parseSourceEpoch(
    findLabel(alert.labels, 'fuse.source_epoch', 'fuse_source_epoch'),
  );

  return {
    scope: scopeResult.data,
    status: alert.status,
    detector,
    reason: reason.slice(0, 2000),
    fingerprint: alert.fingerprint,
    startsAt: alert.startsAt,
    ...(sourceEpoch === undefined ? {} : { sourceEpoch }),
  };
}

/** Accept only a canonical unsigned base-10 integer. `Number("1e3")`,
 * whitespace, signs, decimals, and values beyond the exact integer range are
 * deliberately rejected rather than coerced into an enforcement epoch. */
function parseSourceEpoch(value: string | undefined): number | undefined {
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = Number(value);
  const result = SourceBreakerEpochSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

function findLabel(
  labels: Record<string, string>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = labels[key];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}
