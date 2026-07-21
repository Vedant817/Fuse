import { z } from 'zod';
import { OutageModeSchema } from '@fuse/contracts';

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(8080),
  host: z.string().min(1).default('0.0.0.0'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  databaseUrl: z.string().min(1),
  /** Behavior for the /permit fast path only, when the store cannot be
   * reached. Mutating endpoints (trip/resume/disable/enable) always fail
   * with 503 on store outage regardless of this setting — a control
   * mutation cannot be honestly "applied" if it cannot be persisted. */
  storeOutageMode: OutageModeSchema.default('fail-closed'),
  /** Shared bearer tokens accepted for every authenticated endpoint
   * (permit + operational API). Comma-separated in CONTROL_PLANE_API_TOKENS. */
  apiTokens: z.array(z.string().min(16)).min(1),
});
export type ControlPlaneConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControlPlaneConfig {
  const rawTokens = env['CONTROL_PLANE_API_TOKENS'] ?? '';
  const apiTokens = rawTokens
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const parsed = ConfigSchema.safeParse({
    port: env['CONTROL_PLANE_PORT'],
    host: env['CONTROL_PLANE_HOST'],
    logLevel: env['LOG_LEVEL'],
    databaseUrl: env['DATABASE_URL'],
    storeOutageMode: env['CONTROL_PLANE_STORE_OUTAGE_MODE'],
    apiTokens,
  });
  if (!parsed.success) {
    throw new Error(`invalid control-plane configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
