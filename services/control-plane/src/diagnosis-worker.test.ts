import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreflightState, Scope } from '@fuse/contracts';
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
    slackAuthorizedUserIds: [],
    slackTeamId: undefined,
    operatorToken: undefined,
    ...overrides,
  };
}

function preflightStatusResponse(state: PreflightState, scope: Scope = SCOPE): Response {
  const reasonCode = {
    protected: 'healthy',
    degraded: 'missing-required-fields',
    blind: 'no-signal',
    disabled: 'operator-disabled',
  }[state];
  return new Response(
    JSON.stringify({
      result: {
        scope,
        state,
        reasonCode,
        reason: `committed ${state} result`,
        evaluatedAt: '2026-08-24T12:00:00.000Z',
        lastGoodAt: state === 'protected' ? '2026-08-24T12:00:00.000Z' : null,
        requiredFieldCoveragePercent: state === 'protected' ? 100 : 0,
        orphanRatePercent: 0,
        freshnessMs: state === 'blind' ? null : 0,
        pendingRecoveryState: null,
        pendingSince: null,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
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

describe('Slack actor authorization config', () => {
  it('loads explicit user ids and an optional team id', () => {
    const config = loadDiagnosisWorkerConfig({
      SLACK_AUTHORIZED_USER_IDS: 'U123,W456,U123',
      SLACK_TEAM_ID: 'T789',
    });

    expect(config.slackAuthorizedUserIds).toEqual(['U123', 'W456']);
    expect(config.slackTeamId).toBe('T789');
  });

  it('fails closed for malformed user or team ids', () => {
    expect(
      loadDiagnosisWorkerConfig({
        SLACK_AUTHORIZED_USER_IDS: 'U123,not-a-user',
      }).slackAuthorizedUserIds,
    ).toEqual([]);
    expect(
      loadDiagnosisWorkerConfig({
        SLACK_AUTHORIZED_USER_IDS: 'U123',
        SLACK_TEAM_ID: 'not-a-team',
      }).slackAuthorizedUserIds,
    ).toEqual([]);
  });

  it('targets the same-process Preflight status route on the configured port', () => {
    expect(
      loadDiagnosisWorkerConfig({ CONTROL_PLANE_PORT: '8181' }).preflightStatusUrl,
    ).toBe('http://127.0.0.1:8181/v1/preflight/status');
  });
});

describe('runDiagnosisAndNotify', () => {
  let snapshotDir: string;
  let restoreFetch: (() => void) | undefined;
  const logs: Array<{ msg: string; meta?: Record<string, unknown> | undefined }> = [];
  const log = (msg: string, meta?: Record<string, unknown>) => logs.push({ msg, meta });
  const mockPreflightFetch = (response: Response) => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    restoreFetch = () => spy.mockRestore();
    return spy;
  };

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
    restoreFetch?.();
    restoreFetch = undefined;
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
    expect(content).toContain('Preflight:</span> unknown');
  });

  it.each(['degraded', 'blind'] as const)(
    'reads and renders the current committed %s Preflight state for the exact incident scope',
    async (state) => {
      const fetchSpy = mockPreflightFetch(preflightStatusResponse(state));
      postIncidentCard.mockResolvedValue({ posted: true, ts: '1234.5678' });

      await runDiagnosisAndNotify(
        {
          scope: SCOPE,
          detector: 'loop-signature',
          reason: 'r',
          correlationId: `corr-preflight-${state}`,
          startsAt: new Date().toISOString(),
        },
        baseConfig({
          localSnapshotDir: snapshotDir,
          preflightStatusUrl: 'http://127.0.0.1:8090/v1/preflight/status',
          operatorTokens: [
            { tenant: 'other-tenant', token: 'other-operator-token-0001' },
            { tenant: SCOPE.tenant, token: 'matching-operator-token-0002' },
          ],
        }),
        log,
      );

      const requestedUrl = fetchSpy.mock.calls[0]?.[0] as URL;
      expect(requestedUrl.searchParams.get('tenant')).toBe(SCOPE.tenant);
      expect(requestedUrl.searchParams.get('environment')).toBe(SCOPE.environment);
      expect(requestedUrl.searchParams.get('agentId')).toBe(SCOPE.agentId);
      expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
        headers: {
          authorization: 'Bearer matching-operator-token-0002',
          'x-correlation-id': `corr-preflight-${state}`,
        },
      });
      const postedCard = postIncidentCard.mock.calls[0]?.[0] as
        { blocks?: unknown[] } | undefined;
      expect(JSON.stringify(postedCard?.blocks)).toContain(`*Preflight*\\n${state}`);
      const content = await readFile(
        path.join(snapshotDir, `corr-preflight-${state}.html`),
        'utf8',
      );
      expect(content).toContain(`Preflight:</span> ${state}`);
    },
  );

  it.each([
    { status: 404, label: 'no committed result' },
    { status: 503, label: 'Preflight store failure' },
  ])('renders Preflight unknown and still delivers on $label', async ({ status }) => {
    mockPreflightFetch(new Response(null, { status }));
    postIncidentCard.mockResolvedValue({ posted: true, ts: '1234.5678' });

    await expect(
      runDiagnosisAndNotify(
        {
          scope: SCOPE,
          detector: 'loop-signature',
          reason: 'r',
          correlationId: `corr-preflight-${status}`,
          startsAt: new Date().toISOString(),
        },
        baseConfig({
          localSnapshotDir: snapshotDir,
          preflightStatusUrl: 'http://127.0.0.1:8090/v1/preflight/status',
          operatorTokens: [
            { tenant: SCOPE.tenant, token: 'matching-operator-token-0002' },
          ],
        }),
        log,
      ),
    ).resolves.toEqual({ delivered: true, channel: 'slack' });

    const postedCard = postIncidentCard.mock.calls[0]?.[0] as
      { blocks?: unknown[] } | undefined;
    expect(JSON.stringify(postedCard?.blocks)).toContain('*Preflight*\\nunknown');
    expect(logs).toContainEqual({
      msg: 'Preflight state unavailable for incident card',
      meta: {
        reason: 'status endpoint rejected the read',
        statusCode: status,
        tenant: SCOPE.tenant,
      },
    });
  });

  it('rejects a committed Preflight result from any other scope', async () => {
    mockPreflightFetch(
      preflightStatusResponse('protected', { ...SCOPE, agentId: 'other-agent' }),
    );
    postIncidentCard.mockResolvedValue({ posted: true, ts: '1234.5678' });

    await runDiagnosisAndNotify(
      {
        scope: SCOPE,
        detector: 'loop-signature',
        reason: 'r',
        correlationId: 'corr-preflight-mismatch',
        startsAt: new Date().toISOString(),
      },
      baseConfig({
        localSnapshotDir: snapshotDir,
        preflightStatusUrl: 'http://127.0.0.1:8090/v1/preflight/status',
        operatorTokens: [{ tenant: SCOPE.tenant, token: 'matching-operator-token-0002' }],
      }),
      log,
    );

    const postedCard = postIncidentCard.mock.calls[0]?.[0] as
      { blocks?: unknown[] } | undefined;
    expect(JSON.stringify(postedCard?.blocks)).toContain('*Preflight*\\nunknown');
    expect(logs).toContainEqual({
      msg: 'Preflight state unavailable for incident card',
      meta: {
        reason: 'status endpoint returned an invalid or mismatched result',
        tenant: SCOPE.tenant,
      },
    });
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
    ).resolves.toEqual({
      delivered: false,
      reason: 'no Slack bot token configured',
    });
    expect(logs.some((l) => l.msg.includes('not delivered'))).toBe(true);
  });

  it('logs Slack message identity after successful delivery', async () => {
    postIncidentCard.mockResolvedValue({ posted: true, ts: '1234.5678' });
    const result = await runDiagnosisAndNotify(
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
    expect(result).toEqual({ delivered: true, channel: 'slack' });
    expect(postIncidentCard.mock.calls[0]?.[1]).toMatchObject({
      messageIdentity: 'corr-delivered',
    });
  });

  it('binds Slack provider deduplication to the durable audit and correlation identity', async () => {
    postIncidentCard.mockResolvedValue({ posted: true, ts: '1234.5678' });
    await runDiagnosisAndNotify(
      {
        auditEventId: '00000000-0000-4000-8000-000000000001',
        scope: SCOPE,
        detector: 'loop-signature',
        reason: 'r',
        correlationId: 'corr-deterministic',
        startsAt: new Date().toISOString(),
      },
      baseConfig({ localSnapshotDir: snapshotDir }),
      log,
    );
    expect(postIncidentCard.mock.calls[0]?.[1]).toMatchObject({
      messageIdentity: '00000000-0000-4000-8000-000000000001:corr-deterministic',
    });
  });

  it('does not create a Slack delivery when the committed policy excluded Slack', async () => {
    const result = await runDiagnosisAndNotify(
      {
        scope: SCOPE,
        detector: 'loop-signature',
        reason: 'r',
        correlationId: 'corr-snapshot-only',
        startsAt: new Date().toISOString(),
        notifySlack: false,
      },
      baseConfig({
        localSnapshotDir: snapshotDir,
        slackBotToken: 'xoxb-configured-but-policy-disabled',
      }),
      log,
    );
    expect(result).toEqual({ delivered: true, channel: 'snapshot' });
    expect(postIncidentCard).not.toHaveBeenCalled();
  });

  it('includes Resume only when Slack signing and a tenant-matching operator token make it usable', async () => {
    await runDiagnosisAndNotify(
      {
        scope: SCOPE,
        detector: 'loop-signature',
        reason: 'r',
        correlationId: 'corr-resume-action',
        startsAt: new Date().toISOString(),
        tripEpoch: 7,
      },
      baseConfig({
        localSnapshotDir: snapshotDir,
        slackBotToken: 'xoxb-test',
        slackSigningSecret: 'signing-secret',
        slackAuthorizedUserIds: ['U123'],
        slackTeamId: 'T123',
        operatorTokens: [{ tenant: SCOPE.tenant, token: 'tenant-operator-token-0001' }],
      }),
      log,
    );

    const postedCard = postIncidentCard.mock.calls[0]?.[0] as
      { blocks?: unknown[] } | undefined;
    const blocks = JSON.stringify(postedCard?.blocks);
    expect(blocks).toContain('"action_id":"fuse_resume"');
    expect(blocks).toContain('\\"expectedEpoch\\":7');
    expect(blocks).toContain('\\"correlationId\\":\\"corr-resume-action\\"');
  });

  it('omits Resume and logs why when no operator token matches the incident tenant', async () => {
    await runDiagnosisAndNotify(
      {
        scope: SCOPE,
        detector: 'loop-signature',
        reason: 'r',
        correlationId: 'corr-no-resume-action',
        startsAt: new Date().toISOString(),
        tripEpoch: 7,
      },
      baseConfig({
        localSnapshotDir: snapshotDir,
        slackBotToken: 'xoxb-test',
        slackSigningSecret: 'signing-secret',
        slackAuthorizedUserIds: ['U123'],
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
        hasAuthorizedSlackUsers: true,
        hasTripEpoch: true,
        hasConfiguredTeam: false,
        tenant: SCOPE.tenant,
      },
    });
  });

  it('omits Resume unless explicit Slack users and the exact trip epoch are configured', async () => {
    const configured = baseConfig({
      localSnapshotDir: snapshotDir,
      slackBotToken: 'xoxb-test',
      slackSigningSecret: 'signing-secret',
      operatorTokens: [{ tenant: SCOPE.tenant, token: 'tenant-operator-token-0001' }],
    });

    await runDiagnosisAndNotify(
      {
        scope: SCOPE,
        detector: 'loop-signature',
        reason: 'r',
        correlationId: 'corr-missing-authorization',
        startsAt: new Date().toISOString(),
        tripEpoch: 7,
      },
      configured,
      log,
    );

    const postedCard = postIncidentCard.mock.calls[0]?.[0] as
      { blocks?: unknown[] } | undefined;
    expect(JSON.stringify(postedCard?.blocks)).not.toContain('fuse_resume');
    expect(logs).toContainEqual({
      msg: 'Slack Resume action omitted: interactive authorization unavailable',
      meta: {
        hasSigningSecret: true,
        hasTenantOperatorToken: true,
        hasAuthorizedSlackUsers: false,
        hasTripEpoch: true,
        hasConfiguredTeam: false,
        tenant: SCOPE.tenant,
      },
    });
  });

  it('omits Resume when the triggering worker does not supply a committed trip epoch', async () => {
    await runDiagnosisAndNotify(
      {
        scope: SCOPE,
        detector: 'loop-signature',
        reason: 'r',
        correlationId: 'corr-missing-epoch',
        startsAt: new Date().toISOString(),
      },
      baseConfig({
        localSnapshotDir: snapshotDir,
        slackBotToken: 'xoxb-test',
        slackSigningSecret: 'signing-secret',
        slackAuthorizedUserIds: ['U123'],
        operatorTokens: [{ tenant: SCOPE.tenant, token: 'tenant-operator-token-0001' }],
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
        hasTenantOperatorToken: true,
        hasAuthorizedSlackUsers: true,
        hasTripEpoch: false,
        hasConfiguredTeam: false,
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
    ).resolves.toEqual({ delivered: false, reason: 'no bot token' });
    // the pipeline still completes (falls back to an unavailable bundle,
    // still writes a snapshot and attempts a Slack post)
    expect(postIncidentCard).toHaveBeenCalledOnce();
  });
});
