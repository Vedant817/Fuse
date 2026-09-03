import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosisJob, DiagnosisJobStore } from '@fuse/breaker-store';
import {
  DiagnosisDispatcher,
  loadDiagnosisDispatcherConfig,
  type DiagnosisDispatcherConfig,
} from './diagnosis-dispatcher.js';
import type { DiagnosisTrigger, DiagnosisWorkerConfig } from './diagnosis-worker.js';

const metricMocks = vi.hoisted(() => ({
  queueRecord: vi.fn(),
  attemptAdd: vi.fn(),
  latencyRecord: vi.fn(),
  leaseFailureAdd: vi.fn(),
}));

vi.mock('@fuse/otel', () => ({
  FUSE_OPERATIONAL_SLO_VERSION: 'v1-provisional',
  getDiagnosisQueueDepthGauge: () => ({ record: metricMocks.queueRecord }),
  getDiagnosisDeliveryAttemptCounter: () => ({ add: metricMocks.attemptAdd }),
  getDiagnosisDeliveryLatencyHistogram: () => ({ record: metricMocks.latencyRecord }),
  getDiagnosisLeaseRenewalFailureCounter: () => ({ add: metricMocks.leaseFailureAdd }),
}));

const CONFIG: DiagnosisDispatcherConfig = {
  pollIntervalMs: 10,
  concurrency: 4,
  leaseMs: 10_000,
  maxAttempts: 3,
  backoffBaseMs: 100,
  backoffMaxMs: 1_000,
  backoffJitterRatio: 0.2,
};

const DIAGNOSIS_CONFIG = {
  mcpServerUrl: undefined,
  slackBotToken: undefined,
  slackChannel: 'C_TEST',
  localSnapshotDir: '/tmp/unused',
  slackSigningSecret: undefined,
  slackAuthorizedUserIds: [],
  slackTeamId: undefined,
  operatorToken: undefined,
} as DiagnosisWorkerConfig;

function job(index: number, attempts = 1): DiagnosisJob {
  return {
    auditEventId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    scope: { tenant: 't1', environment: 'test', agentId: `agent-${index}` },
    detector: 'loop-signature',
    measurement: null,
    reason: 'bounded structural loop',
    correlationId: `corr-${index}`,
    startsAt: '2026-08-24T10:00:00.000Z',
    tripEpoch: 1,
    notifySlack: true,
    status: 'running',
    attempts,
    availableAt: '2026-08-24T10:00:00.000Z',
    leasedBy: 'worker-test',
    leasedUntil: '2026-08-24T10:01:00.000Z',
    lastError: null,
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-24T10:00:00.000Z',
    completedAt: null,
  };
}

function logger() {
  return { info: vi.fn(), error: vi.fn() };
}

