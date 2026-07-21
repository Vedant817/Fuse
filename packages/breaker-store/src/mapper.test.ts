import { describe, expect, it } from 'vitest';
import {
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
