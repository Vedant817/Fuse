import {
  ScopeSchema,
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
 * variants, since which form SigNoz's query/alert-rule label propagation
 * actually preserves has not been verified against a live instance yet
 * (task.md §3.3/§4.5, blocked on SigNoz Cloud access) — this tolerance is
 * a deliberate hedge, not a guess presented as fact.
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

  const detector =
    findLabel(alert.labels, 'fuse.detector', 'fuse_detector', 'detector') ?? 'unknown';
  const reason =
    alert.annotations['summary'] ??
    alert.annotations['description'] ??
    `SigNoz alert ${alert.fingerprint} (${detector}) fired`;

  return {
    scope: scopeResult.data,
    status: alert.status,
    detector,
    reason: reason.slice(0, 2000),
    fingerprint: alert.fingerprint,
    startsAt: alert.startsAt,
  };
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
