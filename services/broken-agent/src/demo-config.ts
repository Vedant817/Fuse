/**
 * Env-var parsing for demo.ts's `FuseGuard` construction — kept in its own
 * module (rather than inline in demo.ts) so tests can import just these
 * functions without also running demo.ts's module-level side effects (the
 * `CONTROL_PLANE_API_TOKENS` fatal-exit check, etc.).
 */
import { OutageModeSchema, type OutageMode } from '@fuse/contracts';
import * as fmt from './demo-format.js';

/**
 * Parses `FUSE_PERMIT_TIMEOUT_MS`. Returns `undefined` — not a value
 * copied from the SDK — when `raw` is unset or not a positive integer, so
 * the caller can omit `timeoutMs` and let `FuseGuard`'s own
 * `DEFAULT_TIMEOUT_MS` apply; that avoids hardcoding a second copy of the
 * SDK's default here that could silently drift from it. `Number.isInteger`
 * already rejects `NaN`/`±Infinity`, matching how this repo's other
 * config-parsing (see `safety.ts`'s `clampCeiling`) refuses to treat
 * non-finite input as "no limit".
 */
export function parsePermitTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fmt.warn(
      `FUSE_PERMIT_TIMEOUT_MS="${raw}" is not a positive integer — falling back to the SDK's own default permit-check timeout`,
    );
    return undefined;
  }
  return parsed;
}

/**
 * `FuseGuardOptions.timeoutMs` is optional and the SDK package compiles
 * with `exactOptionalPropertyTypes`, so an explicit `timeoutMs: undefined`
 * is a type error — the key must be entirely absent to defer to
 * `FuseGuard`'s own default. This turns `parsePermitTimeoutMs`'s result
 * into a spreadable options fragment so call sites don't each need their
 * own conditional-spread logic.
 */
export function permitTimeoutOption(
  timeoutMs: number | undefined,
): { timeoutMs: number } | Record<string, never> {
  return timeoutMs === undefined ? {} : { timeoutMs };
}

/**
 * Parses `FUSE_SDK_OUTAGE_MODE` against the SDK's own `OutageMode`
 * contract. Unset defers to `fail-closed` (matching `.env.example`'s
 * stated production default and the SDK's own constructor default). A
 * *set but invalid* value (e.g. a typo) also falls back to `fail-closed`,
 * with a warning, rather than silently misinterpreting garbage input as
 * some other mode.
 */
export function parseOutageMode(raw: string | undefined): OutageMode {
  if (raw === undefined || raw.trim() === '') return 'fail-closed';
  const parsed = OutageModeSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  fmt.warn(
    `FUSE_SDK_OUTAGE_MODE="${raw}" is not "fail-open" or "fail-closed" — falling back to fail-closed (this project's stated production default)`,
  );
  return 'fail-closed';
}
