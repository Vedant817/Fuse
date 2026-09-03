import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';
import { parse } from 'yaml';
import { validateChangelogRelease } from './validate-release.mjs';
import { validatePromotion } from './validate-promotion.mjs';
import { validateSbom } from './validate-sbom.mjs';
import { isValidReleaseVersion, normalizeReleaseVersion } from './validate-version.mjs';

const releaseSource = await readFile(
  new URL('../../.github/workflows/release.yml', import.meta.url),
  'utf8',
);
const ciSource = await readFile(
  new URL('../../.github/workflows/ci.yml', import.meta.url),
  'utf8',
);
const changelogSource = await readFile(
  new URL('../../CHANGELOG.md', import.meta.url),
  'utf8',
);
const dockerfileSource = await readFile(
  new URL('../../Dockerfile', import.meta.url),
  'utf8',
);
const exactImageSmokeSource = await readFile(
  new URL('./smoke-exact-image.mjs', import.meta.url),
  'utf8',
);
const release = parse(releaseSource);
const ci = parse(ciSource);

const clone = (value) => JSON.parse(JSON.stringify(value));
const stepIndex = (steps, fragment) =>
  steps.findIndex((step) => step.name?.includes(fragment));

export function validateWorkflow(releaseWorkflow, ciWorkflow) {
  assert.ok(releaseWorkflow && ciWorkflow, 'workflows must parse as YAML');
  assert.deepEqual(
    Object.keys(releaseWorkflow.on),
    ['workflow_dispatch'],
    'release must be manual-dispatch only',
  );
  assert.equal(releaseWorkflow.on.workflow_dispatch.inputs.version.required, true);
  assert.deepEqual(releaseWorkflow.permissions, { contents: 'read' });
  assert.equal(releaseWorkflow.concurrency.group, 'release-${{ github.repository }}');

  const verify = releaseWorkflow.jobs.verify;
  const publish = releaseWorkflow.jobs.publish;
  assert.equal(
    publish.environment,
    'release',
    'publisher must use the release environment',
  );
  assert.deepEqual(publish.needs, ['verify']);
  assert.deepEqual(publish.permissions, {
    attestations: 'write',
    contents: 'read',
    'id-token': 'write',
    packages: 'write',
  });

  for (const [name, workflow] of [
    ['release.yml', releaseWorkflow],
    ['ci.yml', ciWorkflow],
  ]) {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses) {
          assert.match(
            step.uses,
            /^[^@\s]+@[0-9a-f]{40}$/,
            `${name}: action must be pinned to a full commit SHA: ${step.uses}`,
          );
        }
      }
    }
  }

  const sourceGuard = verify.steps.find((step) =>
    step.name?.includes('manual main dispatch'),
  );
  assert.ok(sourceGuard, 'release source guard is required');
  for (const invariant of [
    'GITHUB_EVENT_NAME',
    'workflow_dispatch',
    'GITHUB_REF',
    'refs/heads/main',
    'refs/remotes/origin/main',
    'git merge-base --is-ancestor',
  ]) {
    assert.ok(
      sourceGuard.run.includes(invariant),
      `source guard is missing ${invariant}`,
    );
  }
  const releaseMetadata = verify.steps.find((step) =>
    step.name?.includes('changelog label'),
  );
  assert.match(releaseMetadata.run, /validate-release\.mjs/);

  assert.match(publish.services.postgres.image, /@sha256:[0-9a-f]{64}$/);
  assert.match(publish.services.redis.image, /@sha256:[0-9a-f]{64}$/);

  const steps = publish.steps;
  const order = [
    'Build exact amd64',
    'Build exact arm64',
    'Smoke-test both',
    'Scan exact amd64',
    'Scan exact arm64',
    'Preserve candidate vulnerability scan evidence',
    'Gate publication on both candidate vulnerability scans',
    'Authenticate to GHCR',
    'Push exact candidates',
    'Assemble and validate',
    'Generate final image',
    'Validate final image',
    'Attest final manifest build',
    'Attest final manifest SBOM',
    'Preserve final image',
    'Preflight immutable public aliases',
    'Promote version, commit, and latest',
    'Verify promoted aliases',
  ];
  let previous = -1;
  for (const name of order) {
    const current = stepIndex(steps, name);
    assert.ok(current >= 0, `release step is missing: ${name}`);
    assert.ok(current > previous, `release step is out of order: ${name}`);
    previous = current;
  }

  for (const step of steps.filter((candidate) =>
    candidate.name?.startsWith('Build exact'),
  )) {
    assert.equal(step.with.load, true);
    assert.equal(step.with.push, false);
    assert.equal(step.with.provenance, false);
    assert.equal(step.with.sbom, false);
  }

  const scans = steps.filter((step) => step.name?.startsWith('Scan exact'));
  assert.equal(scans.length, 2, 'both architecture candidates must be scanned');
  for (const scan of scans) {
    assert.equal(
      scan.uses,
      'anchore/scan-action@e1165082ffb1fe366ebaf02d8526e7c4989ea9d2',
    );
    assert.equal(scan.with['fail-build'], true);
    assert.equal(scan.with['severity-cutoff'], 'high');
    assert.equal(scan.with['only-fixed'], false);
    assert.equal(scan.with['grype-version'], 'v0.110.0');
    assert.equal(scan.with.exclude, undefined, 'release scans must not exclude findings');
    assert.equal(scan.with.ignore, undefined, 'release scans must not suppress findings');
    assert.equal(scan['continue-on-error'], true);
  }
  const scanGate = steps.find((step) =>
    step.name?.startsWith('Gate publication on both candidate'),
  );
  assert.ok(scanGate.run.includes('AMD64_SCAN_OUTCOME'));
  assert.ok(scanGate.run.includes('ARM64_SCAN_OUTCOME'));
  assert.ok(scanGate.run.includes('= success'));

  const promotionIndex = stepIndex(steps, 'Promote version, commit, and latest');
  for (const step of steps.slice(0, promotionIndex)) {
    const run = step.run ?? '';
    if (/docker push|imagetools create\s+\\?\s*--tag/.test(run)) {
      assert.ok(
        !run.includes('${IMAGE_NAME}:${RELEASE_VERSION}') &&
          !run.includes('${IMAGE_NAME}:sha-${GITHUB_SHA}') &&
          !run.includes('${IMAGE_NAME}:latest'),
        `${step.name} exposes a public alias before final promotion`,
      );
    }
    if (run.includes('docker push')) {
      assert.ok(run.includes('STAGING_PREFIX'), 'candidate pushes must use staging tags');
    }
  }

  const stagingPush = steps.find((step) =>
    step.name?.startsWith('Push exact candidates'),
  );
  assert.ok(stagingPush.run.includes('${STAGING_PREFIX}-${arch}'));
  const assembly = steps.find((step) => step.name?.startsWith('Assemble and validate'));
  assert.ok(assembly.run.includes('${IMAGE_NAME}:${STAGING_PREFIX}'));
  assert.ok(assembly.run.includes('.manifests | length'));
  assert.ok(assembly.run.includes("= 'amd64,arm64'"));

  const aliasPreflight = steps.find((step) =>
    step.name?.startsWith('Preflight immutable public aliases'),
  );
  assert.match(aliasPreflight.run, /validate-promotion\.mjs/);
  assert.ok(aliasPreflight.run.includes('Could not determine GHCR alias state'));
  const promotion = steps[promotionIndex];
  for (const alias of ['${RELEASE_VERSION}', 'sha-${GITHUB_SHA}', 'latest']) {
    assert.ok(promotion.run.includes(alias), `promotion is missing ${alias}`);
  }

  const allRuns = steps.map((step) => step.run ?? '').join('\n');
  for (const required of [
    'CONTROL_PLANE_DEPLOYMENT_ENVIRONMENT=production',
    'CONTROL_PLANE_AGENT_API_TOKENS=${agent_tokens}',
    'CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS=${exporter_tokens}',
    'CONTROL_PLANE_DETECTOR_POLICY_FILE=/etc/fuse/policies/production.json',
    'CONTROL_PLANE_RATE_LIMIT_REDIS_URL=redis://127.0.0.1:6379/0',
    '0007_diagnosis_job_replays.sql',
    '0008_preflight_source_evidence.sql',
    'node tools/release/smoke-exact-image.mjs',
    'docker pause "${REDIS_CONTAINER}"',
    'docker stop --timeout 1 "${POSTGRES_CONTAINER}"',
    'rate_limit_store_unavailable',
    "v.state!=='tripped'",
    '--entrypoint /bin/sh',
    'node --version',
    '/readyz',
    'fastify ioredis pg @opentelemetry/sdk-node zod @fastify/rate-limit',
  ]) {
    assert.ok(
      allRuns.includes(required),
      `release workflow is missing invariant: ${required}`,
    );
  }

  const provenance = steps.find(
    (step) => step.name === 'Attest final manifest build provenance',
  );
  const sbom = steps.find((step) => step.name === 'Attest final manifest SBOM');
  for (const step of [provenance, sbom]) {
    assert.equal(step.with['subject-digest'], '${{ steps.manifest.outputs.digest }}');
    assert.equal(step.with['push-to-registry'], true);
  }
  assert.equal(sbom.with['sbom-path'], 'release-image.spdx.json');
  const imageSbom = steps.find((step) => step.name === 'Generate final image SPDX SBOM');
  assert.equal(imageSbom.with['syft-version'], 'v1.42.3');
  const imageSbomValidation = steps.find(
    (step) => step.name === 'Validate final image SBOM',
  );
  assert.ok(imageSbomValidation.run.includes('@fuse/control-plane @fuse/breaker-store'));
  assert.ok(
    verify.steps.some((step) => step.name === 'Validate workspace SBOM runtime coverage'),
  );
  assert.ok(verify.steps.some((step) => step.name === 'Preserve source SBOM'));
  for (const artifact of [
    verify.steps.find((step) => step.name === 'Preserve source SBOM'),
    steps.find((step) => step.name === 'Preserve candidate vulnerability scan evidence'),
    steps.find((step) => step.name === 'Preserve final image release evidence'),
  ]) {
    assert.ok(artifact.with.name.includes('${{ github.run_id }}'));
    assert.ok(artifact.with.name.includes('${{ github.run_attempt }}'));
  }
  assert.ok(
    ciWorkflow.jobs.quality.steps.some(
      (step) => step.run === 'pnpm run test:release-workflow',
    ),
  );

  assert.match(
    dockerfileSource,
    /^ARG NODE_IMAGE=node:24\.19\.0-alpine3\.24@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43$/m,
    'the Node 24.19 base must use the reviewed immutable multi-architecture digest',
  );
  assert.match(dockerfileSource, /^FROM scratch AS runtime$/m);
  const runtimeStage = dockerfileSource.slice(
    dockerfileSource.indexOf('FROM scratch AS runtime'),
  );
  assert.doesNotMatch(runtimeStage, /(?:^|\s)(?:apk|sh|bash)(?:\s|$)/m);
  assert.match(runtimeStage, /^ARG VERSION=dev$/m);

  for (const invariant of [
    "detector: 'loop-signature'",
    "detector: 'context-bloat'",
    "detector: 'cost-velocity'",
    '/v1/preflight/exporter-evidence',
    '/v1/detectors/observe',
    '/v1/permit',
    '/v1/diagnosis/jobs',
    "outcome: 'tripped'",
    "state: 'tripped'",
    'diagnosis.jobs.length, 1',
  ]) {
    assert.ok(
      exactImageSmokeSource.includes(invariant),
      `exact-image smoke is missing invariant: ${invariant}`,
    );
  }
}

