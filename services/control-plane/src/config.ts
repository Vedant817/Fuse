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

  const parsed = ConfigSchema.safeParse({
    port: env['CONTROL_PLANE_PORT'],
    host: env['CONTROL_PLANE_HOST'],
    logLevel: env['LOG_LEVEL'],
    databaseUrl: env['DATABASE_URL'],
    storeOutageMode: env['CONTROL_PLANE_STORE_OUTAGE_MODE'],
    apiTokens,
    agentApiTokens,
  });
  if (!parsed.success) {
    throw new Error(`invalid control-plane configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
