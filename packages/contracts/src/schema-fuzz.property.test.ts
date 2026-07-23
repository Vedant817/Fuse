import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  PermitRequestSchema,
  TripRequestSchema,
  ResumeRequestSchema,
} from './breaker-api.js';
import { SignozAlertmanagerWebhookPayloadSchema } from './alert-webhook.js';
import { DetectorResultSchema } from './detector.js';
import { ScopeSchema } from './scope.js';
import { PolicySchema } from './policy.js';

/**
 * task.md §10.1 "Property/fuzz: ... schema/parser boundaries ... malformed
 * webhook input". Every route in this system rejects an invalid body via
 * `Schema.safeParse` (never a raw `.parse`, per every route file in
 * services/control-plane/src/routes/) specifically so a malformed request
 * becomes a clean 400, never an unhandled exception. This test fuzzes each
 * schema with `fc.anything()` — arbitrary JSON-shaped garbage, not just the
 * handful of malformed-body cases the integration tests hand-construct —
 * and asserts `safeParse` itself never throws, regardless of input shape.
 * A schema that DOES throw on `safeParse` would turn a malformed request
 * into an unhandled 500 (or worse, a crashed process) instead of the clean
 * 400 the route layer expects to be able to rely on unconditionally.
 */

const SCHEMAS_UNDER_TEST: Array<{
  name: string;
  schema: { safeParse: (v: unknown) => unknown };
}> = [
  { name: 'ScopeSchema', schema: ScopeSchema },
  { name: 'PermitRequestSchema', schema: PermitRequestSchema },
  { name: 'TripRequestSchema', schema: TripRequestSchema },
  { name: 'ResumeRequestSchema', schema: ResumeRequestSchema },
  { name: 'DetectorResultSchema', schema: DetectorResultSchema },
  {
    name: 'SignozAlertmanagerWebhookPayloadSchema',
    schema: SignozAlertmanagerWebhookPayloadSchema,
  },
  { name: 'PolicySchema', schema: PolicySchema },
];

describe('schema safeParse never throws on arbitrary input (task.md §10.1 property/fuzz)', () => {
  for (const { name, schema } of SCHEMAS_UNDER_TEST) {
    it(`${name}.safeParse never throws, for arbitrary JSON-shaped garbage`, () => {
      fc.assert(
        fc.property(fc.anything(), (garbage) => {
          expect(() => schema.safeParse(garbage)).not.toThrow();
        }),
      );
    });

    it(`${name}.safeParse never throws on deeply nested/circular-ish structures`, () => {
      fc.assert(
        fc.property(fc.object({ maxDepth: 6, maxKeys: 8 }), (obj) => {
          expect(() => schema.safeParse(obj)).not.toThrow();
        }),
      );
    });
  }

  it('a webhook payload with an absurd number of alerts is rejected, not accepted (the 200-alert cap)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 201, max: 5000 }), (count) => {
        const payload = {
          receiver: 'fuse',
          status: 'firing',
          alerts: Array.from({ length: count }, (_, i) => ({
            status: 'firing',
            labels: {
              alertname: 'x',
              fuse_tenant: 't',
              fuse_environment: 'e',
              fuse_agent_id: `a${i}`,
            },
            annotations: {},
            startsAt: new Date().toISOString(),
            fingerprint: `fp-${i}`,
          })),
        };
        const result = SignozAlertmanagerWebhookPayloadSchema.safeParse(payload);
        expect(result.success).toBe(false);
      }),
    );
  });
});
