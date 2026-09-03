#!/usr/bin/env node
/**
 * Demonstrates the production enforcement semantics truthfully. The direct
 * in-process detector request commits the authoritative low-latency trip
 * before the next guarded call. The same detector result is exported to
 * SigNoz; its later alert webhook is independent corroboration/fallback, not
 * the mechanism credited with stopping this run. The direct proof requires
 * the control plane; SigNoz corroboration additionally requires healthy
 * telemetry export and provisioned alert rules/channel.
 *
 * Run with: pnpm --filter @fuse/broken-agent run demo:real-detect [loop|context-bloat|cost-velocity]
 */
import { randomUUID } from 'node:crypto';
import { FuseGuard, BreakerTrippedError } from '@fuse/sdk';
import { bootstrapFuseOtel } from '@fuse/sdk/otel';
import type { Scope } from '@fuse/contracts';
import { runAnalyzerVerifier, type Scenario } from './index.js';
import * as fmt from './demo-format.js';
import {
  parseOutageMode,
  parsePermitTimeoutMs,
  permitTimeoutOption,
} from './demo-config.js';

const CONTROL_PLANE_URL = (
  process.env['FUSE_CONTROL_PLANE_URL'] ?? 'http://localhost:8090'
).replace(/\/+$/, '');

const PERMIT_TIMEOUT_MS = parsePermitTimeoutMs(process.env['FUSE_PERMIT_TIMEOUT_MS']);
const SDK_OUTAGE_MODE = parseOutageMode(process.env['FUSE_SDK_OUTAGE_MODE']);

type BrokenScenario = Exclude<Scenario, 'normal'>;
const BROKEN_SCENARIOS = ['loop', 'context-bloat', 'cost-velocity'] as const;
const requestedScenario = process.argv[2] ?? 'loop';
if (!BROKEN_SCENARIOS.includes(requestedScenario as (typeof BROKEN_SCENARIOS)[number])) {
  fmt.fatal(`Unknown broken scenario: ${requestedScenario}`, [
    `Choose one of: ${BROKEN_SCENARIOS.join(', ')}`,
  ]);
}
const SCENARIO = requestedScenario as BrokenScenario;
const EXPECTED_DETECTOR: Record<BrokenScenario, string> = {
  loop: 'loop-signature',
  'context-bloat': 'context-bloat',
  'cost-velocity': 'cost-velocity',
};

function firstToken(envVar: string, scopeFields: number): string | undefined {
  const raw = process.env[envVar];
  if (!raw) return undefined;
  const first = raw.split(',')[0]!.trim();
  if (first.length === 0) return undefined;
  let separator = -1;
  for (let index = 0; index < scopeFields; index++) {
    separator = first.indexOf(':', separator + 1);
    if (separator < 0) return first;
  }
  return first.slice(separator + 1);
}

const OPERATOR_TOKEN = firstToken('CONTROL_PLANE_API_TOKENS', 1);
const AGENT_TOKEN = firstToken('CONTROL_PLANE_AGENT_API_TOKENS', 3) ?? OPERATOR_TOKEN;
const EXPORTER_EVIDENCE_TOKEN =
  process.env['FUSE_PREFLIGHT_EXPORTER_TOKEN'] ??
  firstToken('CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS', 3);

if (!OPERATOR_TOKEN) {
  fmt.fatal('CONTROL_PLANE_API_TOKENS is not set in this shell', [
    'Export the same token the control plane was started with.',
  ]);
}

