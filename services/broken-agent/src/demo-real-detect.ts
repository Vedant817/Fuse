#!/usr/bin/env node
/**
 * Proves task.md §4's remaining open item end to end: a REAL SigNoz alert
 * rule (infra/signoz/alerts/loop-signature.json, provisioned by
 * infra/signoz-alerts-up.sh), evaluating REAL telemetry this run reports,
 * trips the breaker — with no manual `tripViaRealApi`-style shortcut
 * anywhere in this file, unlike demo.ts's Act 3. Requires the control
 * plane, self-hosted SigNoz, and the alert rules/channel to already be
 * running/provisioned (see infra/signoz-up.sh and infra/signoz-alerts-up.sh).
 *
 * Run with: pnpm --filter @fuse/broken-agent run demo:real-detect
 */
import { randomUUID } from 'node:crypto';
import { bootstrapOtel } from '@fuse/otel';
import { FuseGuard, BreakerTrippedError } from '@fuse/sdk';
import type { Scope } from '@fuse/contracts';
import { runAnalyzerVerifier } from './index.js';
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

function firstToken(envVar: string): string | undefined {
  const raw = process.env[envVar];
  if (!raw) return undefined;
  const first = raw.split(',')[0]!.trim();
  if (first.length === 0) return undefined;
  const separator = first.indexOf(':');
  return separator > 0 ? first.slice(separator + 1) : first;
}

const OPERATOR_TOKEN = firstToken('CONTROL_PLANE_API_TOKENS');
const AGENT_TOKEN = firstToken('CONTROL_PLANE_AGENT_API_TOKENS') ?? OPERATOR_TOKEN;

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

async function resumeDirectDetectorTrip(scope: Scope): Promise<void> {
  const res = await fetch(`${CONTROL_PLANE_URL}/v1/breaker/resume`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPERATOR_TOKEN}`,
    },
    body: JSON.stringify({
      scope,
      reason:
        'clear the synchronous Fuse detector trip so this demo can independently prove the SigNoz webhook path',
      actor: { type: 'manual', id: 'user:demo-operator' },
      correlationId: `demo-real-detect-resume-${randomUUID()}`,
      idempotencyKey: `demo-real-detect-resume-${randomUUID()}`,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `direct-detector reset failed: HTTP ${res.status} ${await res.text()}`,
    );
  }
}

async function main(): Promise<void> {
  fmt.banner(
    'FUSE — real SigNoz-alert-to-trip proof',
    `control plane: ${CONTROL_PLANE_URL}`,
  );
  await checkControlPlane();
  fmt.ok('Control plane is reachable');

  const otel = bootstrapOtel({
    serviceName: 'fuse-demo-real-detect',
    serviceVersion: '0.1.0',
    deploymentEnvironment: 'local-demo',
  });

  const scope = scopeFor(`agent-real-detect-${randomUUID().slice(0, 8)}`);
  await registerScope(scope);
  fmt.kv('Scope', `${scope.tenant}/${scope.environment}/${scope.agentId}`);
  const guard = new FuseGuard({
    scope,
    controlPlaneUrl: CONTROL_PLANE_URL,
    apiToken: AGENT_TOKEN!,
    ...permitTimeoutOption(PERMIT_TIMEOUT_MS),
    outageMode: SDK_OUTAGE_MODE,
  });

  fmt.act(
    'Running the loop scenario — enough rounds for the real loop-signature ' +
      'detector to fire on genuinely-reported step telemetry',
  );
  const runStartedAt = Date.now();
  let stopReasonAtRunEnd = 'not-yet-run';
  try {
    const result = await runAnalyzerVerifier({
      scenario: 'loop',
      seed: 1,
      guard,
      maxCalls: 20,
    });
    stopReasonAtRunEnd = result.stopReason;
    fmt.kv('Stop reason (in-process)', result.stopReason);
    fmt.kv('Total calls', result.totalCalls);
  } catch (err) {
    if (err instanceof BreakerTrippedError) {
      stopReasonAtRunEnd = 'breaker-tripped-mid-run';
      fmt.ok(
        'The breaker tripped WHILE the run was still going — even faster than expected',
      );
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
  await guard.flushPreflightTelemetry();
  guard.stopStepObservationReporting();
  guard.stopPreflightReporting();

  const postRunStatus = await getBreakerStatus(scope);
  if (
    postRunStatus.state === 'tripped' &&
    !postRunStatus.updatedBy?.id.startsWith('system:signoz-webhook:')
  ) {
    fmt.info(
      `The production pre-call path already tripped synchronously via ` +
        `"${postRunStatus.updatedBy?.id ?? 'unknown'}". Clearing that trip once so the ` +
        'separate SigNoz alert/webhook path can be proved without attribution ambiguity...',
    );
    await resumeDirectDetectorTrip(scope);
    const resumed = await getBreakerStatus(scope);
    if (resumed.state !== 'armed') {
      throw new Error(
        `expected the verification reset to arm the breaker, got ${resumed.state}`,
      );
    }
    fmt.ok('Direct detector trip cleared; breaker is armed while SigNoz evaluates');
  }

  fmt.act(
    'Waiting for the REAL SigNoz alert rule to evaluate and trip this scope ' +
      '(no manual trip call in this script) — SigNoz evaluates on a 1-minute cadence',
  );
  const waitStartedAt = Date.now();
  const MAX_WAIT_MS = 8 * 60_000;
  const POLL_INTERVAL_MS = 5_000;
  let tripped = false;
  while (Date.now() - waitStartedAt < MAX_WAIT_MS) {
    const status = await getBreakerStatus(scope);
    if (
      status.state === 'tripped' &&
      status.updatedBy?.id.startsWith('system:signoz-webhook:')
    ) {
      tripped = true;
      break;
    }
    if (status.state === 'tripped') {
      throw new Error(
        `breaker was tripped by "${status.updatedBy?.id ?? 'unknown'}", not the SigNoz webhook`,
      );
    }
    fmt.info(
      `  ...still "${status.state}", ${Math.round((Date.now() - waitStartedAt) / 1000)}s elapsed`,
    );
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const waitElapsedMs = Date.now() - waitStartedAt;

  if (tripped) {
    fmt.ok(
      `Breaker for ${scope.agentId} is TRIPPED — a real SigNoz alert rule fired and the ` +
        'webhook trip landed, with no manual trip call anywhere in this script.',
    );
    fmt.kv('Time from run start to trip observed', `${runElapsedMs + waitElapsedMs}ms`);
    fmt.kv(
      'Time from run end to trip observed (dominated by SigNoz eval cadence)',
      `${waitElapsedMs}ms`,
    );
  } else {
    fmt.fail(
      `Breaker never tripped within ${MAX_WAIT_MS / 1000}s. Check: is infra/signoz-alerts-up.sh ` +
        'provisioned? Is the SigNoz otel-collector receiving fuse.detector.fired? ' +
        `(in-process stop reason was "${stopReasonAtRunEnd}")`,
    );
    process.exitCode = 1;
  }

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
