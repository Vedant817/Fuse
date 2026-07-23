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

const { runDiagnosisAndNotify } = await import('./diagnosis-worker.js');

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
    expect(content).toContain('Estimated spend in the trailing window');
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
