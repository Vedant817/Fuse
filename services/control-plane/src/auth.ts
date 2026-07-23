import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { FuseHttpError } from '@fuse/contracts';
import { normalizeTokens, type ScopedToken, type TokenConfigEntry } from './config.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time membership check: hashes both sides to a fixed-length
 * digest before comparing, so neither the token's length nor a partial
 * prefix match is observable via timing. Does not short-circuit on match —
 * every candidate is compared against every configured token regardless,
 * so a match early in the list takes the same time as one late in it (or
 * none at all). Returns the matched record (so its `tenant` can be checked)
 * or undefined. */
function tokenRecordMatches(
  candidateDigest: Buffer,
  tokens: readonly ScopedToken[],
): ScopedToken | undefined {
  let found: ScopedToken | undefined;
  for (const candidate of tokens) {
    if (timingSafeEqual(candidateDigest, digest(candidate.token))) {
      found = candidate;
    }
  }
  return found;
}

/** Reads the tenant a request targets, for tenant-scope enforcement: a
 * POST/PUT body's `scope.tenant` (permit, breaker mutations, Preflight
 * report) or a GET request's `?tenant=` query param (breaker/Preflight
 * status). Returns undefined if neither is present as a string — callers
 * treat that as "could not determine," which is fail-closed for any
 * non-wildcard token (see `requireBearerAuth`). */
export function extractTenantFromRequest(request: FastifyRequest): string | undefined {
  const body = request.body as { scope?: { tenant?: unknown } } | null | undefined;
  if (typeof body?.scope?.tenant === 'string') return body.scope.tenant;
  const query = request.query as { tenant?: unknown } | undefined;
  if (typeof query?.tenant === 'string') return query.tenant;
  return undefined;
}

/** A grouped SigNoz delivery can contain several alerts. A tenant-scoped
 * webhook credential is accepted only when every alert explicitly names the
 * same matching tenant. Mixed-tenant or missing-tenant groups fail closed;
 * an explicitly configured wildcard credential remains the escape hatch for
 * a shared, multi-tenant SigNoz instance. */
export function extractTenantFromWebhookRequest(
  request: FastifyRequest,
): string | undefined {
  const body = request.body as
    { alerts?: Array<{ labels?: Record<string, unknown> }> } | null | undefined;
  if (!Array.isArray(body?.alerts) || body.alerts.length === 0) return undefined;
  const tenants = new Set<string>();
  for (const alert of body.alerts) {
    const labels = alert.labels;
    const tenant =
      labels?.['fuse.tenant'] ?? labels?.['fuse_tenant'] ?? labels?.['tenant'];
    if (typeof tenant !== 'string' || tenant.length === 0) return undefined;
    tenants.add(tenant);
  }
  return tenants.size === 1 ? [...tenants][0] : undefined;
}

/**
 * `allowedTokens` gates this route; `allKnownTokens` is every token
 * configured anywhere (operator + agent). A credential that matches
 * `allKnownTokens` but not `allowedTokens` is a real, valid token that
 * simply lacks privilege for this route — that is a 403 `unauthorized`,
 * distinct from a 401 `unauthenticated` for a token nobody issued. This
 * distinction is what lets an agent-scoped token call `/v1/permit` while
 * being rejected (not silently accepted) on `/v1/breaker/*` — least
 * privilege for resume/disable/force-trip, per AGENTS.md.
 *
 * `extractTenant`, when given, adds a second privilege dimension: a token
 * matched by role but bound to a specific tenant (not the `'*'` wildcard)
 * must also match the tenant the request actually targets, or it gets the
 * same 403 `unauthorized` — a role-correct token is not enough if it was
 * scoped to a different tenant (docs/adr/004-tenant-scoped-tokens.md). A
 * wildcard-tenant token (including every plain, unscoped token — see
 * `normalizeToken`) always passes this check, so omitting `extractTenant`
 * or configuring only unscoped tokens reproduces the exact prior behavior.
 */
export function requireBearerAuth(
  allowedTokens: readonly TokenConfigEntry[],
  allKnownTokens: readonly TokenConfigEntry[] = allowedTokens,
  extractTenant?: (request: FastifyRequest) => string | undefined,
) {
  const normalizedAllowed = normalizeTokens(allowedTokens);
  const normalizedAllKnown = normalizeTokens(allKnownTokens);
  return async function authPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const correlationId =
      (request.headers['x-correlation-id'] as string | undefined) ?? request.id;
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      const err = new FuseHttpError(
        'unauthenticated',
        'missing bearer token',
        401,
        correlationId,
      );
      await reply.code(err.httpStatus).send(err.toBody());
      return;
    }
    const token = header.slice('Bearer '.length).trim();
    if (token.length === 0) {
      const err = new FuseHttpError(
        'unauthenticated',
        'invalid bearer token',
        401,
        correlationId,
      );
      await reply.code(err.httpStatus).send(err.toBody());
      return;
    }
    const candidateDigest = digest(token);
    const matched = tokenRecordMatches(candidateDigest, normalizedAllowed);
    if (matched) {
      if (extractTenant && matched.tenant !== '*') {
        const requestTenant = extractTenant(request);
        if (requestTenant === undefined || requestTenant !== matched.tenant) {
          const err = new FuseHttpError(
            'unauthorized',
            'this token is not authorized for the requested tenant',
            403,
            correlationId,
          );
          await reply.code(err.httpStatus).send(err.toBody());
          return;
        }
      }
      return;
    }
    if (tokenRecordMatches(candidateDigest, normalizedAllKnown)) {
      const err = new FuseHttpError(
        'unauthorized',
        'this token is valid but not authorized for this operation',
        403,
        correlationId,
      );
      await reply.code(err.httpStatus).send(err.toBody());
      return;
    }
    const err = new FuseHttpError(
      'unauthenticated',
      'invalid bearer token',
      401,
      correlationId,
    );
    await reply.code(err.httpStatus).send(err.toBody());
  };
}
