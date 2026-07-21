import type { Actor, BreakerRecord } from '@fuse/contracts';

export type NoopReason =
  | 'already-armed'
  | 'already-tripped'
  | 'already-disabled'
  | 'already-enabled'
  | 'breaker-disabled';

export type TransitionOutcome =
  | { ok: true; record: BreakerRecord; noop: false }
  | { ok: true; record: BreakerRecord; noop: true; noopReason: NoopReason }
  | { ok: false; code: 'invalid_transition' | 'cooldown_active'; message: string };

export interface TripInput {
  reason: string;
  policyVersion: string;
  cooldownSeconds: number;
  actor: Actor;
  now: Date;
}

export interface ResumeInput {
  reason: string;
  actor: Actor;
  now: Date;
}

export interface DisableInput {
  reason: string;
  actor: Actor;
  now: Date;
}

export interface EnableInput {
  reason: string;
  actor: Actor;
  now: Date;
}

export interface PermitDecision {
  allowed: boolean;
  state: BreakerRecord['state'];
  reason: string;
}

/**
 * Every function here is pure: given the same `current` record and `input`,
 * it always returns the same outcome. No clock reads other than the
 * caller-supplied `now`, no I/O. This is what makes every valid/invalid
 * transition exhaustively unit- and property-testable, and what lets
 * `breaker-store` layer atomicity on top without domain logic itself needing
 * to know about epochs-as-storage, retries, or concurrency.
 */

export function applyTrip(current: BreakerRecord, input: TripInput): TransitionOutcome {
  if (current.state === 'disabled') {
    return { ok: true, record: current, noop: true, noopReason: 'breaker-disabled' };
  }
  if (current.state === 'tripped') {
    return { ok: true, record: current, noop: true, noopReason: 'already-tripped' };
  }
  const cooldownUntil = new Date(input.now.getTime() + input.cooldownSeconds * 1000);
  return {
    ok: true,
    noop: false,
    record: {
      ...current,
      state: 'tripped',
      epoch: current.epoch + 1,
      reason: input.reason,
      policyVersion: input.policyVersion,
      cooldownUntil: cooldownUntil.toISOString(),
      updatedAt: input.now.toISOString(),
      updatedBy: input.actor,
    },
  };
}

export function applyResume(
  current: BreakerRecord,
  input: ResumeInput,
): TransitionOutcome {
  if (current.state === 'armed') {
    return { ok: true, record: current, noop: true, noopReason: 'already-armed' };
  }
  if (current.state === 'disabled') {
    return {
      ok: false,
      code: 'invalid_transition',
      message: 'breaker is disabled; use enable, not resume, to restore enforcement',
    };
  }
  const stillCoolingDown =
    input.actor.type !== 'manual' &&
    current.cooldownUntil !== null &&
    input.now.getTime() < new Date(current.cooldownUntil).getTime();
  if (stillCoolingDown) {
    return {
      ok: false,
      code: 'cooldown_active',
      message: `cooldown active until ${current.cooldownUntil}; only a manual resume may override it`,
    };
  }
  return {
    ok: true,
    noop: false,
    record: {
      ...current,
      state: 'armed',
      epoch: current.epoch + 1,
      reason: input.reason,
      cooldownUntil: null,
      updatedAt: input.now.toISOString(),
      updatedBy: input.actor,
    },
  };
}

export function applyDisable(
  current: BreakerRecord,
  input: DisableInput,
): TransitionOutcome {
  if (current.state === 'disabled') {
    return { ok: true, record: current, noop: true, noopReason: 'already-disabled' };
  }
  return {
    ok: true,
    noop: false,
    record: {
      ...current,
      state: 'disabled',
      epoch: current.epoch + 1,
      reason: input.reason,
      cooldownUntil: null,
      updatedAt: input.now.toISOString(),
      updatedBy: input.actor,
    },
  };
}

export function applyEnable(
  current: BreakerRecord,
  input: EnableInput,
): TransitionOutcome {
  if (current.state === 'armed') {
    return { ok: true, record: current, noop: true, noopReason: 'already-enabled' };
  }
  if (current.state === 'tripped') {
    return {
      ok: false,
      code: 'invalid_transition',
      message: 'breaker is tripped; use resume, not enable, to restore enforcement',
    };
  }
  return {
    ok: true,
    noop: false,
    record: {
      ...current,
      state: 'armed',
      epoch: current.epoch + 1,
      reason: input.reason,
      cooldownUntil: null,
      updatedAt: input.now.toISOString(),
      updatedBy: input.actor,
    },
  };
}

export function permit(current: BreakerRecord): PermitDecision {
  if (current.state === 'tripped') {
    return { allowed: false, state: current.state, reason: current.reason };
  }
  if (current.state === 'disabled') {
    return {
      allowed: true,
      state: current.state,
      reason: 'breaker disabled: enforcement off',
    };
  }
  return { allowed: true, state: current.state, reason: 'armed' };
}
