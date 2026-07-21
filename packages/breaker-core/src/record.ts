import type { Actor, BreakerRecord, Scope } from '@fuse/contracts';

/** The record for a scope that has never been written before. Armed with
 * epoch 0 so the first-ever CAS write (`WHERE epoch = 0`) is well-defined. */
export function initialRecord(
  scope: Scope,
  policyVersion: string,
  now: Date,
  actor: Actor,
): BreakerRecord {
  return {
    scope,
    state: 'armed',
    epoch: 0,
    reason: 'initialized',
    policyVersion,
    cooldownUntil: null,
    updatedAt: now.toISOString(),
    updatedBy: actor,
  };
}
