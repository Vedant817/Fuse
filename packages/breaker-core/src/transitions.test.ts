import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Actor, BreakerRecord } from '@fuse/contracts';
import { initialRecord } from './record.js';
import {
  applyDisable,
  applyEnable,
  applyResume,
  applyTrip,
  permit,
} from './transitions.js';

const SCOPE = { tenant: 't1', environment: 'prod', agentId: 'agent-1' };
const SYSTEM_ACTOR: Actor = { type: 'system', id: 'system:test' };
const MANUAL_ACTOR: Actor = { type: 'manual', id: 'user:alice' };
const POLICY_ACTOR: Actor = { type: 'policy', id: 'policy:auto-resume' };
const NOW = new Date('2026-07-21T00:00:00.000Z');

function armed(overrides: Partial<BreakerRecord> = {}): BreakerRecord {
  return { ...initialRecord(SCOPE, 'v1', NOW, SYSTEM_ACTOR), ...overrides };
}

describe('applyTrip', () => {
  it('trips an armed breaker and increments epoch', () => {
    const current = armed();
    const outcome = applyTrip(current, {
      reason: 'loop detected',
      policyVersion: 'v1',
      cooldownSeconds: 300,
      actor: SYSTEM_ACTOR,
      now: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.noop).toBe(false);
    expect(outcome.record.state).toBe('tripped');
    expect(outcome.record.epoch).toBe(current.epoch + 1);
    expect(outcome.record.cooldownUntil).toBe('2026-07-21T00:05:00.000Z');
  });

  it('is idempotent: tripping an already-tripped breaker is a no-op', () => {
    const tripped = armed({
      state: 'tripped',
      epoch: 5,
      cooldownUntil: NOW.toISOString(),
    });
    const outcome = applyTrip(tripped, {
      reason: 'duplicate alert',
      policyVersion: 'v1',
      cooldownSeconds: 300,
      actor: SYSTEM_ACTOR,
      now: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    if (!outcome.noop) throw new Error('expected noop');
    expect(outcome.noopReason).toBe('already-tripped');
    expect(outcome.record.epoch).toBe(5); // unchanged
  });

  it('never enforces while disabled: trip is a no-op that leaves state disabled', () => {
    const disabled = armed({ state: 'disabled', epoch: 2 });
    const outcome = applyTrip(disabled, {
      reason: 'loop detected',
      policyVersion: 'v1',
      cooldownSeconds: 300,
      actor: SYSTEM_ACTOR,
      now: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    if (!outcome.noop) throw new Error('expected noop');
    expect(outcome.noopReason).toBe('breaker-disabled');
    expect(outcome.record.state).toBe('disabled');
    expect(outcome.record.epoch).toBe(2);
  });
});

describe('applyResume', () => {
  it('resumes a tripped breaker back to armed', () => {
    const tripped = armed({ state: 'tripped', epoch: 3, cooldownUntil: null });
    const outcome = applyResume(tripped, {
      reason: 'fix deployed',
      actor: MANUAL_ACTOR,
      now: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.noop).toBe(false);
    expect(outcome.record.state).toBe('armed');
    expect(outcome.record.epoch).toBe(4);
    expect(outcome.record.cooldownUntil).toBeNull();
  });

  it('is idempotent: resuming an already-armed breaker is a no-op', () => {
    const outcome = applyResume(armed({ epoch: 7 }), {
      reason: 'noop',
      actor: MANUAL_ACTOR,
      now: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    if (!outcome.noop) throw new Error('expected noop');
    expect(outcome.noopReason).toBe('already-armed');
    expect(outcome.record.epoch).toBe(7);
  });

  it('rejects resume on a disabled breaker (must use enable instead)', () => {
    const disabled = armed({ state: 'disabled', epoch: 1 });
    const outcome = applyResume(disabled, { reason: 'x', actor: MANUAL_ACTOR, now: NOW });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.code).toBe('invalid_transition');
  });

  it('rejects a policy-driven resume before cooldown elapses', () => {
    const cooldownUntil = new Date(NOW.getTime() + 60_000).toISOString();
    const tripped = armed({ state: 'tripped', epoch: 3, cooldownUntil });
    const outcome = applyResume(tripped, {
      reason: 'auto',
      actor: POLICY_ACTOR,
      now: NOW,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.code).toBe('cooldown_active');
  });

  it('never auto-resumes on a bare timer: cooldown elapsing alone does not resume anything', () => {
    // There is no function in this module that takes only `now` and a
    // cooldown and produces an armed state without an explicit resume call.
    // This test documents the invariant: `permit()` on a tripped record
    // whose cooldown has elapsed must still deny, because only an explicit
    // applyResume() call changes state.
    const cooldownUntil = new Date(NOW.getTime() - 1_000).toISOString(); // already elapsed
    const tripped = armed({ state: 'tripped', epoch: 3, cooldownUntil });
    const decision = permit(tripped);
    expect(decision.allowed).toBe(false);
  });

  it('allows a manual resume to override an active cooldown', () => {
    const cooldownUntil = new Date(NOW.getTime() + 60_000).toISOString();
    const tripped = armed({ state: 'tripped', epoch: 3, cooldownUntil });
    const outcome = applyResume(tripped, {
      reason: 'manual override',
      actor: MANUAL_ACTOR,
      now: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.noop).toBe(false);
    expect(outcome.record.state).toBe('armed');
  });
});

describe('applyDisable / applyEnable', () => {
  it('disables from armed and from tripped', () => {
    for (const state of ['armed', 'tripped'] as const) {
      const current = armed({ state, epoch: 1 });
      const outcome = applyDisable(current, {
        reason: 'maintenance',
        actor: MANUAL_ACTOR,
        now: NOW,
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error('unreachable');
      expect(outcome.record.state).toBe('disabled');
      expect(outcome.record.epoch).toBe(2);
    }
  });

  it('disable is idempotent', () => {
    const disabled = armed({ state: 'disabled', epoch: 4 });
    const outcome = applyDisable(disabled, {
      reason: 'again',
      actor: MANUAL_ACTOR,
      now: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.noop).toBe(true);
    expect(outcome.record.epoch).toBe(4);
  });

  it('enable restores armed from disabled', () => {
    const disabled = armed({ state: 'disabled', epoch: 4 });
    const outcome = applyEnable(disabled, {
      reason: 'back online',
      actor: MANUAL_ACTOR,
      now: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.record.state).toBe('armed');
    expect(outcome.record.epoch).toBe(5);
  });

  it('rejects enable on a tripped breaker (must use resume instead)', () => {
    const tripped = armed({ state: 'tripped', epoch: 2 });
    const outcome = applyEnable(tripped, { reason: 'x', actor: MANUAL_ACTOR, now: NOW });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.code).toBe('invalid_transition');
  });
});

describe('permit', () => {
  it('denies only when tripped', () => {
    expect(permit(armed({ state: 'armed' })).allowed).toBe(true);
    expect(permit(armed({ state: 'disabled' })).allowed).toBe(true);
    expect(permit(armed({ state: 'tripped' })).allowed).toBe(false);
  });
});

describe('property: epoch monotonicity and disabled-never-enforces', () => {
  const actorArb = fc.constantFrom(SYSTEM_ACTOR, MANUAL_ACTOR, POLICY_ACTOR);
  const stateArb = fc.constantFrom<BreakerRecord['state']>(
    'armed',
    'tripped',
    'disabled',
  );

  it('epoch never decreases and only changes on a real (non-noop) transition', () => {
    fc.assert(
      fc.property(
        stateArb,
        actorArb,
        fc.integer({ min: 0, max: 10_000 }),
        (state, actor, epoch) => {
          const current = armed({ state, epoch });
          const outcome = applyTrip(current, {
            reason: 'r',
            policyVersion: 'v1',
            cooldownSeconds: 60,
            actor,
            now: NOW,
          });
          if (!outcome.ok) return true;
          if (outcome.noop) {
            return outcome.record.epoch === epoch;
          }
          return outcome.record.epoch === epoch + 1;
        },
      ),
    );
  });

  it('a disabled breaker is never moved to tripped by applyTrip, for any actor/reason', () => {
    fc.assert(
      fc.property(actorArb, fc.string(), (actor, reason) => {
        const disabled = armed({ state: 'disabled', epoch: 42 });
        const outcome = applyTrip(disabled, {
          reason,
          policyVersion: 'v1',
          cooldownSeconds: 60,
          actor,
          now: NOW,
        });
        return outcome.ok && outcome.record.state === 'disabled';
      }),
    );
  });
});