validateWorkflow(release, ci);

function expectWorkflowFailure(mutator, pattern) {
  const fixture = clone(release);
  mutator(fixture);
  assert.throws(() => validateWorkflow(fixture, ci), pattern);
}

expectWorkflowFailure((fixture) => {
  fixture.on.push = { tags: ['v*'] };
}, /manual-dispatch only/);
expectWorkflowFailure((fixture) => {
  fixture.jobs.publish.environment = undefined;
}, /release environment/);
expectWorkflowFailure((fixture) => {
  fixture.jobs.verify.steps.find((step) =>
    step.name?.includes('manual main dispatch'),
  ).run = '';
}, /source guard is missing/);
expectWorkflowFailure((fixture) => {
  fixture.jobs.publish.steps = fixture.jobs.publish.steps.filter(
    (step) =>
      step.name !== 'Scan exact arm64 candidate for high and critical vulnerabilities',
  );
}, /release step is missing|both architecture candidates/);
expectWorkflowFailure((fixture) => {
  fixture.jobs.publish.steps = fixture.jobs.publish.steps.filter(
    (step) => !step.name?.startsWith('Gate publication on both candidate'),
  );
}, /release step is missing/);
expectWorkflowFailure((fixture) => {
  fixture.jobs.publish.steps.find((step) =>
    step.name?.startsWith('Push exact candidates'),
  ).run = 'docker push "${IMAGE_NAME}:${RELEASE_VERSION}"';
}, /public alias before final promotion|staging tags/);
expectWorkflowFailure((fixture) => {
  const steps = fixture.jobs.publish.steps;
  const promote = steps.splice(
    stepIndex(steps, 'Promote version, commit, and latest'),
    1,
  )[0];
  steps.splice(stepIndex(steps, 'Attest final manifest build'), 0, promote);
}, /out of order/);
expectWorkflowFailure((fixture) => {
  fixture.jobs.publish.steps.find((step) =>
    step.name?.startsWith('Scan exact amd64'),
  ).with['fail-build'] = false;
}, /false !== true/);
expectWorkflowFailure((fixture) => {
  fixture.jobs.publish.steps.find((step) => step.uses).uses = 'actions/checkout@v4';
}, /full commit SHA/);