describe('DiagnosisDispatcher', () => {
  beforeEach(() => {
    metricMocks.queueRecord.mockReset();
    metricMocks.attemptAdd.mockReset();
    metricMocks.latencyRecord.mockReset();
    metricMocks.leaseFailureAdd.mockReset();
  });

  it('reconstructs bounded direct-detector measurements for diagnosis', async () => {
    const measuredJob = {
      ...job(42),
      measurement: {
        detectorVersion: 'loop-signature-v2',
        score: 8,
        threshold: 4,
        windowEnd: '2026-08-24T10:00:30.000Z',
      },
    };
    const deliver = vi.fn(async (_trigger: DiagnosisTrigger) => ({
      delivered: true as const,
      channel: 'slack' as const,
    }));
    const dispatcher = new DiagnosisDispatcher(
      {
        store: {
          claim: vi.fn().mockResolvedValueOnce([measuredJob]),
          complete: vi.fn(async () => true),
          fail: vi.fn(),
        } as unknown as DiagnosisJobStore,
        diagnosisConfig: DIAGNOSIS_CONFIG,
        log: logger(),
        workerId: 'worker-test',
        deliver,
      },
      CONFIG,
    );

    await dispatcher.runOnce();

    expect(deliver.mock.calls[0]?.[0]).toMatchObject({
      detectorResult: {
        detectorVersion: 'loop-signature-v2',
        score: 8,
        threshold: 4,
        evidence: [],
      },
    });
  });

  it('keeps a 200-alert backlog at the configured bounded fanout', async () => {
    const backlog = Array.from({ length: 200 }, (_, index) => job(index));
    const claim = vi.fn(async (_worker: string, limit: number) =>
      backlog.splice(0, limit),
    );
    const complete = vi.fn(async () => true);
    const fail = vi.fn();
    let active = 0;
    let maximumActive = 0;
    const deliver = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { delivered: true as const, channel: 'slack' as const };
    });
    const dispatcher = new DiagnosisDispatcher(
      {
        store: { claim, complete, fail } as unknown as DiagnosisJobStore,
        diagnosisConfig: DIAGNOSIS_CONFIG,
        log: logger(),
        workerId: 'worker-test',
        deliver,
      },
      CONFIG,
    );

    let claimed = 0;
    while (claimed < 200) claimed += await dispatcher.runOnce();

    expect(maximumActive).toBe(4);
    expect(deliver).toHaveBeenCalledTimes(200);
    expect(complete).toHaveBeenCalledTimes(200);
    expect(fail).not.toHaveBeenCalled();
    expect(claim.mock.calls.every((call) => call[1] === 4)).toBe(true);
  });

  it('applies exponential backoff with jitter and delegates the dead-letter decision', async () => {
    const claimed = [job(1, 1), job(2, 2), job(3, 3)];
    const claim = vi.fn(async () => {
      const next = claimed.shift();
      return next ? [next] : [];
    });
    const fail = vi
      .fn()
      .mockResolvedValueOnce('retry')
      .mockResolvedValueOnce('retry')
      .mockResolvedValueOnce('dead-letter');
    const dispatcher = new DiagnosisDispatcher(
      {
        store: {
          claim,
          complete: vi.fn(),
          fail,
        } as unknown as DiagnosisJobStore,
        diagnosisConfig: DIAGNOSIS_CONFIG,
        log: logger(),
        workerId: 'worker-test',
        random: () => 0.5,
        deliver: async () => ({ delivered: false, reason: 'Slack unavailable' }),
      },
      CONFIG,
    );

    await dispatcher.runOnce();
    await dispatcher.runOnce();
    await dispatcher.runOnce();

    expect(fail.mock.calls.map((call) => call[3])).toEqual([100, 200, 400]);
    expect(fail.mock.calls.every((call) => call[4] === 3)).toBe(true);
  });

  it('stops claiming and drains an in-flight delivery before resolving stop', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delivered = false;
    const claim = vi
      .fn()
      .mockResolvedValueOnce([job(1)])
      .mockResolvedValue([]);
    const complete = vi.fn(async () => true);
    const dispatcher = new DiagnosisDispatcher(
      {
        store: {
          claim,
          complete,
          fail: vi.fn(),
        } as unknown as DiagnosisJobStore,
        diagnosisConfig: DIAGNOSIS_CONFIG,
        log: logger(),
        workerId: 'worker-test',
        deliver: async () => {
          await blocked;
          delivered = true;
          return { delivered: true, channel: 'slack' };
        },
      },
      CONFIG,
    );
    dispatcher.start();
    await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());

    let stopped = false;
    const stopping = dispatcher.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stopped).toBe(false);
    release();
    await stopping;

    expect(delivered).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledOnce();
  });

  it('renews a long-running delivery lease and stops renewing after completion', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const renewLease = vi.fn(async () => true);
    const complete = vi.fn(async () => true);
    const dispatcher = new DiagnosisDispatcher(
      {
        store: {
          claim: vi.fn().mockResolvedValueOnce([job(1)]),
          renewLease,
          complete,
          fail: vi.fn(),
          countQueue: vi.fn(async () => ({
            pending: 0,
            running: 1,
            'dead-letter': 0,
          })),
        } as unknown as DiagnosisJobStore,
        diagnosisConfig: DIAGNOSIS_CONFIG,
        log: logger(),
        workerId: 'worker-test',
        deliver: async () => {
          await blocked;
          return { delivered: true, channel: 'slack' };
        },
      },
      { ...CONFIG, leaseMs: 30 },
    );

    const running = dispatcher.runOnce();
    await vi.waitFor(() => expect(renewLease).toHaveBeenCalled());
    release();
    await running;
    const renewalsAtCompletion = renewLease.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(complete).toHaveBeenCalledOnce();
    expect(renewLease).toHaveBeenCalledWith(job(1).auditEventId, 'worker-test', 30);
    expect(renewLease).toHaveBeenCalledTimes(renewalsAtCompletion);
  });

  it('does not complete or retry after lease renewal reports ownership lost', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const complete = vi.fn();
    const fail = vi.fn();
    const log = logger();
    const renewLease = vi.fn(async () => false);
    const dispatcher = new DiagnosisDispatcher(
      {
        store: {
          claim: vi.fn().mockResolvedValueOnce([job(1)]),
          renewLease,
          complete,
          fail,
          countQueue: vi.fn(async () => ({
            pending: 0,
            running: 1,
            'dead-letter': 0,
          })),
        } as unknown as DiagnosisJobStore,
        diagnosisConfig: DIAGNOSIS_CONFIG,
        log,
        workerId: 'worker-test',
        deliver: async () => {
          await blocked;
          return { delivered: true, channel: 'slack' };
        },
      },
      { ...CONFIG, leaseMs: 30 },
    );

    const running = dispatcher.runOnce();
    await vi.waitFor(() => expect(renewLease).toHaveBeenCalledOnce());
    release();
    await running;

    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      { auditEventId: job(1).auditEventId },
      'diagnosis delivery lost its lease during delivery',
    );
    expect(metricMocks.attemptAdd).toHaveBeenCalledWith(1, {
      'fuse.slo.version': 'v1-provisional',
      'fuse.diagnosis.outcome': 'lease-lost',
    });
    expect(metricMocks.leaseFailureAdd).toHaveBeenCalledWith(1, {
      'fuse.slo.version': 'v1-provisional',
      'fuse.reason': 'rejected',
    });
  });

  it('records queue depth and successful attempt metrics with bounded labels', async () => {
    const dispatcher = new DiagnosisDispatcher(
      {
        store: {
          claim: vi.fn().mockResolvedValueOnce([job(1)]),
          renewLease: vi.fn(async () => true),
          complete: vi.fn(async () => true),
          fail: vi.fn(),
          countQueue: vi.fn(async () => ({
            pending: 4,
            running: 1,
            'dead-letter': 2,
          })),
        } as unknown as DiagnosisJobStore,
        diagnosisConfig: DIAGNOSIS_CONFIG,
        log: logger(),
        workerId: 'worker-test',
        deliver: async () => ({ delivered: true, channel: 'slack' }),
      },
      CONFIG,
    );

    await dispatcher.runOnce();

    expect(metricMocks.queueRecord).toHaveBeenCalledWith(4, {
      'fuse.slo.version': 'v1-provisional',
      'fuse.diagnosis.status': 'pending',
    });
    expect(metricMocks.queueRecord).toHaveBeenCalledWith(1, {
      'fuse.slo.version': 'v1-provisional',
      'fuse.diagnosis.status': 'running',
    });
    expect(metricMocks.queueRecord).toHaveBeenCalledWith(2, {
      'fuse.slo.version': 'v1-provisional',
      'fuse.diagnosis.status': 'dead-letter',
    });
    expect(metricMocks.attemptAdd).toHaveBeenCalledWith(1, {
      'fuse.slo.version': 'v1-provisional',
      'fuse.diagnosis.outcome': 'succeeded',
    });
    expect(metricMocks.latencyRecord).toHaveBeenCalledWith(expect.any(Number), {
      'fuse.slo.version': 'v1-provisional',
      'fuse.diagnosis.outcome': 'succeeded',
    });
  });
});

describe('loadDiagnosisDispatcherConfig', () => {
  it('loads bounded operator overrides and rejects invalid limits', () => {
    expect(
      loadDiagnosisDispatcherConfig({
        FUSE_DIAGNOSIS_CONCURRENCY: '8',
        FUSE_DIAGNOSIS_MAX_ATTEMPTS: '7',
        FUSE_DIAGNOSIS_BACKOFF_JITTER_RATIO: '0.5',
      }),
    ).toMatchObject({ concurrency: 8, maxAttempts: 7, backoffJitterRatio: 0.5 });
    expect(() =>
      loadDiagnosisDispatcherConfig({ FUSE_DIAGNOSIS_CONCURRENCY: '0' }),
    ).toThrow(/CONCURRENCY/);
  });
});
