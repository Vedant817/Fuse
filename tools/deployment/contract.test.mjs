import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse, parseAllDocuments } from 'yaml';

const readYaml = async (path) => parse(await readFile(path, 'utf8'));

test('runtime, migration, and maintenance workloads receive separate secrets', async () => {
  const [deployment, migration, maintenance, compose] = await Promise.all([
    readYaml('infra/production/kubernetes/deployment.yaml'),
    readYaml('infra/production/kubernetes/migration-job.yaml'),
    readYaml('infra/production/kubernetes/idempotency-cleanup-cronjob.yaml'),
    readYaml('infra/production/oci-free/compose.yaml'),
  ]);

  const runtimePod = deployment.spec.template.spec;
  assert.equal(runtimePod.serviceAccountName, 'fuse-control-plane');
  assert.deepEqual(
    runtimePod.containers[0].envFrom
      .map((entry) => entry.secretRef?.name)
      .filter(Boolean),
    ['fuse-control-plane-runtime-secrets'],
  );
  assert.equal(
    runtimePod.containers[0].env[0].valueFrom.secretKeyRef.name,
    'fuse-control-plane-runtime-secrets',
  );

  const migrationPod = migration.spec.template.spec;
  assert.equal(migrationPod.serviceAccountName, 'fuse-control-plane-migration');
  assert.equal(migrationPod.containers[0].envFrom, undefined);
  assert.deepEqual(migrationPod.containers[0].env, [
    {
      name: 'DATABASE_URL',
      valueFrom: {
        secretKeyRef: {
          name: 'fuse-control-plane-migration-secrets',
          key: 'DATABASE_URL',
        },
      },
    },
  ]);

  const maintenancePod = maintenance.spec.jobTemplate.spec.template.spec;
  assert.equal(maintenancePod.serviceAccountName, 'fuse-control-plane-maintenance');
  assert.equal(
    maintenancePod.containers[0].env.find(({ name }) => name === 'PGDATABASE').valueFrom
      .secretKeyRef.name,
    'fuse-control-plane-maintenance-secrets',
  );

  assert.match(compose.services.migrate.env_file[0], /FUSE_MIGRATION_ENV_FILE/);
  assert.match(compose.services['control-plane'].env_file[0], /FUSE_ENV_FILE/);
  assert.notEqual(
    compose.services.migrate.env_file[0],
    compose.services['control-plane'].env_file[0],
  );
});

test('database jobs use distinct identities and restricted network selectors', async () => {
  const [accountsSource, networkSource, service, deployment, budget] = await Promise.all([
    readFile('infra/production/kubernetes/service-account.yaml', 'utf8'),
    readFile('infra/production/kubernetes/network-policy.yaml', 'utf8'),
    readYaml('infra/production/kubernetes/service.yaml'),
    readYaml('infra/production/kubernetes/deployment.yaml'),
    readYaml('infra/production/kubernetes/pod-disruption-budget.yaml'),
  ]);
  const accounts = parseAllDocuments(accountsSource).map((document) => document.toJSON());
  assert.deepEqual(accounts.map((account) => account.metadata.name).sort(), [
    'fuse-control-plane',
    'fuse-control-plane-maintenance',
    'fuse-control-plane-migration',
  ]);
  assert.ok(accounts.every((account) => account.automountServiceAccountToken === false));

  const policies = parseAllDocuments(networkSource).map((document) => document.toJSON());
  const databaseJobs = policies.find(
    (policy) => policy.metadata.name === 'fuse-database-jobs',
  );
  assert.deepEqual(
    databaseJobs.spec.egress.flatMap((entry) => entry.ports.map(({ port }) => port)),
    [53, 53, 5432],
  );
  assert.deepEqual(databaseJobs.spec.ingress, []);

  for (const selector of [
    service.spec.selector,
    deployment.spec.selector.matchLabels,
    budget.spec.selector.matchLabels,
  ]) {
    assert.equal(selector['app.kubernetes.io/component'], 'control-plane');
  }
});

test('production examples require a separate exact-scope exporter evidence secret', async () => {
  const [envExample, deploymentSource, compose, runbook] = await Promise.all([
    readFile('.env.example', 'utf8'),
    readFile('infra/production/kubernetes/deployment.yaml', 'utf8'),
    readYaml('infra/production/oci-free/compose.yaml'),
    readFile('docs/runbooks/deployment.md', 'utf8'),
  ]);

  assert.match(
    envExample,
    /^CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS=[^:]+:[^:]+:[^:]+:changeme-/m,
  );
  assert.match(envExample, /^FUSE_PREFLIGHT_EXPORTER_TOKEN=changeme-/m);
  assert.match(deploymentSource, /CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS/);
  assert.match(
    compose.services['control-plane'].environment.CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS,
    /\$\{CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS:\?set an exact-scope/,
  );
  assert.match(runbook, /--from-literal=CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS=/);
  assert.match(runbook, /FUSE_PREFLIGHT_EXPORTER_TOKEN/);
});
