import type { FastifyInstance, FastifyRequest } from 'fastify';
import { FuseHttpError, SignozAlertmanagerWebhookPayloadSchema } from '@fuse/contracts';
import {
  IdempotencyConflictError,
  StoreUnavailableError,
  type BreakerStore,
} from '@fuse/breaker-store';
import type { ControlPlaneConfig } from '../config.js';
import { mapSignozAlertToNormalizedEvent } from '../signoz-alert-mapper.js';

const WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024; // grouped Alertmanager deliveries can carry many alerts

function correlationIdOf(request: FastifyRequest): string {
  const header = request.headers['x-correlation-id'];
  return typeof header === 'string' && header.length > 0 ? header : request.id;
}

interface AlertOutcome {
  fingerprint: string;
  outcome:
    | 'tripped'
    | 'already-tripped'
    | 'breaker-disabled'
    | 'resolved-observed'
    | 'unknown-scope'
    | 'cooldown-active'
    | 'invalid-transition'
    | 'stale-epoch'
    | 'idempotency-conflict'
    | 'stale-alert';
}

/** Replay/staleness guard (docs/threat-model.md §3, config.ts's
 * `webhookMaxAlertAgeMs` doc comment): true if `startsAt` cannot be parsed
 * at all, is older than the configured max age, or claims to be further in
 * the future than the configured clock-skew tolerance. Fail-closed on an
 * unparseable timestamp — `startsAt` is only `z.string().min(1)` at the
 * schema layer (Alertmanager's real format is a valid RFC3339 timestamp,
 * but that isn't enforced there), so treat "can't tell if it's fresh" the
 * same as "not fresh," never as "assume fresh." */
function isStaleAlert(
  startsAt: string,
  now: number,
  maxAgeMs: number,
  maxClockSkewAheadMs: number,
): boolean {
  const startsAtMs = Date.parse(startsAt);
  if (Number.isNaN(startsAtMs)) return true;
  const ageMs = now - startsAtMs;
  return ageMs > maxAgeMs || ageMs < -maxClockSkewAheadMs;
}

export function registerWebhookRoutes(
  app: FastifyInstance,
  store: BreakerStore,
  config: ControlPlaneConfig,
): void {
  app.post(
    '/v1/webhooks/signoz',
    { bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const correlationId = correlationIdOf(request);
      const parsed = SignozAlertmanagerWebhookPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        const err = new FuseHttpError(
          'invalid_request',
          parsed.error.message,
          400,
          correlationId,
        );
        return reply.code(err.httpStatus).send(err.toBody());
      }

      const results: AlertOutcome[] = [];

      for (const alert of parsed.data.alerts) {
        const normalized = mapSignozAlertToNormalizedEvent(alert);
        if (!normalized) {
          // Reject unknown/unresolvable scope per-alert rather than failing
          // the whole batch — a grouped delivery may legitimately mix
          // alerts Fuse can and can't map yet.
          results.push({ fingerprint: alert.fingerprint, outcome: 'unknown-scope' });
          continue;
        }

        if (normalized.status === 'resolved') {
          // Deliberate default (task.md §5.1): never auto-resume solely
          // because an alert resolved. Observed, no state change.
          results.push({ fingerprint: alert.fingerprint, outcome: 'resolved-observed' });
          continue;
        }

        if (
          isStaleAlert(
            normalized.startsAt,
            Date.now(),
            config.webhookMaxAlertAgeMs,
            config.webhookMaxClockSkewAheadMs,
          )
        ) {
          // Reject per-alert, not the whole batch — a grouped delivery may
          // legitimately mix a stale/replayed alert with fresh ones.
          results.push({ fingerprint: alert.fingerprint, outcome: 'stale-alert' });
          continue;
        }

        // Both the idempotency key AND the correlation ID passed to the
        // store must be derived from the alert's own stable identity
        // (fingerprint+startsAt), not from this HTTP request's
        // auto-generated ID — Alertmanager can and does redeliver the
        // same alert instance in a later webhook call with a brand-new
        // HTTP request, and the idempotency check hashes the whole
        // request (including correlationId), so a per-delivery-attempt
        // correlationId would make every "duplicate" look like a
        // different request and spuriously trip IdempotencyConflictError.
        const alertCorrelationId = `signoz:${normalized.fingerprint}:${normalized.startsAt}`;
        const idempotencyKey = alertCorrelationId;
        try {
          const tripResult = await store.trip({
            scope: normalized.scope,
            reason: normalized.reason,
            policyVersion: config.webhookDefaultPolicyVersion,
            cooldownSeconds: config.webhookDefaultCooldownSeconds,
            actor: { type: 'system', id: `system:signoz-webhook:${normalized.detector}` },
            correlationId: alertCorrelationId,
            idempotencyKey,
          });
          if (tripResult.kind === 'rejected') {
            results.push({
              fingerprint: alert.fingerprint,
              outcome:
                tripResult.code === 'cooldown_active'
                  ? 'cooldown-active'
                  : tripResult.code === 'stale_epoch'
                    ? 'stale-epoch'
                    : 'invalid-transition',
            });
          } else {
            // `trip()` can only ever noop for one of these two reasons
            // (see applyTrip in breaker-core/src/transitions.ts) — a
            // disabled scope never actually tripped, so it must be
            // reported distinctly from a scope that was genuinely already
            // tripped by an earlier alert.
            const outcome: AlertOutcome['outcome'] = !tripResult.noop
              ? 'tripped'
              : tripResult.noopReason === 'breaker-disabled'
                ? 'breaker-disabled'
                : 'already-tripped';
            results.push({ fingerprint: alert.fingerprint, outcome });
          }
        } catch (err) {
          if (err instanceof IdempotencyConflictError) {
            results.push({
              fingerprint: alert.fingerprint,
              outcome: 'idempotency-conflict',
            });
            continue;
          }
          if (err instanceof StoreUnavailableError) {
            // Can't durably accept the remainder of this batch — fail the
            // whole request 503 so Alertmanager retries. Already-committed
            // trips above are durable and will no-op harmlessly on retry.
            const httpErr = new FuseHttpError(
              'store_unavailable',
              'breaker store is unreachable; retry the webhook delivery',
              503,
              correlationId,
            );
            return reply.code(httpErr.httpStatus).send(httpErr.toBody());
          }
          throw err;
        }
      }

      return reply.code(200).send({ correlationId, results });
    },
  );
}
