import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function validatePromotion(candidateDigest, immutableAliases) {
  if (!DIGEST_PATTERN.test(candidateDigest)) {
    throw new Error(`Invalid candidate digest: ${candidateDigest}`);
  }
  for (const [alias, existingDigest] of Object.entries(immutableAliases)) {
    if (existingDigest && !DIGEST_PATTERN.test(existingDigest)) {
      throw new Error(`Invalid existing digest for ${alias}: ${existingDigest}`);
    }
    if (existingDigest && existingDigest !== candidateDigest) {
      throw new Error(
        `Refusing conflicting immutable alias ${alias}: ${existingDigest} != ${candidateDigest}`,
      );
    }
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    validatePromotion(process.argv[2] ?? '', {
      version: process.argv[3] ?? '',
      commit: process.argv[4] ?? '',
    });
    process.stdout.write(
      'Immutable aliases are absent or already reference this digest.\n',
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
