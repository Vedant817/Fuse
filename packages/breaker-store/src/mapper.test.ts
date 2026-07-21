import { describe, expect, it } from 'vitest';
import {
  rowToPreflightResult,
  type PreflightStateRow,
  rowToAuditEvent,
  rowToRecord,
  type BreakerAuditRow,
  type BreakerStateRow,
} from './mapper.js';

describe('rowToRecord', () => {
  it('maps a Postgres row into a BreakerRecord, converting BIGINT and timestamps', () => {
    const row: BreakerStateRow = {
      tenant: 't1',
      environment: 'prod',
      agent_id: 'agent-1',
      state: 'tripped',
      epoch: '42',
      reason: 'loop detected',
      policy_version: 'v1',
      cooldown_until: new Date('2026-07-21T00:05:00.000Z'),
      updated_at: new Date('2026-07-21T00:00:00.000Z'),
      updated_by_type: 'system',
      updated_by_id: 'system:detector',
    };
    const record = rowToRecord(row);
    expect(record).toEqual({
      scope: { tenant: 't1', environment: 'prod', agentId: 'agent-1' },
      state: 'tripped',
      epoch: 42,
      reason: 'loop detected',
      policyVersion: 'v1',
      cooldownUntil: '2026-07-21T00:05:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      updatedBy: { type: 'system', id: 'system:detector' },
    });
  });

  it('maps a null cooldown_until to null', () => {
    const row: BreakerStateRow = {
      tenant: 't1',
      environment: 'prod',
      agent_id: 'agent-1',
      state: 'armed',
      epoch: '0',
      reason: 'initialized',
      policy_version: 'v1',
      cooldown_until: null,
      updated_at: new Date('2026-07-21T00:00:00.000Z'),
      updated_by_type: 'system',
      updated_by_id: 'system:lazy-init',
    };
    expect(rowToRecord(row).cooldownUntil).toBeNull();
  });
});

describe('rowToAuditEvent', () => {
  it('maps a Postgres audit row into a BreakerAuditEvent', () => {
    const row: BreakerAuditRow = {
      id: '11111111-1111-1111-1111-111111111111',
      tenant: 't1',
      environment: 'prod',
      agent_id: 'agent-1',
      from_state: 'armed',
      to_state: 'tripped',
      epoch_before: '0',
      epoch_after: '1',
      actor_type: 'system',
      actor_id: 'system:detector',
      reason: 'loop detected',
      correlation_id: 'corr-1',
      policy_version: 'v1',
      noop: false,
      created_at: new Date('2026-07-21T00:00:00.000Z'),
    };
    const event = rowToAuditEvent(row);
    expect(event.scope).toEqual({
      tenant: 't1',
      environment: 'prod',
      agentId: 'agent-1',
    });
    expect(event.epochBefore).toBe(0);
    expect(event.epochAfter).toBe(1);
    expect(event.noop).toBe(false);
    expect(event.createdAt).toBe('2026-07-21T00:00:00.000Z');
  });
});

describe('rowToPreflightResult', () => {
  it('maps a Postgres row into a PreflightResult, including nullable fields', () => {
    const row: PreflightStateRow = {
      tenant: 't1',
      environment: 'prod',
      agent_id: 'agent-1',
      state: 'degraded',
      reason_code: 'missing-required-fields',
      reason: 'required-field coverage 80.0%',
      evaluated_at: new Date('2026-07-21T00:00:00.000Z'),
      last_good_at: new Date('2026-07-20T23:55:00.000Z'),
      required_field_coverage_percent: 80,
      orphan_rate_percent: 0,
      freshness_ms: '1500',
      pending_recovery_state: 'protected',
      pending_since: new Date('2026-07-21T00:00:05.000Z'),
    };
    const result = rowToPreflightResult(row);
    expect(result).toEqual({
      scope: { tenant: 't1', environment: 'prod', agentId: 'agent-1' },
      state: 'degraded',
      reasonCode: 'missing-required-fields',
      reason: 'required-field coverage 80.0%',
      evaluatedAt: '2026-07-21T00:00:00.000Z',
      lastGoodAt: '2026-07-20T23:55:00.000Z',
      requiredFieldCoveragePercent: 80,
      orphanRatePercent: 0,
      freshnessMs: 1500,
      pendingRecoveryState: 'protected',
      pendingSince: '2026-07-21T00:00:05.000Z',
    });
  });

  it('maps null last_good_at/freshness_ms/pending fields to null, not undefined or NaN', () => {
    const row: PreflightStateRow = {
      tenant: 't1',
      environment: 'prod',
      agent_id: 'agent-1',
      state: 'blind',
      reason_code: 'no-signal',
      reason: 'no spans and no heartbeat observed',
      evaluated_at: new Date('2026-07-21T00:00:00.000Z'),
      last_good_at: null,
      required_field_coverage_percent: 0,
      orphan_rate_percent: 0,
      freshness_ms: null,
      pending_recovery_state: null,
      pending_since: null,
    };
    const result = rowToPreflightResult(row);
    expect(result.lastGoodAt).toBeNull();
    expect(result.freshnessMs).toBeNull();
    expect(result.pendingRecoveryState).toBeNull();
    expect(result.pendingSince).toBeNull();
  });
});
