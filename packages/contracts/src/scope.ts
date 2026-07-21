import { z } from 'zod';

/**
 * Every breaker, alert, audit event, and telemetry record is scoped by these
 * three identifiers. No control action may cross a scope boundary implicitly
 * — an alert for one agent must never be able to trip another agent's
 * breaker (AGENTS.md engineering boundaries).
 */
export const ScopeSchema = z.object({
  tenant: z.string().min(1).max(128),
  environment: z.string().min(1).max(64),
  agentId: z.string().min(1).max(128),
});
export type Scope = z.infer<typeof ScopeSchema>;

export function scopeKey(scope: Scope): string {
  return `${scope.tenant}/${scope.environment}/${scope.agentId}`;
}
