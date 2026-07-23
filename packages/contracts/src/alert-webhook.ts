import { z } from 'zod';
import { ScopeSchema } from './scope.js';

/**
 * SigNoz's webhook notification channel follows the Prometheus
 * Alertmanager webhook contract (verified against signoz.io/docs/alerts-
 * management/notification-channel/webhook/, 2026-07-21) — SigNoz does not
 * sign payloads with HMAC; the channel authenticates via HTTP Basic Auth
 * or, when the configured username is left empty, a bearer token in the
 * password field. Fuse's webhook therefore authenticates with the same
 * bearer-token mechanism as the rest of the operational API (see
 * `services/control-plane/src/auth.ts`), not a custom signature scheme.
 */
export const SignozAlertStatusSchema = z.enum(['firing', 'resolved']);

export const SignozAlertmanagerAlertSchema = z.object({
  status: SignozAlertStatusSchema,
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()).default({}),
  startsAt: z.string().min(1),
  endsAt: z.string().optional(),
  generatorURL: z.string().optional(),
  fingerprint: z.string().min(1),
});
export type SignozAlertmanagerAlert = z.infer<typeof SignozAlertmanagerAlertSchema>;

/** Alertmanager groups alerts by rule and delivers grouped messages
 * periodically (SigNoz's default is every 5 minutes) — a single webhook
 * call can carry many alert instances, so `alerts` is bounded but not
 * assumed to have exactly one entry. */
export const SignozAlertmanagerWebhookPayloadSchema = z.object({
  version: z.string().optional(),
  groupKey: z.string().optional(),
  truncatedAlerts: z.number().int().nonnegative().optional(),
  status: SignozAlertStatusSchema,
  receiver: z.string().optional(),
  groupLabels: z.record(z.string(), z.string()).default({}),
  commonLabels: z.record(z.string(), z.string()).default({}),
  commonAnnotations: z.record(z.string(), z.string()).default({}),
  externalURL: z.string().optional(),
  alerts: z.array(SignozAlertmanagerAlertSchema).min(1).max(200),
});
export type SignozAlertmanagerWebhookPayload = z.infer<
  typeof SignozAlertmanagerWebhookPayloadSchema
>;

/** The internal, provider-neutral shape every inbound alert is normalized
 * to before it can affect breaker state (task.md §1.3: "Define versioned
 * alert-webhook input and normalized internal alert event"). Only this
 * shape is ever passed to `BreakerStore` — raw webhook payloads never
 * reach it directly. */
export const NormalizedAlertEventSchema = z.object({
  scope: ScopeSchema,
  status: SignozAlertStatusSchema,
  /** Bounded like `reason` below (task.md §11.3 adversarial review): this
   * value is attacker-reachable — any holder of a webhook-tier token
   * chooses the alert's own `fuse.detector` label — and flows into
   * `actor.id` (`system:signoz-webhook:${detector}`, persisted verbatim
   * into unbounded `TEXT` columns in `breaker_audit_log`/`breaker_state`)
   * and into an info-level log line for an unrecognized value
   * (`diagnosis-worker.ts`). Real detector names are short, known strings
   * (`loop-signature`/`context-bloat`/`cost-velocity`); 200 chars is
   * generous headroom for a legitimate value while still bounding an
   * attacker-chosen one. */
  detector: z.string().min(1).max(200),
  reason: z.string().min(1).max(2000),
  fingerprint: z.string().min(1),
  startsAt: z.string().min(1),
});
export type NormalizedAlertEvent = z.infer<typeof NormalizedAlertEventSchema>;
