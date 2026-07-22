#!/usr/bin/env node
/**
 * Live, narrated demo of Fuse's core guarantee against a REAL running
 * control plane (Postgres-backed, real HTTP) — not a unit test, not a
 * mock. Requires the control plane already running; see the startup
 * hints this script prints if it can't reach one.
 *
 * Run with: pnpm --filter @fuse/broken-agent run demo
 */
import { randomUUID } from 'node:crypto';
import { bootstrapOtel } from '@fuse/otel';
import { FuseGuard, BreakerTrippedError } from '@fuse/sdk';
import { createGroqProvider, createNvidiaBuildProvider } from '@fuse/sdk/providers';
import type { Scope } from '@fuse/contracts';
import { runAnalyzerVerifier, defaultMockModel } from './index.js';
import type { Model } from './types.js';
import * as fmt from './demo-format.js';
import {
  parseOutageMode,
  parsePermitTimeoutMs,
  permitTimeoutOption,
} from './demo-config.js';

const CONTROL_PLANE_URL = (
  process.env['FUSE_CONTROL_PLANE_URL'] ?? 'http://localhost:8080'
).replace(/\/+$/, '');

// Same env var name and default as infra/signoz-up.sh's SIGNOZ_URL, so this
// message reflects wherever SigNoz was actually told to listen instead of a
// value hardcoded independently of that script.
const SIGNOZ_URL = (process.env['SIGNOZ_URL'] ?? 'http://localhost:8080').replace(
  /\/+$/,
  '',
);

// Wired from .env.example's "--- SDK ---" section so an operator who sets
// these before a real deployment actually changes this demo's FuseGuard
// behavior, instead of the values being silently ignored.
const PERMIT_TIMEOUT_MS = parsePermitTimeoutMs(process.env['FUSE_PERMIT_TIMEOUT_MS']);
const SDK_OUTAGE_MODE = parseOutageMode(process.env['FUSE_SDK_OUTAGE_MODE']);

function firstToken(envVar: string): string | undefined {
  const raw = process.env[envVar];
  if (!raw) return undefined;
  const first = raw.split(',')[0]!.trim();
  if (first.length === 0) return undefined;
  // Accept the `tenant:token` form (docs/adr/004-tenant-scoped-tokens.md)
  // and use just the token part for this demo's plain HTTP calls.
  const separator = first.indexOf(':');
  return separator > 0 ? first.slice(separator + 1) : first;
}

const OPERATOR_TOKEN = firstToken('CONTROL_PLANE_API_TOKENS');
const AGENT_TOKEN = firstToken('CONTROL_PLANE_AGENT_API_TOKENS') ?? OPERATOR_TOKEN;

if (!OPERATOR_TOKEN) {
  fmt.fatal('CONTROL_PLANE_API_TOKENS is not set in this shell', [
    'Export the same token the control plane was started with, e.g.:',
    '  export CONTROL_PLANE_API_TOKENS=<the value you started the server with>',
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
      'Start it first (in another terminal):',
      '  docker compose -f infra/docker-compose.yml up -d postgres',
      '  pnpm --filter @fuse/breaker-store run migrate',
      '  CONTROL_PLANE_API_TOKENS=<token> CONTROL_PLANE_AGENT_API_TOKENS=<token> \\',
      '    pnpm --filter @fuse/control-plane run dev',
    ]);
  }
}

function scopeFor(agentId: string): Scope {
  return { tenant: 'demo', environment: 'local-demo', agentId };
}

function loggingModel(inner: Model): Model {
  return {
    async call(args) {
      const r = await inner.call(args);
      fmt.round(args.round, args.role, r.content, r.inputTokens, r.outputTokens);
      return r;
    },
  };
}

