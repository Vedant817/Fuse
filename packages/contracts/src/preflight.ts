import { z } from 'zod';
import { ScopeSchema } from './scope.js';

/**
 * `protected` — recent telemetry has the required fields, low orphan
 *   rate, and is fresh enough to trust right now.
 * `degraded`  — telemetry is arriving but incomplete (some required
 *   fields missing, or some orphan spans) — the breaker may be making
 *   decisions on partial evidence.
 * `blind`     — telemetry is too broken (or absent, with no heartbeat
 *   confirming the agent is even alive) to trust at all; the breaker's
 *   decisions for this scope should be treated as unverified.
 * `disabled`  — an operator has explicitly turned Preflight monitoring
 *   off for this scope (e.g. a known maintenance window) — distinct from
 *   `blind`, which is an involuntary, alarming condition.
 *
 * This is deliberately a different enum from `BreakerStateSchema` — a
 * scope's *enforcement* state (armed/tripped/disabled) and its *telemetry
 * trust* state are independent axes, and conflating them would make it
 * impossible to express "breaker is armed, but we can't actually trust
 * that decision because telemetry is blind."
 */
export const PreflightStateSchema = z.enum([
  'protected',
  'degraded',
  'blind',
  'disabled',
]);
export type PreflightState = z.infer<typeof PreflightStateSchema>;

export const PreflightReasonCodeSchema = z.enum([
  'healthy',
  'missing-required-fields',
  'orphan-spans-detected',
  'exporter-delivery-unconfirmed',
  'exporter-delivery-failed',
  'exporter-delivery-stale',
  'no-recent-telemetry',
  'stale-evidence',
  'no-signal',
  'operator-disabled',
  'recovering',
]);
export type PreflightReasonCode = z.infer<typeof PreflightReasonCodeSchema>;

/** Mirrors `@fuse/preflight`'s `SpanTelemetrySample` as a validated wire
 * schema — kept here (not in `@fuse/preflight`) since only `@fuse/contracts`
 * sits at every external boundary. */
export const SpanTelemetrySampleSchema = z.object({
  timestampMs: z.number().int().nonnegative(),
  hasRequestModel: z.boolean(),
  hasInputTokens: z.boolean(),
  hasOutputTokens: z.boolean(),
  hasScopedIdentity: z.boolean(),
  hasValidTimestamps: z.boolean(),
  isRootSpan: z.boolean(),
  hasParent: z.boolean(),
});
export type SpanTelemetrySampleWire = z.infer<typeof SpanTelemetrySampleSchema>;

export const HeartbeatSignalSchema = z.object({
  lastSeenAtMs: z.number().int().nonnegative(),
});

/** Result claimed by the supported OTLP exporter wrapper for one trace-export
 * attempt. `success` means the configured endpoint acknowledged the batch as
 * observed by that wrapper; it is not cryptographic proof from the backend. */
export const ExporterDeliverySignalSchema = z.object({
  status: z.enum(['success', 'failure']),
  observedAtMs: z.number().int().nonnegative(),
  sourceInstanceId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type ExporterDeliverySignal = z.infer<typeof ExporterDeliverySignalSchema>;

/**
 * Orders exporter evidence only within one source instance. Reporter wall
 * clocks are not comparable across processes; callers must persist and
 * aggregate distinct source instances independently. A same-sequence failure
 * wins over success so a conflicting callback cannot hide an exporter error.
 * Distinct sources return 0 to mean "not comparable".
 */
export function compareExporterDeliverySignals(
  left: ExporterDeliverySignal,
  right: ExporterDeliverySignal,
): number {
  if (left.sourceInstanceId === right.sourceInstanceId) {
    if (left.sequence !== right.sequence) {
      return left.sequence < right.sequence ? -1 : 1;
    }
    if (left.status !== right.status) return left.status === 'failure' ? 1 : -1;
    return 0;
  }
  return 0;
}

export const PreflightReportRequestSchema = z
  .object({
    scope: ScopeSchema,
    spans: z.array(SpanTelemetrySampleSchema).max(2000),
    heartbeat: HeartbeatSignalSchema.optional(),
    /** Re-evaluate previously reported evidence against the current clock.
     * This can only preserve or degrade stale evidence; it cannot make old
     * evidence healthy again. */
    revalidate: z.boolean().optional(),
    disabled: z.boolean().optional(),
    disabledReason: z.string().max(2000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.revalidate &&
      (value.spans.length > 0 ||
        value.heartbeat ||
        value.disabled !== undefined ||
        value.disabledReason)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'revalidation must use only the exporter evidence persisted by Fuse',
      });
    }
  });
export type PreflightReportRequest = z.infer<typeof PreflightReportRequestSchema>;

/** Exporter delivery is a separate least-privilege boundary. The credential
 * for this request must be bound to the exact scope and cannot be replaced by
 * an ordinary permit/detector credential. */
export const PreflightExporterEvidenceRequestSchema = z
  .object({
    scope: ScopeSchema,
    spans: z.array(SpanTelemetrySampleSchema).max(2000),
    exporterDelivery: ExporterDeliverySignalSchema,
  })
  .strict();
export type PreflightExporterEvidenceRequest = z.infer<
  typeof PreflightExporterEvidenceRequestSchema
>;

export const PreflightResultSchema = z.object({
  scope: ScopeSchema,
  state: PreflightStateSchema,
  reasonCode: PreflightReasonCodeSchema,
  reason: z.string().min(1).max(2000),
  evaluatedAt: z.string().datetime(),
  /** Last time this scope was confirmed `protected` — null if never. */
  lastGoodAt: z.string().datetime().nullable(),
  requiredFieldCoveragePercent: z.number().min(0).max(100),
  orphanRatePercent: z.number().min(0).max(100),
  /** Milliseconds since the most recent observed span, or null if the
   * window had no spans at all. */
  freshnessMs: z.number().nonnegative().nullable(),
  /** A computed-healthier state currently dwelling before being
   * committed (hysteresis) — null when there is no pending recovery. */
  pendingRecoveryState: PreflightStateSchema.nullable(),
  pendingSince: z.string().datetime().nullable(),
});
export type PreflightResult = z.infer<typeof PreflightResultSchema>;
