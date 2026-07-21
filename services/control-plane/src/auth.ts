import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { FuseHttpError } from '@fuse/contracts';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time membership check: hashes both sides to a fixed-length
 * digest before comparing, so neither the token's length nor a partial
 * prefix match is observable via timing. */
function tokenMatches(candidate: string, validTokens: readonly string[]): boolean {
  const candidateDigest = digest(candidate);
  let matched = false;
  for (const valid of validTokens) {
    if (timingSafeEqual(candidateDigest, digest(valid))) {
      matched = true;
    }
  }
  return matched;
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
 */
export function requireBearerAuth(
  allowedTokens: readonly string[],
  allKnownTokens: readonly string[] = allowedTokens,
) {
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
    if (tokenMatches(token, allowedTokens)) {
      return;
    }
    if (tokenMatches(token, allKnownTokens)) {
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
