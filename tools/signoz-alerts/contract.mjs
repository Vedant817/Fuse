/* global URL, console, process */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PLACEHOLDER_SEGMENT = /(?:change-?me|example|placeholder|replace)/i;

export function isAllowedSlackWebhookUrl(value) {
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'hooks.slack.com' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      segments.length === 4 &&
      segments[0] === 'services' &&
      segments
        .slice(1)
        .every(
          (segment) =>
            /^[A-Za-z0-9_-]+$/.test(segment) && !PLACEHOLDER_SEGMENT.test(segment),
        )
    );
  } catch {
    return false;
  }
}

function groupByNames(rule) {
  const queries = rule?.condition?.compositeQuery?.queries;
  if (!Array.isArray(queries)) return [];
  return queries.flatMap((query) => {
    const groupBy = query?.spec?.groupBy;
    return Array.isArray(groupBy)
      ? groupBy.map((entry) => entry?.name).filter((name) => typeof name === 'string')
      : [];
  });
}

function metricNames(rule) {
  const queries = rule?.condition?.compositeQuery?.queries;
  if (!Array.isArray(queries)) return [];
  return queries
    .map((query) => query?.spec?.aggregations)
    .filter(Array.isArray)
    .flat()
    .map((aggregation) => aggregation?.metricName)
    .filter((name) => typeof name === 'string');
}

function queriesByName(rule) {
  const queries = rule?.condition?.compositeQuery?.queries;
  return new Map(
    (Array.isArray(queries) ? queries : [])
      .filter((query) => typeof query?.spec?.name === 'string')
      .map((query) => [query.spec.name, query]),
  );
}

export function verifyRuleRoundTrip(desiredRule, responsePayload) {
  const rules = responsePayload?.data;
  if (!Array.isArray(rules))
    throw new Error('SigNoz rule list response has no data array');
  const persisted = rules.find((rule) => rule?.alert === desiredRule?.alert);
  if (!persisted) throw new Error(`SigNoz did not return rule ${desiredRule?.alert}`);

  const desiredGroups = groupByNames(desiredRule);
  const persistedGroups = new Set(groupByNames(persisted));
  for (const group of desiredGroups) {
    if (!persistedGroups.has(group)) {
      throw new Error(
        `SigNoz rule ${desiredRule.alert} did not round-trip groupBy ${group}`,
      );
    }
  }
  if (
    desiredGroups.includes('fuse.source_epoch') &&
    !persistedGroups.has('fuse.source_epoch')
  ) {
    throw new Error(`SigNoz rule ${desiredRule.alert} lost fuse.source_epoch`);
  }
  if (desiredRule.version === 'v5') {
    if (persisted.version !== desiredRule.version) {
      throw new Error(`SigNoz rule ${desiredRule.alert} did not round-trip version`);
    }
    if (persisted.schemaVersion !== desiredRule.schemaVersion) {
      throw new Error(
        `SigNoz rule ${desiredRule.alert} did not round-trip schemaVersion`,
      );
    }
    if (
      persisted.condition?.alertOnAbsent !== desiredRule.condition?.alertOnAbsent ||
      persisted.condition?.absentFor !== desiredRule.condition?.absentFor
    ) {
      throw new Error(
        `SigNoz rule ${desiredRule.alert} did not round-trip no-data policy`,
      );
    }
    const persistedMetrics = new Set(metricNames(persisted));
    for (const name of metricNames(desiredRule)) {
      if (!persistedMetrics.has(name)) {
        throw new Error(
          `SigNoz rule ${desiredRule.alert} did not round-trip metric ${name}`,
        );
      }
    }
    if (
      persisted.condition?.selectedQueryName !== desiredRule.condition?.selectedQueryName
    ) {
      throw new Error(`SigNoz rule ${desiredRule.alert} changed selected query`);
    }
    const persistedQueries = queriesByName(persisted);
    for (const [name, desiredQuery] of queriesByName(desiredRule)) {
      const persistedQuery = persistedQueries.get(name);
      if (
        !persistedQuery ||
        persistedQuery.spec?.filter?.expression !== desiredQuery.spec?.filter?.expression
      ) {
        throw new Error(
          `SigNoz rule ${desiredRule.alert} did not round-trip query ${name}`,
        );
      }
    }
    const desiredThresholds = desiredRule.condition?.thresholds?.spec ?? [];
    const persistedThresholds = persisted.condition?.thresholds?.spec ?? [];
    for (const desiredThreshold of desiredThresholds) {
      const persistedThreshold = persistedThresholds.find(
        (threshold) => threshold?.name === desiredThreshold?.name,
      );
      for (const field of ['op', 'matchType', 'target']) {
        if (persistedThreshold?.[field] !== desiredThreshold?.[field]) {
          throw new Error(
            `SigNoz rule ${desiredRule.alert} did not round-trip threshold ${desiredThreshold?.name}`,
          );
        }
      }
      for (const channel of desiredThreshold?.channels ?? []) {
        if (!persistedThreshold?.channels?.includes(channel)) {
          throw new Error(`SigNoz rule ${desiredRule.alert} lost channel ${channel}`);
        }
      }
    }
    if (persisted.labels?.fuse_slo_version !== desiredRule.labels?.fuse_slo_version) {
      throw new Error(`SigNoz rule ${desiredRule.alert} lost SLO version label`);
    }
  }
}

async function main() {
  const [command, desiredPath, responsePath] = process.argv.slice(2);
  if (command === 'validate-slack-webhook') {
    if (!isAllowedSlackWebhookUrl(process.env.PREFLIGHT_SLACK_WEBHOOK_URL ?? '')) {
      throw new Error(
        'PREFLIGHT_SLACK_WEBHOOK_URL must be a non-placeholder Slack app Incoming Webhook',
      );
    }
    return;
  }
  if (command === 'verify-rule' && desiredPath && responsePath) {
    const [desired, response] = await Promise.all([
      readFile(desiredPath, 'utf8').then(JSON.parse),
      readFile(responsePath, 'utf8').then(JSON.parse),
    ]);
    verifyRuleRoundTrip(desired, response);
    return;
  }
  throw new Error(
    'usage: contract.mjs validate-slack-webhook | verify-rule RULE RESPONSE',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
