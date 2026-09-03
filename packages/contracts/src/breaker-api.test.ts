import { describe, expect, it } from 'vitest';
import {
  DisableRequestSchema,
  EnableRequestSchema,
  PermitRequestSchema,
  ResumeRequestSchema,
  TripRequestSchema,
} from './breaker-api.js';

const SCOPE = { tenant: 't1', environment: 'prod', agentId: 'agent-1' };
const ACTOR = { type: 'manual' as const, id: 'user:alice' };

describe('PermitRequestSchema', () => {
  it('accepts a valid permit request', () => {
    const result = PermitRequestSchema.safeParse({
      scope: SCOPE,
      correlationId: 'corr-1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing scope', () => {
    const result = PermitRequestSchema.safeParse({ correlationId: 'corr-1' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty agentId', () => {
    const result = PermitRequestSchema.safeParse({
      scope: { ...SCOPE, agentId: '' },
      correlationId: 'corr-1',
    });
    expect(result.success).toBe(false);
  });
});

describe('TripRequestSchema', () => {
  const valid = {
    scope: SCOPE,
    reason: 'loop detected',
    policyVersion: 'demo-hardcoded-threshold-v1',
    cooldownSeconds: 60,
    actor: ACTOR,
    correlationId: 'corr-1',
    idempotencyKey: 'idem-1',
  };

  it('accepts a fully valid trip request', () => {
    expect(TripRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a negative cooldown', () => {
    expect(TripRequestSchema.safeParse({ ...valid, cooldownSeconds: -1 }).success).toBe(
      false,
    );
  });

  it('rejects an oversized reason string', () => {
    expect(
      TripRequestSchema.safeParse({ ...valid, reason: 'x'.repeat(3000) }).success,
    ).toBe(false);
  });

  it('rejects an invalid actor type', () => {
    expect(
      TripRequestSchema.safeParse({
        ...valid,
        actor: { type: 'root', id: 'x' },
      }).success,
    ).toBe(false);
  });

  it('rejects a missing idempotency key', () => {
    const { idempotencyKey: _idempotencyKey, ...rest } = valid;
    expect(TripRequestSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects extra/unexpected top-level junk masquerading as scope', () => {
    expect(
      TripRequestSchema.safeParse({ ...valid, scope: 'not-an-object' }).success,
    ).toBe(false);
  });
});

describe('epoch-bound operator mutation schemas', () => {
  const valid = {
    scope: SCOPE,
    reason: 'operator action',
    actor: ACTOR,
    correlationId: 'c',
    idempotencyKey: 'k',
    expectedEpoch: 7,
  };

  it.each([
    ['resume', ResumeRequestSchema],
    ['disable', DisableRequestSchema],
    ['enable', EnableRequestSchema],
  ] as const)('requires a safe expectedEpoch for %s', (_name, schema) => {
    expect(schema.safeParse(valid).success).toBe(true);

    const { expectedEpoch: _expectedEpoch, ...unbound } = valid;
    expect(schema.safeParse(unbound).success).toBe(false);
    expect(schema.safeParse({ ...valid, expectedEpoch: -1 }).success).toBe(false);
    expect(
      schema.safeParse({ ...valid, expectedEpoch: Number.MAX_SAFE_INTEGER + 1 }).success,
    ).toBe(false);
  });

  it('rejects resume with an empty reason', () => {
    expect(
      ResumeRequestSchema.safeParse({
        ...valid,
        reason: '',
      }).success,
    ).toBe(false);
  });

  it('rejects disable with a non-string idempotency key', () => {
    expect(
      DisableRequestSchema.safeParse({
        ...valid,
        reason: 'maintenance',
        idempotencyKey: 12345,
      }).success,
    ).toBe(false);
  });
});