async function tripViaRealApi(scope: Scope, reason: string): Promise<void> {
  const res = await fetch(`${CONTROL_PLANE_URL}/v1/breaker/trip`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPERATOR_TOKEN}`,
    },
    body: JSON.stringify({
      scope,
      reason,
      policyVersion: 'demo-v1',
      cooldownSeconds: 60,
      actor: { type: 'system', id: 'system:demo-detector' },
      correlationId: `demo-trip-${randomUUID()}`,
      idempotencyKey: `demo-trip-${randomUUID()}`,
    }),
  });
  if (!res.ok) fmt.fatal(`Trip API call failed: HTTP ${res.status}`);
  const body = (await res.json()) as { record: { state: string } };
  fmt.ok(
    `Breaker tripped for real via the operational API — state: ${body.record.state}`,
  );
}

async function resumeViaRealApi(scope: Scope, reason: string): Promise<void> {
  const res = await fetch(`${CONTROL_PLANE_URL}/v1/breaker/resume`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPERATOR_TOKEN}`,
    },
    body: JSON.stringify({
      scope,
      reason,
      actor: { type: 'manual', id: 'user:demo-operator' },
      correlationId: `demo-resume-${randomUUID()}`,
      idempotencyKey: `demo-resume-${randomUUID()}`,
    }),
  });
  if (!res.ok) fmt.fatal(`Resume API call failed: HTTP ${res.status}`);
  const body = (await res.json()) as { record: { state: string } };
  fmt.ok(`Breaker resumed — state: ${body.record.state}`);
}

