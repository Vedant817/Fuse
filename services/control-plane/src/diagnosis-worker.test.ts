import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scope } from '@fuse/contracts';
import type { DiagnosisWorkerConfig } from './diagnosis-worker.js';

const fetchIncidentEvidence = vi.fn();
const postIncidentCard = vi.fn();
const closeMock = vi.fn();

vi.mock('@fuse/diagnosis', async () => {
  const actual =
    await vi.importActual<typeof import('@fuse/diagnosis')>('@fuse/diagnosis');
  return {
    ...actual,
    SignozMcpClient: vi.fn().mockImplementation(() => ({ close: closeMock })),
    fetchIncidentEvidence: (...args: unknown[]) => fetchIncidentEvidence(...args),
    postIncidentCard: (...args: unknown[]) => postIncidentCard(...args),
  };
});

const { loadDiagnosisWorkerConfig, runDiagnosisAndNotify, selectOperatorTokenForTenant } =
  await import('./diagnosis-worker.js');

const SCOPE: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-1' };

function baseConfig(
  overrides: Partial<DiagnosisWorkerConfig> = {},
): DiagnosisWorkerConfig {
  return {
    mcpServerUrl: undefined,
    slackBotToken: undefined,
    slackChannel: '#x',
    localSnapshotDir: '/tmp/unused',
    slackSigningSecret: undefined,
    operatorToken: undefined,
    ...overrides,
  };
}

describe('Slack operator-token selection', () => {
  const TENANT_A_TOKEN = 'tenant-a-operator-token-0001';
  const TENANT_B_TOKEN = 'tenant-b-operator-token-0002';
  const WILDCARD_TOKEN = 'wildcard-operator-token-0003';

  it('strips the tenant prefix and selects the matching tenant token', () => {
    const config = loadDiagnosisWorkerConfig({
      CONTROL_PLANE_API_TOKENS: `tenant-a:${TENANT_A_TOKEN}`,
    });

    expect(selectOperatorTokenForTenant(config, 'tenant-a')).toBe(TENANT_A_TOKEN);
    expect(selectOperatorTokenForTenant(config, 'tenant-b')).toBeUndefined();
    expect(config.operatorToken).toBeUndefined();
  });

  it('selects independently from multiple tenant-scoped tokens', () => {
    const config = loadDiagnosisWorkerConfig({
      CONTROL_PLANE_API_TOKENS:
        `tenant-a:${TENANT_A_TOKEN},` + `tenant-b:${TENANT_B_TOKEN}`,
    });

    expect(selectOperatorTokenForTenant(config, 'tenant-a')).toBe(TENANT_A_TOKEN);
    expect(selectOperatorTokenForTenant(config, 'tenant-b')).toBe(TENANT_B_TOKEN);
    expect(selectOperatorTokenForTenant(config, 'tenant-c')).toBeUndefined();
  });

  it('prefers an exact tenant binding over a wildcard and deliberately falls back to the wildcard', () => {
    const config = loadDiagnosisWorkerConfig({
      CONTROL_PLANE_API_TOKENS: `${WILDCARD_TOKEN},` + `tenant-a:${TENANT_A_TOKEN}`,
    });

    expect(selectOperatorTokenForTenant(config, 'tenant-a')).toBe(TENANT_A_TOKEN);
    expect(selectOperatorTokenForTenant(config, 'tenant-b')).toBe(WILDCARD_TOKEN);
    expect(config.operatorToken).toBe(WILDCARD_TOKEN);
  });

  it('fails closed for an invalid token list instead of using its valid-looking entries', () => {
    const config = loadDiagnosisWorkerConfig({
      CONTROL_PLANE_API_TOKENS: `${TENANT_A_TOKEN},short`,
    });

    expect(config.operatorTokens).toEqual([]);
    expect(config.operatorToken).toBeUndefined();
    expect(selectOperatorTokenForTenant(config, 'tenant-a')).toBeUndefined();
  });

  it('fails closed when one bearer value is ambiguously bound to multiple tenants', () => {
    const reusedToken = 'reused-operator-token-0004';
    const config = loadDiagnosisWorkerConfig({
      CONTROL_PLANE_API_TOKENS: `tenant-a:${reusedToken},` + `tenant-b:${reusedToken}`,
    });

    expect(config.operatorTokens).toEqual([]);
    expect(selectOperatorTokenForTenant(config, 'tenant-a')).toBeUndefined();
    expect(selectOperatorTokenForTenant(config, 'tenant-b')).toBeUndefined();
  });

  it('preserves wildcard semantics for an existing manually-constructed config', () => {
    expect(
      selectOperatorTokenForTenant({ operatorToken: WILDCARD_TOKEN }, 'tenant-a'),
    ).toBe(WILDCARD_TOKEN);
    expect(
      selectOperatorTokenForTenant({ operatorToken: WILDCARD_TOKEN }, ''),
    ).toBeUndefined();
  });
});

