import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureDir = join(rootDir, 'tools', 'package-smoke', 'fixture');
const outputDir = join(rootDir, 'output', 'package-smoke');
const tarballDir = join(outputDir, 'tarballs');
const pnpmCli = process.env.npm_execpath;
const packOnly = process.argv.includes('--pack-only');

const packageSpecs = [
  { name: '@fuse/contracts', directory: 'packages/contracts' },
  { name: '@fuse/otel', directory: 'packages/otel' },
  { name: '@fuse/sdk', directory: 'packages/sdk' },
];

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture) {
      process.stdout.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
    }
    fail(`${command} ${args.join(' ')} exited ${result.status}`);
  }
  return (result.stdout ?? '').trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runPnpm(args, options = {}) {
  if (!pnpmCli) fail('run this script through a pnpm package script');
  return run(process.execPath, [pnpmCli, ...args], options);
}

function listFiles(directory, base = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? listFiles(path, base)
      : [relative(base, path).split(sep).join('/')];
  });
}

function collectExportTargets(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(collectExportTargets);
}

function collectLockedDependencyGraph(projects) {
  const versions = new Map();
  const edges = {};

  function addVersion(name, version) {
    if (typeof version !== 'string' || version.includes(':')) return;
    const known = versions.get(name) ?? new Set();
    known.add(version);
    versions.set(name, known);
  }

  function visit(node, name = node.name) {
    if (!name || typeof node.version !== 'string') return;
    addVersion(name, node.version);
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const [dependencyName, dependency] of Object.entries(node[field] ?? {})) {
        if (!dependency || typeof dependency !== 'object') continue;
        addVersion(dependencyName, dependency.version);
        if (!node.version.includes(':') && !String(dependency.version).includes(':')) {
          edges[`${name}@${node.version}>${dependencyName}`] = dependency.version;
        }
        visit(dependency, dependencyName);
      }
    }
  }

  for (const project of projects) visit(project);
  return {
    edges,
    singleVersions: Object.fromEntries(
      [...versions]
        .filter(([, known]) => known.size === 1)
        .map(([name, known]) => [name, [...known][0]]),
    ),
  };
}

