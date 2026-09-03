/* global structuredClone */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isAllowedSlackWebhookUrl, verifyRuleRoundTrip } from './contract.mjs';

const detectorRulePaths = [
  'infra/signoz/alerts/loop-signature.json',
  'infra/signoz/alerts/context-bloat.json',
  'infra/signoz/alerts/cost-velocity.json',
];
const operationalArtifactPath =
  'infra/signoz/alerts/operational-slos-v1-provisional.json';

function metricsOf(rule) {
  return rule.condition.compositeQuery.queries.flatMap((query) =>
    (query.spec.aggregations ?? []).flatMap((aggregation) =>
      aggregation.metricName ? [aggregation.metricName] : [],
    ),
  );
}

test('accepts only complete non-placeholder Slack Incoming Webhook URLs', () => {
  assert.equal(
    isAllowedSlackWebhookUrl('https://hooks.slack.com/services/T012/B034/secret567'),
    true,
  );
  for (const value of [
    'https://hooks.slack.com/services/REPLACE/ME',
    'https://hooks.slack.com/services/T012/B034/PLACEHOLDER',
    'https://hooks.slack.com/services/T012/B034/replace-with-real-secret',
    'https://example.com/services/T012/B034/secret567',
    'http://hooks.slack.com/services/T012/B034/secret567',
  ]) {
    assert.equal(isAllowedSlackWebhookUrl(value), false, value);
  }
});

test('all detector artifacts require source_epoch and verify its SigNoz round-trip', async () => {
  for (const path of detectorRulePaths) {
    const desired = JSON.parse(await readFile(path, 'utf8'));
    const groups = desired.condition.compositeQuery.queries[0].spec.groupBy.map(
      ({ name }) => name,
    );
    assert.ok(groups.includes('fuse.source_epoch'), path);
    assert.doesNotThrow(() => verifyRuleRoundTrip(desired, { data: [desired] }));

    const withoutEpoch = structuredClone(desired);
    withoutEpoch.condition.compositeQuery.queries[0].spec.groupBy =
      withoutEpoch.condition.compositeQuery.queries[0].spec.groupBy.filter(
        ({ name }) => name !== 'fuse.source_epoch',
      );
    assert.throws(
      () => verifyRuleRoundTrip(desired, { data: [withoutEpoch] }),
      /did not round-trip groupBy fuse\.source_epoch/,
    );
  }
});

test('provisioner updates rules and suppresses API response bodies', async () => {
  const script = await readFile('infra/signoz-alerts-up.sh', 'utf8');
  assert.match(script, /request "updating rule \$alert_name" PUT/);
  assert.match(script, /\/api\/v2\/rules\/\$rule_id/);
  assert.match(script, /verify-rule/);
  assert.match(script, /jq -c '\.\[\]'/);
  assert.match(script, /apply_channel fuse-operations/);
  assert.match(script, /response body suppressed/);
  assert.match(script, /auth\.curlrc/);
  assert.doesNotMatch(script, /Response:/);
  assert.doesNotMatch(script, /--arg (?:password|token)/);
  assert.doesNotMatch(script, /-H "Authorization: Bearer \$access_token"/);
  assert.doesNotMatch(script, /already exists.*skipping/i);
});

test('versioned operational SLO rules match emitted bounded metrics and notification semantics', async () => {
  const [rules, metricSource, operationsChannel] = await Promise.all([
    readFile(operationalArtifactPath, 'utf8').then(JSON.parse),
    readFile('packages/otel/src/metrics.ts', 'utf8'),
    readFile('infra/signoz/channels/fuse-operations.json', 'utf8').then(JSON.parse),
  ]);
  assert.equal(rules.length, 13);
  assert.equal(operationsChannel.name, 'fuse-operations');
  assert.equal(operationsChannel.slack_configs[0].send_resolved, true);

  const signals = new Set();
  const continuousNoDataSignals = new Set([
    'diagnosis-backlog',
    'diagnosis-dead-letters',
    'redis-readiness',
    'preflight-sweeper',
  ]);
  const forbiddenGroups = new Set([
    'fuse.tenant',
    'fuse.environment',
    'fuse.agent_id',
    'fuse.source_epoch',
    'fuse.correlation_id',
  ]);
  for (const rule of rules) {
    assert.equal(rule.version, 'v5', rule.alert);
    assert.equal(rule.schemaVersion, 'v2alpha1', rule.alert);
    assert.equal(rule.labels.fuse_slo_version, 'v1-provisional', rule.alert);
    assert.match(rule.alert, /-v1$/, rule.alert);
    assert.equal(typeof rule.condition.alertOnAbsent, 'boolean', rule.alert);
    assert.ok(Number.isInteger(rule.condition.absentFor), rule.alert);
    assert.match(rule.annotations.description, /resolv/i, rule.alert);
    assert.doesNotMatch(JSON.stringify(rule), /fuse-control-plane/, rule.alert);
    for (const threshold of rule.condition.thresholds.spec) {
      assert.deepEqual(threshold.channels, ['fuse-operations'], rule.alert);
    }
    const signal = rule.labels.fuse_signal;
    signals.add(signal);
    assert.equal(
      rule.condition.alertOnAbsent,
      continuousNoDataSignals.has(signal),
      `${rule.alert} no-data policy`,
    );
    for (const query of rule.condition.compositeQuery.queries) {
      if (query.type === 'builder_query') {
        assert.match(
          query.spec.filter?.expression ?? '',
          /fuse\.slo\.version = 'v1-provisional'/,
          `${rule.alert} version filter`,
        );
      }
      for (const group of query.spec.groupBy ?? []) {
        assert.equal(
          forbiddenGroups.has(group.name),
          false,
          `${rule.alert}: ${group.name}`,
        );
      }
    }
    for (const metric of metricsOf(rule)) {
      assert.ok(
        metricSource.includes(`'${metric}'`) || metricSource.includes(`"${metric}"`),
        metric,
      );
    }
    assert.doesNotThrow(() => verifyRuleRoundTrip(rule, { data: [rule] }), rule.alert);
  }

  for (const required of [
    'permit-p95',
    'permit-error-rate',
    'permit-deny-p95',
    'detector-observation-p95',
    'detector-observation-error-rate',
    'webhook-auth-failures',
    'webhook-processing-error-rate',
    'diagnosis-backlog',
    'diagnosis-dead-letters',
    'diagnosis-lease-renewal-failures',
    'redis-readiness',
    'preflight-stale-no-data',
    'preflight-sweeper',
  ]) {
    assert.ok(signals.has(required), required);
  }

  const desired = rules[0];
  const drifted = structuredClone(desired);
  drifted.condition.compositeQuery.queries[0].spec.filter.expression = '';
  assert.throws(
    () => verifyRuleRoundTrip(desired, { data: [drifted] }),
    /did not round-trip query A/,
  );
});
