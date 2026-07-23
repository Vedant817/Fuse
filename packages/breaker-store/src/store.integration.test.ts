import { randomUUID } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor, Scope } from '@fuse/contracts';
import {
  IdempotencyConflictError,
  ScopeCapacityExceededError,
  StoreUnavailableError,
  UnknownScopeError,
} from './errors.js';
import { runMigrations } from './migrate.js';
import { BreakerStore } from './store.js';

const MANUAL_ACTOR: Actor = { type: 'manual', id: 'user:alice' };
const SYSTEM_ACTOR: Actor = { type: 'system', id: 'system:detector' };
const POLICY_ACTOR: Actor = { type: 'policy', id: 'policy:auto-resume' };

function scopeFor(name: string): Scope {
  return {
    tenant: 't1',
    environment: 'test',
    agentId: `agent-${name}-${randomUUID().slice(0, 8)}`,
  };
}

describe('BreakerStore (Postgres integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let store: BreakerStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool);
    store = new BreakerStore(pool);
  }, 120_000);

  async function register(scope: Scope, targetStore = store): Promise<Scope> {
    await targetStore.registerScope({
      scope,
      policyVersion: 'test-policy-v1',
      actor: MANUAL_ACTOR,
      reason: 'integration test registration',
      correlationId: `register-${scope.agentId}`,
    });
    return scope;
  }

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('rejects an unseen scope without creating a durable row, then permits it after explicit registration', async () => {
    const scope = scopeFor('lazy-init');
    await expect(store.permit(scope, 'corr-unknown')).rejects.toThrow(UnknownScopeError);
    const beforeRegistration = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM breaker_state
        WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
      [scope.tenant, scope.environment, scope.agentId],
    );
    expect(beforeRegistration.rows[0]?.count).toBe('0');

    const registration = await store.registerScope({
      scope,
      policyVersion: 'test-policy-v1',
      actor: MANUAL_ACTOR,
      reason: 'approved test scope',
      correlationId: 'corr-register',
    });
    expect(registration.created).toBe(true);
    const result = await store.permit(scope, 'corr-1');
    expect(result.allowed).toBe(true);
    expect(result.state).toBe('armed');
    expect(result.epoch).toBe(0);
  });

  it('trips a breaker and denies the next permit check', async () => {
    const scope = await register(scopeFor('trip-then-deny'));
    await store.permit(scope, 'corr-0');

    const tripResult = await store.trip({
      scope,
      reason: 'loop detected',
      policyVersion: 'demo-hardcoded-threshold-v1',
      cooldownSeconds: 60,
      actor: SYSTEM_ACTOR,
      correlationId: 'corr-1',
      idempotencyKey: 'idem-trip-1',
    });
    expect(tripResult.kind).toBe('applied');
    if (tripResult.kind !== 'applied') throw new Error('unreachable');
    expect(tripResult.record.state).toBe('tripped');
    expect(tripResult.noop).toBe(false);

    const permitResult = await store.permit(scope, 'corr-2');
    expect(permitResult.allowed).toBe(false);
    expect(permitResult.state).toBe('tripped');
  });

  it('duplicate trip delivery (same idempotency key) returns the original outcome, not a new transition', async () => {
    const scope = await register(scopeFor('dup-trip'));
    const req = {
      scope,
      reason: 'loop detected',
      policyVersion: 'demo-hardcoded-threshold-v1',
      cooldownSeconds: 60,
      actor: SYSTEM_ACTOR,
      correlationId: 'corr-1',
      idempotencyKey: 'idem-dup-1',
    };
    const first = await store.trip(req);
    const second = await store.trip(req);
    if (first.kind !== 'applied' || second.kind !== 'applied') {
      throw new Error('unreachable');
    }
    expect(first.replayed).toBeUndefined();
    expect(second.replayed).toBe(true);
    const { replayed: _replayed, ...secondOutcome } = second;
    expect(secondOutcome).toEqual(first);
    expect(first.record.epoch).toBe(1); // only one real transition happened
  });

  it('reusing an idempotency key with a different request body is rejected', async () => {
    const scope = await register(scopeFor('idem-conflict'));
    const base = {
      scope,
      policyVersion: 'demo-hardcoded-threshold-v1',
      cooldownSeconds: 60,
      actor: SYSTEM_ACTOR,
      correlationId: 'corr-1',
      idempotencyKey: 'idem-conflict-1',
    };
    await store.trip({ ...base, reason: 'loop detected' });
    await expect(
      store.trip({ ...base, reason: 'different reason entirely' }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('is idempotent at the domain level too: tripping an already-tripped breaker with a new key no-ops without changing epoch', async () => {
    const scope = await register(scopeFor('already-tripped-noop'));
    await store.trip({
      scope,
      reason: 'first alert',
      policyVersion: 'v1',
      cooldownSeconds: 60,
      actor: SYSTEM_ACTOR,
      correlationId: 'corr-1',
      idempotencyKey: 'idem-a',
    });
    const second = await store.trip({
      scope,
      reason: 'second alert, different detector',
      policyVersion: 'v1',
      cooldownSeconds: 60,
      actor: SYSTEM_ACTOR,
      correlationId: 'corr-2',
      idempotencyKey: 'idem-b',
    });
    expect(second.kind).toBe('applied');
    if (second.kind !== 'applied') throw new Error('unreachable');
    expect(second.noop).toBe(true);
    expect(second.record.epoch).toBe(1); // unchanged from the first trip
  });

  it('rejects a policy-driven resume during cooldown but allows manual override', async () => {
    const scope = await register(scopeFor('cooldown'));
    await store.trip({
      scope,
      reason: 'loop',
      policyVersion: 'v1',
      cooldownSeconds: 3600,
      actor: SYSTEM_ACTOR,
      correlationId: 'corr-1',
      idempotencyKey: 'idem-trip',
    });

    const policyResume = await store.resume({
      scope,
      reason: 'auto-resume attempt',
      actor: POLICY_ACTOR,
      correlationId: 'corr-2',
      idempotencyKey: 'idem-resume-policy',
    });
    expect(policyResume.kind).toBe('rejected');
    if (policyResume.kind !== 'rejected') throw new Error('unreachable');
    expect(policyResume.code).toBe('cooldown_active');

    const manualResume = await store.resume({
      scope,
      reason: 'human verified the fix',
      actor: MANUAL_ACTOR,
      correlationId: 'corr-3',
      idempotencyKey: 'idem-resume-manual',
    });
    expect(manualResume.kind).toBe('applied');
    if (manualResume.kind !== 'applied') throw new Error('unreachable');
    expect(manualResume.record.state).toBe('armed');

    const permitAfter = await store.permit(scope, 'corr-4');
    expect(permitAfter.allowed).toBe(true);
  });

  it('disable overrides enforcement even while tripped, and trip attempts while disabled stay quiet', async () => {
    const scope = await register(scopeFor('disable-override'));
    await store.trip({
      scope,
      reason: 'loop',
      policyVersion: 'v1',
      cooldownSeconds: 60,
      actor: SYSTEM_ACTOR,
      correlationId: 'corr-1',
      idempotencyKey: 'idem-trip',
    });
    const disableResult = await store.disable({
      scope,
      reason: 'maintenance window',
      actor: MANUAL_ACTOR,
      correlationId: 'corr-2',
      idempotencyKey: 'idem-disable',
    });
    expect(disableResult.kind).toBe('applied');
    if (disableResult.kind !== 'applied') throw new Error('unreachable');
    expect(disableResult.record.state).toBe('disabled');

    const permitWhileDisabled = await store.permit(scope, 'corr-3');
    expect(permitWhileDisabled.allowed).toBe(true);

    const tripWhileDisabled = await store.trip({
      scope,
      reason: 'another alert fires',
      policyVersion: 'v1',
      cooldownSeconds: 60,
      actor: SYSTEM_ACTOR,
      correlationId: 'corr-4',
      idempotencyKey: 'idem-trip-2',
    });
    expect(tripWhileDisabled.kind).toBe('applied');
    if (tripWhileDisabled.kind !== 'applied') throw new Error('unreachable');
    expect(tripWhileDisabled.noop).toBe(true);
    expect(tripWhileDisabled.record.state).toBe('disabled');

    const permitStillAllowed = await store.permit(scope, 'corr-5');
    expect(permitStillAllowed.allowed).toBe(true);
  });

  it('a stale expectedEpoch is rejected rather than silently applied', async () => {
    const scope = await register(scopeFor('stale-epoch'));
    await store.permit(scope, 'corr-0'); // creates epoch 0
    const result = await store.trip({
      scope,
      reason: 'x',
      policyVersion: 'v1',
      cooldownSeconds: 60,
      actor: SYSTEM_ACTOR,
      correlationId: 'corr-1',
      idempotencyKey: 'idem-stale',
      expectedEpoch: 7,
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('unreachable');
    expect(result.code).toBe('stale_epoch');
  });

  it('survives concurrent trip requests for the same scope: exactly one real transition, rest no-op', async () => {
    const scope = await register(scopeFor('concurrent-trip'));
    await store.permit(scope, 'corr-0');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.trip({
          scope,
          reason: `concurrent alert ${i}`,
          policyVersion: 'v1',
          cooldownSeconds: 60,
          actor: SYSTEM_ACTOR,
          correlationId: `corr-${i}`,
          idempotencyKey: `idem-concurrent-${i}`,
        }),
      ),
    );
    const applied = results.filter((r) => r.kind === 'applied');
    expect(applied).toHaveLength(10);
    const realTransitions = applied.filter((r) => r.kind === 'applied' && !r.noop);
    expect(realTransitions).toHaveLength(1); // only the first-to-commit actually transitions

    const finalRecord = await store.getRecord(scope);
    expect(finalRecord?.state).toBe('tripped');
    expect(finalRecord?.epoch).toBe(1); // never double-incremented despite 10 concurrent callers
  });

  it('N truly concurrent requests sharing the SAME idempotency key produce exactly one audit row', async () => {
    // Regression test for a real race found in adversarial review: without
    // serializing same-key requests, every CAS-loser that recomputed a
    // no-op outcome before discovering (via the idempotency insert's
    // ON CONFLICT) that it should have replayed the winner's response would
    // still commit its own audit_log row first — fabricating phantom
    // "duplicate observed" audit entries for what was actually one event.
    const scope = await register(scopeFor('same-key-concurrent'));
    await store.permit(scope, 'corr-0');
    const idempotencyKey = `idem-samekey-${randomUUID()}`;
    const req = {
      scope,
      reason: 'loop detected',
      policyVersion: 'v1',
      cooldownSeconds: 60,
      actor: SYSTEM_ACTOR,
      correlationId: 'corr-1',
      idempotencyKey,
    };
    const N = 8;
    const results = await Promise.all(Array.from({ length: N }, () => store.trip(req)));

    // Every caller observes identical domain data, but only the invocation
    // that committed is marked non-replayed so downstream side effects run
    // exactly once.
    const originals = results.filter(
      (result) => result.kind === 'applied' && result.replayed !== true,
    );
    expect(originals).toHaveLength(1);
    const first = originals[0]!;
    for (const result of results) {
      if (result.kind !== 'applied') throw new Error('unreachable');
      const { replayed: _replayed, ...domainResult } = result;
      expect(domainResult).toEqual(first);
    }

    // Exactly one real state transition occurred.
    const record = await store.getRecord(scope);
    expect(record?.epoch).toBe(1);

    // The load-bearing assertion: exactly one audit row, not one-per-racer.
    const auditRows = await pool.query(
      `SELECT noop FROM breaker_audit_log
       WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
      [scope.tenant, scope.environment, scope.agentId],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0].noop).toBe(false);
  });

  it('concurrent trips with distinct actors/reasons/correlationIds: every response and every persisted audit row reflects its OWN caller, not the winner (regression for actor/reason/correlationId mismatch bug)', async () => {
    const scope = await register(scopeFor('actor-mismatch'));
    await store.permit(scope, 'corr-0');

    const callers = ['A', 'B', 'C'].map((label) => ({
      label,
      actor: { type: 'system', id: `system:detector-${label}` } as Actor,
      reason: `unique reason ${label}`,
      correlationId: `corr-${label}`,
      idempotencyKey: `idem-mismatch-${label}`,
    }));

    const results = await Promise.all(
      callers.map((c) =>
        store.trip({
          scope,
          reason: c.reason,
          policyVersion: 'v1',
          cooldownSeconds: 60,
          actor: c.actor,
          correlationId: c.correlationId,
          idempotencyKey: c.idempotencyKey,
        }),
      ),
    );

    const applied = results.filter((r) => r.kind === 'applied');
    expect(applied).toHaveLength(3);
    const realTransitions = applied.filter((r) => r.kind === 'applied' && !r.noop);
    expect(realTransitions).toHaveLength(1); // exactly one real transition wins the race

    for (let i = 0; i < callers.length; i++) {
      const c = callers[i]!;
      const r = results[i]!;
      if (r.kind !== 'applied') throw new Error('unreachable');
      // The response over the wire must match THIS caller's own submitted
      // identity, never a co-racer's, whether this caller won or lost.
      expect(r.auditEvent.actor).toEqual(c.actor);
      expect(r.auditEvent.reason).toBe(c.reason);
      expect(r.auditEvent.correlationId).toBe(c.correlationId);
      if (r.noop) {
        expect(r.auditEvent.fromState).toBe(r.auditEvent.toState);
        expect(r.auditEvent.epochBefore).toBe(r.auditEvent.epochAfter);
      } else {
        expect(r.auditEvent.fromState).not.toBe(r.auditEvent.toState);
        expect(r.auditEvent.epochAfter).toBe(r.auditEvent.epochBefore + 1);
      }
    }

    // Confirm the SAME is true of what's actually persisted, independent of
    // what was handed back over the wire.
    const auditRows = await pool.query<{
      actor_type: string;
      actor_id: string;
      reason: string;
      correlation_id: string;
      from_state: string;
      to_state: string;
      noop: boolean;
    }>(
      `SELECT actor_type, actor_id, reason, correlation_id, from_state, to_state, noop
       FROM breaker_audit_log
       WHERE tenant=$1 AND environment=$2 AND agent_id=$3`,
      [scope.tenant, scope.environment, scope.agentId],
    );
    expect(auditRows.rows).toHaveLength(3);
    for (const c of callers) {
      const row = auditRows.rows.find((r) => r.correlation_id === c.correlationId);
      expect(row).toBeDefined();
      expect(row!.actor_type).toBe(c.actor.type);
      expect(row!.actor_id).toBe(c.actor.id);
      expect(row!.reason).toBe(c.reason);
    }

    const finalRecord = await store.getRecord(scope);
    expect(finalRecord?.state).toBe('tripped');
    expect(finalRecord?.epoch).toBe(1);
  });

  it('noopReason is populated for no-op transitions (already-tripped, breaker-disabled) and absent for a genuine transition', async () => {
    const scope = await register(scopeFor('noop-reason'));

    const realTrip = await store.trip({
      scope,
      reason: 'first alert',
      policyVersion: 'v1',
      cooldownSeconds: 60,
      actor: SYSTEM_ACTOR,
      correlationId: 'corr-1',
      idempotencyKey: 'idem-real-trip',
    });
    expect(realTrip.kind).toBe('applied');
    if (realTrip.kind !== 'applied') throw new Error('unreachable');
    expect(realTrip.noop).toBe(false);
    expect(realTrip.noopReason).toBeUndefined();

    const alreadyTripped = await store.trip({
      scope,
      reason: 'second alert, different detector',
      policyVersion: 'v1',
      cooldownSeconds: 60,
      actor: SYSTEM_ACTOR,
      correlationId: 'corr-2',
      idempotencyKey: 'idem-noop-already-tripped',
    });
    expect(alreadyTripped.kind).toBe('applied');
    if (alreadyTripped.kind !== 'applied') throw new Error('unreachable');
    expect(alreadyTripped.noop).toBe(true);
    expect(alreadyTripped.noopReason).toBe('already-tripped');

    const disableResult = await store.disable({
      scope,
      reason: 'maintenance window',
      actor: MANUAL_ACTOR,
      correlationId: 'corr-3',
      idempotencyKey: 'idem-disable',
    });
    expect(disableResult.kind).toBe('applied');
    if (disableResult.kind !== 'applied') throw new Error('unreachable');
    expect(disableResult.noop).toBe(false);
    expect(disableResult.noopReason).toBeUndefined();

    const tripWhileDisabled = await store.trip({
      scope,
      reason: 'alert fires while disabled',
      policyVersion: 'v1',
      cooldownSeconds: 60,
      actor: SYSTEM_ACTOR,
      correlationId: 'corr-4',
      idempotencyKey: 'idem-noop-disabled',
    });
    expect(tripWhileDisabled.kind).toBe('applied');
    if (tripWhileDisabled.kind !== 'applied') throw new Error('unreachable');
    expect(tripWhileDisabled.noop).toBe(true);
    expect(tripWhileDisabled.noopReason).toBe('breaker-disabled');
  });

  it('restart recovery: a new BreakerStore instance against the same database sees the persisted state', async () => {
    const scope = await register(scopeFor('restart-recovery'));
    await store.trip({
      scope,
      reason: 'loop',
      policyVersion: 'v1',
      cooldownSeconds: 60,
      actor: SYSTEM_ACTOR,
      correlationId: 'corr-1',
      idempotencyKey: 'idem-1',
    });

    // Simulate a process restart: brand-new pool + store, no shared memory.
    const freshPool = new pg.Pool({ connectionString: container.getConnectionUri() });
    try {
      const freshStore = new BreakerStore(freshPool);
      const record = await freshStore.getRecord(scope);
      expect(record?.state).toBe('tripped');
      const permitResult = await freshStore.permit(scope, 'corr-2');
      expect(permitResult.allowed).toBe(false);
    } finally {
      await freshPool.end();
    }
  });

  it('surfaces a StoreUnavailableError (not a generic crash) when Postgres is unreachable', async () => {
    const deadPool = new pg.Pool({
      connectionString: 'postgres://fuse:fuse@127.0.0.1:1/fuse',
      connectionTimeoutMillis: 500,
    });
    const deadStore = new BreakerStore(deadPool);
    try {
      await expect(deadStore.permit(scopeFor('unreachable'), 'corr-1')).rejects.toThrow(
        StoreUnavailableError,
      );
    } finally {
      await deadPool.end();
    }
  });

  it('registerScope is idempotent and preserves the original registration evidence', async () => {
    const scope = scopeFor('registration-idempotency');
    const first = await store.registerScope({
      scope,
      policyVersion: 'policy-original',
      actor: MANUAL_ACTOR,
      reason: 'original approval',
      correlationId: 'corr-original',
    });
    const replay = await store.registerScope({
      scope,
      policyVersion: 'policy-different',
      actor: { type: 'manual', id: 'user:bob' },
      reason: 'later duplicate',
      correlationId: 'corr-replay',
    });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.registration).toEqual(first.registration);
    expect(replay.breaker).toEqual(first.breaker);
  });

  it('serializes concurrent registrations so they cannot race past the per-tenant cap', async () => {
    const tenant = `capacity-${randomUUID()}`;
    const cappedStore = new BreakerStore(pool, () => new Date(), 2);
    const scopes = ['a', 'b', 'c'].map((agentId) => ({
      tenant,
      environment: 'test',
      agentId,
    }));
    const outcomes = await Promise.allSettled(
      scopes.map((scope) =>
        cappedStore.registerScope({
          scope,
          policyVersion: 'v1',
          actor: MANUAL_ACTOR,
          reason: 'capacity race',
          correlationId: `corr-${scope.agentId}`,
        }),
      ),
    );

    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const rejected = outcomes.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ScopeCapacityExceededError);

    const persisted = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM registered_scopes WHERE tenant=$1',
      [tenant],
    );
    expect(persisted.rows[0]?.count).toBe('2');
  });
});