describe('runDiagnosisAndNotify', () => {
  let snapshotDir: string;
  const logs: Array<{ msg: string; meta?: Record<string, unknown> | undefined }> = [];
  const log = (msg: string, meta?: Record<string, unknown>) => logs.push({ msg, meta });

  beforeEach(async () => {
    logs.length = 0;
    fetchIncidentEvidence.mockReset();
    postIncidentCard
      .mockReset()
      .mockResolvedValue({ posted: false, reason: 'no bot token' });
    closeMock.mockReset();
    snapshotDir = await mkdtemp(path.join(tmpdir(), 'fuse-incident-test-'));
  });

  afterEach(async () => {
    await rm(snapshotDir, { recursive: true, force: true });
  });

  it('skips diagnosis entirely for an unrecognized detector label', async () => {
    await runDiagnosisAndNotify(
      {
        scope: SCOPE,
        detector: 'not-a-real-detector',
        reason: 'r',
        correlationId: 'corr-1',
        startsAt: new Date().toISOString(),
      },
      baseConfig({ localSnapshotDir: snapshotDir }),
      log,
    );
    expect(fetchIncidentEvidence).not.toHaveBeenCalled();
    expect(postIncidentCard).not.toHaveBeenCalled();
    expect(logs.some((l) => l.msg.includes('unrecognized detector'))).toBe(true);
  });

  it('uses an unavailable evidence bundle (no MCP call) when mcpServerUrl is not configured', async () => {
    await runDiagnosisAndNotify(
      {
        scope: SCOPE,
        detector: 'loop-signature',
        reason: 'loop detected',
        correlationId: 'corr-2',
        startsAt: new Date().toISOString(),
      },
      baseConfig({ localSnapshotDir: snapshotDir }),
      log,
    );
    expect(fetchIncidentEvidence).not.toHaveBeenCalled();
    expect(postIncidentCard).toHaveBeenCalledOnce();
  });

  it('fetches real evidence via SignozMcpClient when mcpServerUrl is configured, and closes it', async () => {
    fetchIncidentEvidence.mockResolvedValue({
      available: true,
      spans: [],
      queryFilter: 'x',
      windowStart: 'a',
      windowEnd: 'b',
    });
    await runDiagnosisAndNotify(
      {
        scope: SCOPE,
        detector: 'context-bloat',
        reason: 'bloat detected',
        correlationId: 'corr-3',
        startsAt: new Date().toISOString(),
      },
      baseConfig({
        mcpServerUrl: 'http://localhost:8020/mcp',
        localSnapshotDir: snapshotDir,
      }),
      log,
    );
    expect(fetchIncidentEvidence).toHaveBeenCalledOnce();
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it('always writes a local HTML snapshot, regardless of Slack configuration', async () => {
    await runDiagnosisAndNotify(
      {
        scope: SCOPE,
        detector: 'cost-velocity',
        reason: 'spend spike',
        correlationId: 'corr-4',
        startsAt: new Date().toISOString(),
      },
      baseConfig({ localSnapshotDir: snapshotDir }),
      log,
    );
    const content = await readFile(path.join(snapshotDir, 'corr-4.html'), 'utf8');
    expect(content).toContain('<!doctype html>');
    expect(content).toContain('cost-velocity safeguard fired');
    expect(content).not.toContain('score $0.0000');
  });

  it('logs (but does not throw) when the Slack post is not delivered', async () => {
    postIncidentCard.mockResolvedValue({
      posted: false,
      reason: 'no Slack bot token configured',
    });
    await expect(
      runDiagnosisAndNotify(
        {
          scope: SCOPE,
          detector: 'loop-signature',
          reason: 'r',
          correlationId: 'corr-5',
          startsAt: new Date().toISOString(),
        },
        baseConfig({ localSnapshotDir: snapshotDir }),
        log,
      ),
    ).resolves.toBeUndefined();
    expect(logs.some((l) => l.msg.includes('not delivered'))).toBe(true);
  });

  it('logs Slack message identity after successful delivery', async () => {
    postIncidentCard.mockResolvedValue({ posted: true, ts: '1234.5678' });
    await runDiagnosisAndNotify(
      {
        scope: SCOPE,
        detector: 'loop-signature',
        reason: 'r',
        correlationId: 'corr-delivered',
        startsAt: new Date().toISOString(),
      },
      baseConfig({ localSnapshotDir: snapshotDir, slackChannel: 'C123' }),
      log,
    );
    expect(logs).toContainEqual({
      msg: 'Slack incident post delivered',
      meta: { channel: 'C123', ts: '1234.5678' },
    });
  });

  it('includes Resume only when Slack signing and a tenant-matching operator token make it usable', async () => {
    await runDiagnosisAndNotify(
      {
        scope: SCOPE,
        detector: 'loop-signature',
        reason: 'r',
        correlationId: 'corr-resume-action',
        startsAt: new Date().toISOString(),
      },
      baseConfig({
        localSnapshotDir: snapshotDir,
        slackBotToken: 'xoxb-test',
        slackSigningSecret: 'signing-secret',
        operatorTokens: [{ tenant: SCOPE.tenant, token: 'tenant-operator-token-0001' }],
      }),
      log,
    );

    const postedCard = postIncidentCard.mock.calls[0]?.[0] as
      { blocks?: unknown[] } | undefined;
    const blocks = JSON.stringify(postedCard?.blocks);
    expect(blocks).toContain('"action_id":"fuse_resume"');
    expect(blocks).toContain(JSON.stringify(JSON.stringify(SCOPE)).slice(1, -1));
  });

  it('omits Resume and logs why when no operator token matches the incident tenant', async () => {
    await runDiagnosisAndNotify(
      {
        scope: SCOPE,
        detector: 'loop-signature',
        reason: 'r',
        correlationId: 'corr-no-resume-action',
        startsAt: new Date().toISOString(),
      },
      baseConfig({
        localSnapshotDir: snapshotDir,
        slackBotToken: 'xoxb-test',
        slackSigningSecret: 'signing-secret',
        operatorTokens: [
          { tenant: 'different-tenant', token: 'other-operator-token-0001' },
        ],
      }),
      log,
    );

    const postedCard = postIncidentCard.mock.calls[0]?.[0] as
      { blocks?: unknown[] } | undefined;
    expect(JSON.stringify(postedCard?.blocks)).not.toContain('fuse_resume');
    expect(logs).toContainEqual({
      msg: 'Slack Resume action omitted: interactive authorization unavailable',
      meta: {
        hasSigningSecret: true,
        hasTenantOperatorToken: false,
        tenant: SCOPE.tenant,
      },
    });
  });

  it('never throws even if evidence fetch rejects unexpectedly', async () => {
    fetchIncidentEvidence.mockRejectedValue(new Error('boom'));
    await expect(
      runDiagnosisAndNotify(
        {
          scope: SCOPE,
          detector: 'loop-signature',
          reason: 'r',
          correlationId: 'corr-6',
          startsAt: new Date().toISOString(),
        },
        baseConfig({
          mcpServerUrl: 'http://localhost:8020/mcp',
          localSnapshotDir: snapshotDir,
        }),
        log,
      ),
    ).resolves.toBeUndefined();
    // the pipeline still completes (falls back to an unavailable bundle,
    // still writes a snapshot and attempts a Slack post)
    expect(postIncidentCard).toHaveBeenCalledOnce();
  });
});
