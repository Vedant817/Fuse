import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?$/;

export function isValidReleaseVersion(value) {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    value !== 'latest' &&
    VERSION_PATTERN.test(value)
  );
}

export function normalizeReleaseVersion(value) {
  if (!isValidReleaseVersion(value)) {
    throw new Error(
      `Invalid release version ${JSON.stringify(value)}; expected an OCI-compatible SemVer value such as v0.1.0 or 0.1.0-rc.1 (never latest).`,
    );
  }
  return value.startsWith('v') ? value : `v${value}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const version = process.argv[2] ?? '';
  try {
    const normalized = normalizeReleaseVersion(version);
    process.stdout.write(`Release version accepted: ${normalized}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