for (const version of ['v0.1.0', '0.1.0', 'v2.3.4-rc.1']) {
  assert.equal(
    isValidReleaseVersion(version),
    true,
    `expected valid version: ${version}`,
  );
}
for (const version of [
  '',
  'latest',
  'v1',
  '1.2',
  '1.2.3.4',
  '01.2.3',
  '1.2.3+build',
  `1.2.3-${'a'.repeat(123)}`,
]) {
  assert.equal(
    isValidReleaseVersion(version),
    false,
    `expected invalid version: ${version}`,
  );
}
assert.equal(normalizeReleaseVersion('1.2.3'), 'v1.2.3');

assert.throws(
  () => validateChangelogRelease(changelogSource, 'v0.2.0'),
  /contains release notes/,
);
assert.deepEqual(
  validateChangelogRelease(
    '# Changelog\n\n## [Unreleased]\n\n## [1.2.3-rc.1] - 2026-08-24\n\n- Candidate.\n',
    '1.2.3-rc.1',
  ),
  { version: 'v1.2.3-rc.1', publishLatest: false },
);
assert.throws(
  () =>
    validateChangelogRelease(
      '# Changelog\n\n## [Unreleased]\n\n- Pending.\n\n## [1.2.3] - 2026-08-24\n',
      '1.2.3',
    ),
  /contains release notes/,
);
assert.throws(
  () =>
    validateChangelogRelease(
      '# Changelog\n\n## [Unreleased]\n\n## [1.2.4] - 2026-08-24\n',
      '1.2.3',
    ),
  /first finalized/,
);
assert.throws(
  () =>
    validateChangelogRelease(
      '# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-08-24\n\n## [1.2.2] - 2026-08-01\n\n- Older.\n',
      '1.2.3',
    ),
  /must contain release notes/,
);

const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;
assert.equal(validatePromotion(digestA, { version: '', commit: digestA }), true);
assert.throws(
  () => validatePromotion(digestA, { version: digestB, commit: '' }),
  /conflicting immutable alias/,
);

assert.equal(
  validateSbom(
    {
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      components: [{ group: '@fuse', name: 'control-plane' }, { name: 'fastify' }],
    },
    'cyclonedx',
    ['@fuse/control-plane', 'fastify'],
  ),
  2,
);
assert.throws(
  () =>
    validateSbom(
      { spdxVersion: 'SPDX-2.3', packages: [{ name: '@fuse/control-plane' }] },
      'spdx',
      ['@fuse/control-plane', 'pg'],
    ),
  /missing expected runtime components: pg/,
);

process.stdout.write(
  'Release and CI workflow structural invariants and negative fixtures passed.\n',
);
