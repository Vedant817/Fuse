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

export function requireBearerAuth(apiTokens: readonly string[]) {
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
    if (token.length === 0 || !tokenMatches(token, apiTokens)) {
      const err = new FuseHttpError(
        'unauthenticated',
        'invalid bearer token',
        401,
        correlationId,
      );
      await reply.code(err.httpStatus).send(err.toBody());
      return;
    }
  };
}
