import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { normalizeReleaseVersion } from './validate-version.mjs';

export function validateChangelogRelease(changelog, requestedVersion) {
  const version = normalizeReleaseVersion(requestedVersion);
  const changelogVersion = version.slice(1);
  const headings = [
    ...changelog.matchAll(/^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/gm),
  ];
  if (headings.length < 2 || headings[0][1] !== 'Unreleased') {
    throw new Error('CHANGELOG.md must begin with an [Unreleased] release section.');
  }

  const unreleasedBody = changelog.slice(
    headings[0].index + headings[0][0].length,
    headings[1].index,
  );
  if (/^###\s|^-\s/m.test(unreleasedBody)) {
    throw new Error(
      'CHANGELOG.md [Unreleased] contains release notes; move them under the requested version before publication.',
    );
  }
  if (headings[1][1] !== changelogVersion || !headings[1][2]) {
    throw new Error(
      `The first finalized CHANGELOG.md section must be [${changelogVersion}] with a release date.`,
    );
  }

  const releaseEnd = headings[2]?.index ?? changelog.length;
  const releaseBody = changelog.slice(
    headings[1].index + headings[1][0].length,
    releaseEnd,
  );
  if (!/^###\s|^-\s/m.test(releaseBody)) {
    throw new Error(
      `The finalized CHANGELOG.md [${changelogVersion}] section must contain release notes.`,
    );
  }

  return {
    version,
    publishLatest: !changelogVersion.includes('-'),
  };
}

async function main() {
  const requestedVersion = process.argv[2] ?? '';
  const changelogPath = resolve(process.argv[3] ?? 'CHANGELOG.md');
  const changelog = await readFile(changelogPath, 'utf8');
  const result = validateChangelogRelease(changelog, requestedVersion);

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `version=${result.version}\npublish-latest=${String(result.publishLatest)}\n`,
    );
  }
  process.stdout.write(
    `Release metadata accepted: ${result.version}; publish latest: ${result.publishLatest}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
