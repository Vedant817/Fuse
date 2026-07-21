import type {
  Actor,
  BreakerAuditEvent,
  BreakerRecord,
  BreakerState,
  PreflightReasonCode,
  PreflightResult,
  PreflightState,
  Scope,
} from '@fuse/contracts';

export interface BreakerStateRow {
  tenant: string;
  environment: string;
  agent_id: string;
  state: BreakerState;
  epoch: string; // BIGINT comes back as string from node-postgres
  reason: string;
  policy_version: string;
  cooldown_until: Date | null;
  updated_at: Date;
  updated_by_type: Actor['type'];
  updated_by_id: string;
}

export function rowToRecord(row: BreakerStateRow): BreakerRecord {
  return {
    scope: { tenant: row.tenant, environment: row.environment, agentId: row.agent_id },
    state: row.state,
    epoch: Number(row.epoch),
    reason: row.reason,
    policyVersion: row.policy_version,
    cooldownUntil: row.cooldown_until ? row.cooldown_until.toISOString() : null,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: { type: row.updated_by_type, id: row.updated_by_id },
  };
}

export interface BreakerAuditRow {
  id: string;
  tenant: string;
  environment: string;
  agent_id: string;
  from_state: BreakerState;
  to_state: BreakerState;
  epoch_before: string;
  epoch_after: string;
  actor_type: Actor['type'];
  actor_id: string;
  reason: string;
  correlation_id: string;
  policy_version: string;
  noop: boolean;
  created_at: Date;
}

export function rowToAuditEvent(row: BreakerAuditRow): BreakerAuditEvent {
  const scope: Scope = {
    tenant: row.tenant,
    environment: row.environment,
    agentId: row.agent_id,
  };
  return {
    id: row.id,
    scope,
    fromState: row.from_state,
    toState: row.to_state,
    epochBefore: Number(row.epoch_before),
    epochAfter: Number(row.epoch_after),
    actor: { type: row.actor_type, id: row.actor_id },
    reason: row.reason,
    correlationId: row.correlation_id,
    policyVersion: row.policy_version,
    noop: row.noop,
    createdAt: row.created_at.toISOString(),
  };
}

export interface PreflightStateRow {
  tenant: string;
  environment: string;
  agent_id: string;
  state: PreflightState;
  reason_code: PreflightReasonCode;
  reason: string;
  evaluated_at: Date;
  last_good_at: Date | null;
  required_field_coverage_percent: number;
  orphan_rate_percent: number;
  freshness_ms: string | null; // BIGINT comes back as string from node-postgres
  pending_recovery_state: PreflightState | null;
  pending_since: Date | null;
}

export function rowToPreflightResult(row: PreflightStateRow): PreflightResult {
  return {
    scope: { tenant: row.tenant, environment: row.environment, agentId: row.agent_id },
    state: row.state,
    reasonCode: row.reason_code,
    reason: row.reason,
    evaluatedAt: row.evaluated_at.toISOString(),
    lastGoodAt: row.last_good_at ? row.last_good_at.toISOString() : null,
    requiredFieldCoveragePercent: row.required_field_coverage_percent,
    orphanRatePercent: row.orphan_rate_percent,
    freshnessMs: row.freshness_ms !== null ? Number(row.freshness_ms) : null,
    pendingRecoveryState: row.pending_recovery_state,
    pendingSince: row.pending_since ? row.pending_since.toISOString() : null,
  };
}