async function checkControlPlane(): Promise<void> {
  try {
    const res = await fetch(`${CONTROL_PLANE_URL}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    fmt.fatal(`Cannot reach the control plane at ${CONTROL_PLANE_URL}`, [
      'Start it first — see README.md "Getting started".',
    ]);
  }
}

function scopeFor(agentId: string): Scope {
  return { tenant: 'demo', environment: 'local-demo', agentId };
}

async function registerScope(scope: Scope): Promise<void> {
  const res = await fetch(`${CONTROL_PLANE_URL}/v1/scopes/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPERATOR_TOKEN}`,
    },
    body: JSON.stringify({
      scope,
      policyVersion: 'fuse-production-v1',
      actor: { type: 'manual', id: 'user:demo-operator' },
      reason: 'real detector demo scope',
      correlationId: `demo-register-${randomUUID()}`,
    }),
  });
  if (!res.ok) {
    throw new Error(`scope registration failed: HTTP ${res.status} ${await res.text()}`);
  }
}

interface BreakerStatus {
  state: string;
  epoch: number;
  updatedBy?: { type: string; id: string };
}

async function getBreakerStatus(scope: Scope): Promise<BreakerStatus> {
  const res = await fetch(
    `${CONTROL_PLANE_URL}/v1/breaker/status?tenant=${scope.tenant}&environment=${scope.environment}&agentId=${scope.agentId}`,
    { headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } },
  );
  const body = (await res.json()) as { record: BreakerStatus };
  return body.record;
}

async function main(): Promise<void> {
  fmt.banner(
    'FUSE — direct enforcement with independent SigNoz corroboration',
    `control plane: ${CONTROL_PLANE_URL}`,
  );
  await checkControlPlane();
  fmt.ok('Control plane is reachable');

  const scope = scopeFor(`agent-real-detect-${SCENARIO}-${randomUUID().slice(0, 8)}`);
  const otel = bootstrapFuseOtel({
    serviceName: 'fuse-demo-real-detect',
    serviceVersion: '0.1.0',
    deploymentEnvironment: 'local-demo',
  });

  await registerScope(scope);
  fmt.kv('Scope', `${scope.tenant}/${scope.environment}/${scope.agentId}`);
  const guard = otel.registerGuard(
    new FuseGuard({
      scope,
      controlPlaneUrl: CONTROL_PLANE_URL,
      apiToken: AGENT_TOKEN!,
      ...(EXPORTER_EVIDENCE_TOKEN
        ? { exporterEvidenceToken: EXPORTER_EVIDENCE_TOKEN }
        : {}),
      ...permitTimeoutOption(PERMIT_TIMEOUT_MS),
      outageMode: SDK_OUTAGE_MODE,
    }),
  );

  fmt.act(
    `Running the ${SCENARIO} scenario with enough real evidence for the ` +
      `${EXPECTED_DETECTOR[SCENARIO]} detector's unchanged production defaults`,
  );
  const runStartedAt = Date.now();
  try {
    const result = await runAnalyzerVerifier({
      scenario: SCENARIO,
      seed: 1,
      guard,
      maxCalls: SCENARIO === 'context-bloat' ? 30 : 20,
    });
    fmt.kv('Stop reason (in-process)', result.stopReason);
    fmt.kv('Total calls', result.totalCalls);
    if (result.stopReason !== 'breaker-tripped') {
      throw new Error(
        `direct detector did not stop the run before its safety ceiling (got ${result.stopReason})`,
      );
    }
  } catch (err) {
    if (err instanceof BreakerTrippedError) {
      fmt.ok('The direct detector committed a trip while the run was active');
    } else {
      throw err;
    }
  }
  const runElapsedMs = Date.now() - runStartedAt;
  fmt.kv('In-process run duration', `${runElapsedMs}ms`);

  fmt.info(
    'Flushing any buffered step/telemetry reports immediately (not waiting on the 5s timer)...',
  );
  await guard.flushStepObservations();
  await otel.forceFlush().catch(() => {
    fmt.info(
      'OTLP export is unavailable; Preflight remains honestly unprotected while breaker enforcement continues.',
    );
  });
  guard.stopStepObservationReporting();

  const postRunStatus = await getBreakerStatus(scope);
  if (
    postRunStatus.state !== 'tripped' ||
    postRunStatus.updatedBy?.id !== `system:detector:${EXPECTED_DETECTOR[SCENARIO]}`
  ) {
    throw new Error(
      `expected an authoritative direct-detector trip, got state=${postRunStatus.state} actor=${postRunStatus.updatedBy?.id ?? 'unknown'}`,
    );
  }
  fmt.ok(
    `Authoritative trip committed at epoch ${postRunStatus.epoch} by ${postRunStatus.updatedBy.id}`,
  );

  let postTripDispatches = 0;
  try {
    await guard.guard(async () => {
      postTripDispatches += 1;
      return 'should-not-dispatch';
    }, `demo-post-trip-${randomUUID()}`);
    throw new Error('post-trip guarded call was unexpectedly permitted');
  } catch (err) {
    if (!(err instanceof BreakerTrippedError)) throw err;
  }
  if (postTripDispatches !== 0) {
    throw new Error(`provider dispatched ${postTripDispatches} calls after the trip`);
  }
  fmt.ok('The next guarded provider call was denied before dispatch (0 provider calls)');
  fmt.kv('Direct detection-to-enforcement run time', `${runElapsedMs}ms`);
  fmt.info(
    'When telemetry delivery is healthy, SigNoz receives the exported detector-fired signal ' +
      `asynchronously, bound to source breaker epoch ${postRunStatus.epoch - 1}. Its alert ` +
      'webhook is independent corroboration/fallback; this demo does not misattribute the ' +
      'low-latency stop to that delayed path.',
  );
  fmt.info(
    'An authorized resume is intentionally not performed here: a delayed alert from this old ' +
      'episode must not undo a later resume.',
  );

  try {
    await otel.shutdown();
  } catch {
    // Telemetry export failure must never make this proof itself look
    // like it failed — same principle as demo.ts.
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