async function main(): Promise<void> {
  fmt.banner('FUSE — live demo', `control plane: ${CONTROL_PLANE_URL}`);

  await checkControlPlane();
  fmt.ok('Control plane is reachable');
  if (AGENT_TOKEN === OPERATOR_TOKEN) {
    fmt.warn(
      'CONTROL_PLANE_AGENT_API_TOKENS not set — reusing the operator token for guard() calls',
    );
  }

  const otel = bootstrapOtel({
    serviceName: 'fuse-demo',
    serviceVersion: '0.1.0',
    deploymentEnvironment: 'local-demo',
  });

  const summary: string[] = [];

  try {
    // --- Act 1: a normal run terminates cleanly, no false trip ---
    fmt.act('Normal run — the verifier approves quickly');
    const guard1 = new FuseGuard({
      scope: scopeFor(`agent-normal-${randomUUID().slice(0, 8)}`),
      controlPlaneUrl: CONTROL_PLANE_URL,
      apiToken: AGENT_TOKEN!,
      ...permitTimeoutOption(PERMIT_TIMEOUT_MS),
      outageMode: SDK_OUTAGE_MODE,
    });
    const result1 = await runAnalyzerVerifier({
      scenario: 'normal',
      seed: 1,
      guard: guard1,
      model: loggingModel(defaultMockModel),
    });
    fmt.kv('Stop reason', result1.stopReason);
    fmt.kv('Total calls', result1.totalCalls);
    fmt.kv('Total tokens', result1.totalTokens);
    fmt.kv('Estimated spend', `$${result1.estimatedSpendUsd.toFixed(6)}`);
    await guard1.flushPreflightTelemetry();
    guard1.stopPreflightReporting();
    summary.push('Normal run terminated via verifier approval — no false trip.');

    // --- Act 2: a pathological scenario is bounded by the fixture's own ceiling ---
    fmt.act("Loop scenario — never approves, stopped by the fixture's own hard ceiling");
    const guard2 = new FuseGuard({
      scope: scopeFor(`agent-loop-${randomUUID().slice(0, 8)}`),
      controlPlaneUrl: CONTROL_PLANE_URL,
      apiToken: AGENT_TOKEN!,
      ...permitTimeoutOption(PERMIT_TIMEOUT_MS),
      outageMode: SDK_OUTAGE_MODE,
    });
    const result2 = await runAnalyzerVerifier({
      scenario: 'loop',
      seed: 1,
      guard: guard2,
      model: loggingModel(defaultMockModel),
      maxCalls: 6,
    });
    fmt.kv('Stop reason', result2.stopReason);
    fmt.kv('Total calls', result2.totalCalls);
    if (result2.stopReason === 'safety-ceiling') {
      fmt.ok(
        'Stopped by the in-process safety ceiling — before any external detector had to act',
      );
    }
    await guard2.flushPreflightTelemetry();
    guard2.stopPreflightReporting();
    summary.push(
      "A repeating (loop) scenario was capped by the fixture's own hard ceiling.",
    );

    // --- Act 3: THE CORE CLAIM ---
    fmt.act('THE CORE CLAIM — an external trip stops the very next call, mid-run');
    const scope3 = scopeFor(`agent-trip-${randomUUID().slice(0, 8)}`);
    const guard3 = new FuseGuard({
      scope: scope3,
      controlPlaneUrl: CONTROL_PLANE_URL,
      apiToken: AGENT_TOKEN!,
      ...permitTimeoutOption(PERMIT_TIMEOUT_MS),
      outageMode: SDK_OUTAGE_MODE,
    });

    let dispatchCount = 0;
    const trippingModel: Model = {
      async call(args) {
        dispatchCount += 1;
        const r = await defaultMockModel.call(args);
        fmt.round(args.round, args.role, r.content, r.inputTokens, r.outputTokens);
        if (dispatchCount === 3) {
          fmt.warn(
            'Simulating a detector firing — calling the REAL /v1/breaker/trip endpoint now...',
          );
          await tripViaRealApi(scope3, 'demo: loop-signature detector fired');
        }
        return r;
      },
    };

    const result3 = await runAnalyzerVerifier({
      scenario: 'loop',
      seed: 1,
      guard: guard3,
      model: trippingModel,
      maxCalls: 20,
    });
    fmt.kv('Stop reason', result3.stopReason);
    fmt.kv('Model dispatches that actually happened', dispatchCount);
    const coreGuaranteeHeld =
      result3.stopReason === 'breaker-tripped' && dispatchCount === 3;
    if (coreGuaranteeHeld) {
      fmt.ok(
        `Exactly ${dispatchCount} calls reached the model — zero after the trip committed`,
      );
    } else {
      fmt.fail('Unexpected result — investigate before trusting this build');
    }

    fmt.info('Attempting 3 more direct calls after the trip — expecting all denied...');
    let deniedCount = 0;
    for (let i = 0; i < 3; i++) {
      try {
        await guard3.guard(() =>
          defaultMockModel.call({
            role: 'analyzer',
            round: 99,
            historyLength: 0,
            scenario: 'normal',
            seed: 1,
          }),
        );
      } catch (err) {
        if (err instanceof BreakerTrippedError) {
          deniedCount += 1;
          fmt.fail(`Denied: ${err.reason}`);
        } else {
          throw err;
        }
      }
    }
    fmt.kv('Additional calls attempted', 3);
    fmt.kv('Additional calls denied', deniedCount);
    summary.push(
      coreGuaranteeHeld && deniedCount === 3
        ? `A real external trip stopped dispatch after exactly ${dispatchCount} calls — 0 after, proven over ${dispatchCount + 3} total attempts.`
        : 'The core guarantee did NOT hold as expected — see output above.',
    );

    // --- Act 4: resume ---
    fmt.act('Resume — an operator restores access');
    await resumeViaRealApi(scope3, 'demo: operator verified and resumed');
    const postResume = await guard3.guard(() =>
      defaultMockModel.call({
        role: 'analyzer',
        round: 100,
        historyLength: 0,
        scenario: 'normal',
        seed: 1,
      }),
    );
    fmt.ok(
      `Guarded call succeeded again after resume (${postResume.inputTokens + postResume.outputTokens} tokens)`,
    );
    summary.push('Operator resume restored access; a guarded call succeeded again.');

    // --- Act 5: Preflight ---
    fmt.act('Preflight — telemetry-health status for the scope used above');
    await guard3.flushPreflightTelemetry();
    guard3.stopPreflightReporting();
    const statusRes = await fetch(
      `${CONTROL_PLANE_URL}/v1/preflight/status?tenant=${scope3.tenant}&environment=${scope3.environment}&agentId=${scope3.agentId}`,
      { headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } },
    );
    if (statusRes.ok) {
      const body = (await statusRes.json()) as {
        result: { state: string; reasonCode: string; reason: string };
      };
      fmt.kv('State', body.result.state);
      fmt.kv('Reason code', body.result.reasonCode);
      fmt.kv('Reason', body.result.reason);
      summary.push(`Preflight reports this scope as "${body.result.state}".`);
    } else {
      fmt.warn('No Preflight data available yet for this scope');
    }

    // --- Act 6 (optional): a real LLM call through the guard ---
    const groqKey = process.env['GROQ_API_KEY'];
    const nvidiaKey = process.env['NVIDIA_API_KEY'];
    if (groqKey || nvidiaKey) {
      const providerName = groqKey ? 'Groq' : 'NVIDIA Build';
      fmt.act(
        `Real LLM call — ${providerName}, guarded exactly like any other provider call`,
      );
      const provider = groqKey
        ? createGroqProvider({ apiKey: groqKey })
        : createNvidiaBuildProvider({ apiKey: nvidiaKey! });
      const model =
        process.env['FUSE_DEMO_MODEL'] ??
        (groqKey ? 'llama-3.1-8b-instant' : 'meta/llama-3.1-8b-instruct');
      const guard4 = new FuseGuard({
        scope: scopeFor(`agent-real-llm-${randomUUID().slice(0, 8)}`),
        controlPlaneUrl: CONTROL_PLANE_URL,
        apiToken: AGENT_TOKEN!,
        ...permitTimeoutOption(PERMIT_TIMEOUT_MS),
        outageMode: SDK_OUTAGE_MODE,
      });
      const real = await guard4.guard(() =>
        provider.chatCompletion({
          model,
          messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }],
          max_tokens: 10,
        }),
      );
      fmt.ok(
        `Real response from ${providerName} (${model}): "${real.choices[0]?.message.content}"`,
      );
      fmt.kv('Tokens used', real.usage.total_tokens);
      guard4.stopPreflightReporting();
      summary.push(
        `A real ${providerName} call was made and guarded like any other provider call.`,
      );
    } else {
      fmt.act('Real LLM call — skipped');
      fmt.info(
        'Set GROQ_API_KEY or NVIDIA_API_KEY to include a real (non-mocked) provider call here',
      );
    }

    fmt.summaryBox(summary);

    // Flushing telemetry is best-effort here, same principle as the SDK's
    // own PreflightReporter: a telemetry-export failure (e.g. SigNoz isn't
    // running — a fully valid, unconfigured-by-default state) must never
    // make the demo itself look like it failed.
    try {
      await otel.shutdown();
      console.log(
        fmt.dim(
          `\nTelemetry flushed. Open SigNoz to see these traces/metrics: ${SIGNOZ_URL}\n` +
            (SIGNOZ_URL === CONTROL_PLANE_URL
              ? '(Note: SIGNOZ_URL and the control plane URL are both set to the same ' +
                'address — by default both listen on :8080, so at most one can actually ' +
                'be reachable there. Set SIGNOZ_URL to the port SigNoz is really on if ' +
                'you run both at once.)\n'
              : ''),
        ),
      );
    } catch {
      console.log(
        fmt.dim(
          '\n(Telemetry export skipped — no OTLP collector reachable at ' +
            `${process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318'}. ` +
            'Run `infra/signoz-up.sh` first if you want to see these traces/metrics.)\n',
        ),
      );
    }
  } catch (err) {
    await otel.shutdown().catch(() => {});
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
