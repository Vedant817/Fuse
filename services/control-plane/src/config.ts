import { z } from 'zod';
import { OutageModeSchema } from '@fuse/contracts';

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(8080),
  host: z.string().min(1).default('0.0.0.0'),
  logLevel: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  databaseUrl: z.string().min(1),
  /** Behavior for the /permit fast path only, when the store cannot be
   * reached. Mutating endpoints (trip/resume/disable/enable) always fail
   * with 503 on store outage regardless of this setting — a control
   * mutation cannot be honestly "applied" if it cannot be persisted. */
  storeOutageMode: OutageModeSchema.default('fail-closed'),
  /** Operator tokens: full access, including the force-trip/resume/
   * disable/enable operational API. Comma-separated in
   * CONTROL_PLANE_API_TOKENS. Least-privilege boundary: only these tokens
   * may override a cooldown via a manual-actor resume, disable
   * enforcement, or force a trip — never an agent-scoped token. */
  apiTokens: z.array(z.string().min(16)).min(1),
  /** Agent tokens: permit-check only. Meant for the SDK embedded in a
   * customer/agent process — a lower-trust caller that must be able to ask
   * "am I allowed to make this call?" without also being able to resume,
   * disable, or force-trip any breaker. Comma-separated in
   * CONTROL_PLANE_AGENT_API_TOKENS; optional — if empty, only operator
   * tokens can call /v1/permit (still secure, just no separate role). */
  agentApiTokens: z.array(z.string().min(16)).default([]),
  /** Webhook tokens: SigNoz's alert-webhook channel only. SigNoz has no
   * HMAC-signing option (verified against its current docs — the channel
   * authenticates via HTTP Basic Auth, or a bearer token when the
   * configured username is left empty); a token scoped to only this route
   * means a leaked SigNoz webhook credential still cannot resume, disable,
   * or force-trip anything directly — it can only cause a *trip*, and only
   * for the scope named in the alert's own labels. Comma-separated in
   * CONTROL_PLANE_WEBHOOK_TOKENS. */
  webhookTokens: z.array(z.string().min(16)).default([]),
  /** Server-controlled defaults applied to every trip the webhook causes.
   * Deliberately NOT read from the alert payload itself — an inbound
   * alert is untrusted input, and letting it dictate its own cooldown
   * would let a forged or misconfigured alert set an arbitrarily short
   * (or long) cooldown. */
  webhookDefaultPolicyVersion: z.string().min(1).default('signoz-webhook-v1'),
  webhookDefaultCooldownSeconds: z.number().int().nonnegative().default(300),
});
export type ControlPlaneConfig = z.infer<typeof ConfigSchema>;

function parseTokenList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControlPlaneConfig {
  const apiTokens = parseTokenList(env['CONTROL_PLANE_API_TOKENS']);
  const agentApiTokens = parseTokenList(env['CONTROL_PLANE_AGENT_API_TOKENS']);
  const webhookTokens = parseTokenList(env['CONTROL_PLANE_WEBHOOK_TOKENS']);

  const parsed = ConfigSchema.safeParse({
    port: env['CONTROL_PLANE_PORT'],
    host: env['CONTROL_PLANE_HOST'],
    logLevel: env['LOG_LEVEL'],
    databaseUrl: env['DATABASE_URL'],
    storeOutageMode: env['CONTROL_PLANE_STORE_OUTAGE_MODE'],
    apiTokens,
    agentApiTokens,
    webhookTokens,
    webhookDefaultPolicyVersion: env['CONTROL_PLANE_WEBHOOK_POLICY_VERSION'],
    webhookDefaultCooldownSeconds: env['CONTROL_PLANE_WEBHOOK_COOLDOWN_SECONDS']
      ? Number(env['CONTROL_PLANE_WEBHOOK_COOLDOWN_SECONDS'])
      : undefined,
  });
  if (!parsed.success) {
    throw new Error(`invalid control-plane configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