function validatePackage(extractedPackageDir, sourceManifest, packedVersions) {
  const manifest = readJson(join(extractedPackageDir, 'package.json'));
  const files = listFiles(extractedPackageDir);
  const fileSet = new Set(files);

  if (
    manifest.name !== sourceManifest.name ||
    manifest.version !== sourceManifest.version
  ) {
    fail(`packed identity mismatch for ${sourceManifest.name}`);
  }
  if (manifest.private === true) fail(`${manifest.name} is still private`);
  if (manifest.license !== 'Apache-2.0') fail(`${manifest.name} has the wrong license`);
  if (manifest.engines?.node !== '>=24.0.0')
    fail(`${manifest.name} has the wrong Node engine`);
  if (manifest.sideEffects !== false)
    fail(`${manifest.name} must declare sideEffects false`);
  if (manifest.publishConfig?.access !== 'public') {
    fail(`${manifest.name} must publish with public access`);
  }
  if (manifest.publishConfig?.provenance !== true) {
    fail(`${manifest.name} must require npm provenance`);
  }
  if (manifest.repository?.url !== 'git+https://github.com/Vedant817/Fuse.git') {
    fail(`${manifest.name} has the wrong repository URL`);
  }
  if (manifest.repository?.directory !== sourceManifest.repository.directory) {
    fail(`${manifest.name} has the wrong repository directory`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail(`${manifest.name} needs an explicit files allowlist`);
  }
  if (JSON.stringify(manifest).includes('workspace:')) {
    fail(`${manifest.name} retained a workspace dependency in its tarball`);
  }

  for (const required of ['LICENSE', 'README.md', 'dist/index.js', 'dist/index.d.ts']) {
    if (!fileSet.has(required)) fail(`${manifest.name} is missing ${required}`);
  }
  if (
    readFileSync(join(extractedPackageDir, 'LICENSE'), 'utf8') !==
    readFileSync(join(rootDir, 'LICENSE'), 'utf8')
  ) {
    fail(`${manifest.name} did not include the canonical root LICENSE`);
  }

  const forbidden = files.filter((path) => {
    const lower = path.toLowerCase();
    return (
      lower.startsWith('src/') ||
      lower.includes('tsbuildinfo') ||
      /(^|[./-])(test|testing|demo|mock)([./-]|$)/u.test(lower)
    );
  });
  if (forbidden.length > 0) {
    fail(`${manifest.name} leaked non-public files: ${forbidden.join(', ')}`);
  }

  for (const target of collectExportTargets(manifest.exports)) {
    const normalized = target.replace(/^\.\//u, '');
    if (!fileSet.has(normalized))
      fail(`${manifest.name} export target is missing: ${target}`);
  }

  const expectedExports =
    manifest.name === '@fuse/sdk' ? ['.', './otel', './providers'] : ['.'];
  const exportNames = Object.keys(manifest.exports).sort();
  if (exportNames.join(',') !== expectedExports.sort().join(',')) {
    fail(`${manifest.name} has unintended public entry points: ${exportNames.join(',')}`);
  }
  for (const exportName of exportNames) {
    if (typeof manifest.exports[exportName]?.types !== 'string') {
      fail(`${manifest.name} ${exportName} export is missing a declaration target`);
    }
  }

  for (const javascript of files.filter(
    (path) => path.startsWith('dist/') && path.endsWith('.js'),
  )) {
    const stem = javascript.slice(0, -3);
    for (const companion of [`${javascript}.map`, `${stem}.d.ts`, `${stem}.d.ts.map`]) {
      if (!fileSet.has(companion)) {
        fail(`${manifest.name} is missing ${companion} for ${javascript}`);
      }
    }
  }

  if (manifest.name === '@fuse/sdk') {
    for (const dependency of ['@fuse/contracts', '@fuse/otel']) {
      if (manifest.dependencies?.[dependency] !== packedVersions.get(dependency)) {
        fail(
          `@fuse/sdk must depend on exact packed ${dependency} version ${packedVersions.get(dependency)}`,
        );
      }
    }
  }

  return { manifest, files };
}

console.log('Building workspace before packaging...');
runPnpm(['run', 'build']);

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(tarballDir, { recursive: true });

const packedVersions = new Map(
  packageSpecs.map((spec) => {
    const manifest = readJson(join(rootDir, spec.directory, 'package.json'));
    return [manifest.name, manifest.version];
  }),
);
const lockedGraph = collectLockedDependencyGraph(
  JSON.parse(
    runPnpm(
      [
        '--filter',
        '@fuse/contracts',
        '--filter',
        '@fuse/otel',
        '--filter',
        '@fuse/sdk',
        'list',
        '--prod',
        '--depth',
        'Infinity',
        '--json',
      ],
      { capture: true },
    ),
  ),
);
const artifacts = [];

for (const spec of packageSpecs) {
  const packageDir = join(rootDir, spec.directory);
  const sourceManifest = readJson(join(packageDir, 'package.json'));
  const archiveName = `${spec.name.slice(1).replace('/', '-')}-${sourceManifest.version}.tgz`;
  const archivePath = join(tarballDir, archiveName);
  runPnpm(['pack', '--out', archivePath, '--json'], { cwd: packageDir, capture: true });

  const inspectDir = mkdtempSync(join(tmpdir(), 'fuse-pack-inspect-'));
  try {
    run('tar', ['-xzf', archivePath, '-C', inspectDir]);
    const { files } = validatePackage(
      join(inspectDir, 'package'),
      sourceManifest,
      packedVersions,
    );
    const sizeBytes = statSync(archivePath).size;
    artifacts.push({
      name: archiveName,
      package: spec.name,
      sizeBytes,
      files: files.length,
    });
    console.log(`${archiveName}: ${sizeBytes} bytes, ${files.length} files`);
  } finally {
    rmSync(inspectDir, { recursive: true, force: true });
  }
}

writeFileSync(
  join(outputDir, 'artifacts.json'),
  `${JSON.stringify(artifacts, null, 2)}\n`,
);

if (packOnly) {
  console.log(`Validated package artifacts in ${relative(rootDir, tarballDir)}`);
  process.exit(0);
}

const consumerDir = mkdtempSync(join(tmpdir(), 'fuse-external-consumer-'));
try {
  if (realpathSync(consumerDir).startsWith(`${realpathSync(rootDir)}${sep}`)) {
    fail('consumer fixture must run outside the workspace');
  }
  cpSync(fixtureDir, consumerDir, { recursive: true });
  const consumerTarballs = join(consumerDir, 'tarballs');
  mkdirSync(consumerTarballs, { recursive: true });

  const consumerManifestPath = join(consumerDir, 'package.json');
  const consumerManifest = readJson(consumerManifestPath);
  consumerManifest.dependencies = {};
  const localPackages = {};
  for (const artifact of artifacts) {
    cpSync(join(tarballDir, artifact.name), join(consumerTarballs, artifact.name));
    const tarballReference = `file:tarballs/${artifact.name}`;
    consumerManifest.dependencies[artifact.package] = tarballReference;
    localPackages[artifact.package] = tarballReference;
  }
  writeFileSync(consumerManifestPath, `${JSON.stringify(consumerManifest, null, 2)}\n`);
  writeFileSync(
    join(consumerDir, '.pnpmfile.cjs'),
    `'use strict';\nconst localPackages = ${JSON.stringify(localPackages)};\nconst edges = ${JSON.stringify(lockedGraph.edges)};\nconst singleVersions = ${JSON.stringify(lockedGraph.singleVersions)};\nmodule.exports = { hooks: { readPackage(pkg) {\n  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {\n    if (!pkg[field]) continue;\n    for (const name of Object.keys(pkg[field])) {\n      const locked = edges[\`${'${pkg.name}'}@${'${pkg.version}'}>${'${name}'}\`] || singleVersions[name];\n      if (localPackages[name]) pkg[field][name] = localPackages[name];\n      else if (locked) pkg[field][name] = locked;\n    }\n  }\n  return pkg;\n} } };\n`,
  );

  const offlineInstallEnvironment = {
    ...process.env,
    CI: 'true',
    npm_config_offline: 'true',
    npm_config_registry: 'http://127.0.0.1:9/',
  };
  const storeDir = runPnpm(['store', 'path'], { capture: true });
  console.log(
    `Installing in non-workspace fixture ${consumerDir} with network disabled...`,
  );
  runPnpm(
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-frozen-lockfile',
      '--store-dir',
      storeDir,
    ],
    { cwd: consumerDir, env: offlineInstallEnvironment },
  );
  const executionEnvironment = {
    ...process.env,
    CI: 'true',
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  };
  runPnpm(['run', 'build'], { cwd: consumerDir, env: executionEnvironment });
  runPnpm(['run', 'start'], {
    cwd: consumerDir,
    env: executionEnvironment,
  });
} finally {
  if (existsSync(consumerDir)) rmSync(consumerDir, { recursive: true, force: true });
}

console.log('External tarball consumer smoke passed.');
