import { describe, expect, it } from 'vitest';
import {
  RegisterScopeRequestSchema,
  RegisterScopeResponseSchema,
} from './scope-registration.js';

const request = {
  scope: { tenant: 'tenant-a', environment: 'production', agentId: 'payments' },
  policyVersion: 'policy-v1',
  actor: { type: 'manual', id: 'operator:alice' },
  reason: 'approved production agent',
  correlationId: 'corr-register-1',
};

describe('scope registration contracts', () => {
  it('accepts a bounded operator registration request', () => {
    expect(RegisterScopeRequestSchema.parse(request)).toEqual(request);
  });

  it('rejects missing registration evidence and oversized policy versions', () => {
    expect(RegisterScopeRequestSchema.safeParse({ ...request, reason: '' }).success).toBe(
      false,
    );
    expect(
      RegisterScopeRequestSchema.safeParse({
        ...request,
        policyVersion: 'x'.repeat(201),
      }).success,
    ).toBe(false);
  });

  it('validates the idempotent registration response shape', () => {
    const registeredAt = '2026-07-23T12:00:00.000Z';
    expect(
      RegisterScopeResponseSchema.safeParse({
        registration: {
          scope: request.scope,
          policyVersion: request.policyVersion,
          registeredAt,
          registeredBy: request.actor,
          reason: request.reason,
        },
        breaker: {
          scope: request.scope,
          state: 'armed',
          epoch: 0,
          reason: request.reason,
          policyVersion: request.policyVersion,
          cooldownUntil: null,
          updatedAt: registeredAt,
          updatedBy: request.actor,
        },
        created: true,
      }).success,
    ).toBe(true);
  });
});
