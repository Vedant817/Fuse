import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { getContainerRuntimeClient } from 'testcontainers';
import pg from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { BreakerStore, DiagnosisJobStore, runMigrations } from '@fuse/breaker-store';
import type { Scope } from '@fuse/contracts';
import {
  DiagnosisDispatcher,
  type DiagnosisDispatcherConfig,
} from './diagnosis-dispatcher.js';
import type { DiagnosisWorkerConfig } from './diagnosis-worker.js';

const DISPATCHER_CONFIG: DiagnosisDispatcherConfig = {
  pollIntervalMs: 20,
  concurrency: 1,
  leaseMs: 500,
  maxAttempts: 3,
  backoffBaseMs: 10,
  backoffMaxMs: 10,
  backoffJitterRatio: 0,
};

const DIAGNOSIS_CONFIG: DiagnosisWorkerConfig = {
  mcpServerUrl: undefined,
  slackBotToken: 'xoxb-integration-placeholder',
  slackChannel: 'C_INTEGRATION',
  localSnapshotDir: tmpdir(),
  slackSigningSecret: undefined,
  slackAuthorizedUserIds: [],
  slackTeamId: undefined,
  operatorToken: undefined,
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function logger() {
  return { info: vi.fn(), error: vi.fn() };
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

async function startBlockingSlackServer(): Promise<{
  url: string;
  requestBody: Promise<string>;
  close: () => Promise<void>;
}> {
  let resolveBody!: (body: string) => void;
  const requestBody = new Promise<string>((resolve) => {
    resolveBody = resolve;
  });
  const server: Server = createServer((request) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    // Deliberately never respond. The worker is killed while Slack is in flight.
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server port');
  return {
    url: `http://127.0.0.1:${address.port}/slack`,
    requestBody,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('DiagnosisDispatcher crash, lease, and replay delivery (Postgres integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let breakerStore: BreakerStore;
  let jobs: DiagnosisJobStore;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('fuse')
      .withUsername('fuse')
      .withPassword('fuse')
      .start();
    pool = new pg.Pool({
      connectionString: container.getConnectionUri(),
      connectionTimeoutMillis: 250,
    });
    pool.on('error', () => {});
    await runMigrations(pool);
    breakerStore = new BreakerStore(pool);
    jobs = new DiagnosisJobStore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM diagnosis_job_replay_audit');
    await pool.query('DELETE FROM diagnosis_jobs');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function reconnectPrimaryPool(): Promise<void> {
    await pool.end().catch(() => {});
    pool = new pg.Pool({
      connectionString: container.getConnectionUri(),
      connectionTimeoutMillis: 250,
    });
    pool.on('error', () => {});
    breakerStore = new BreakerStore(pool);
    jobs = new DiagnosisJobStore(pool);
    await vi.waitFor(
      async () => expect((await pool.query('SELECT 1')).rowCount).toBe(1),
      {
        timeout: 10_000,
        interval: 100,
      },
    );
  }

  async function createJob(
    name: string,
  ): Promise<{ auditEventId: string; scope: Scope }> {
    const scope = {
      tenant: 'dispatcher-integration',
      environment: 'test',
      agentId: `${name}-${randomUUID().slice(0, 8)}`,
    };
    await breakerStore.registerScope({
      scope,
      policyVersion: 'diagnosis-integration-v1',
      actor: { type: 'manual', id: 'test:setup' },
      reason: 'dispatcher integration setup',
      correlationId: `register-${scope.agentId}`,
    });
    const result = await breakerStore.trip(
      {
        scope,
        reason: 'structural loop detector fired',
        policyVersion: 'diagnosis-integration-v1',
        cooldownSeconds: 60,
        actor: { type: 'system', id: 'system:detector:loop-signature' },
        correlationId: `incident-${scope.agentId}`,
        idempotencyKey: `incident-${scope.agentId}`,
      },
      {
        detector: 'loop-signature',
        startsAt: new Date().toISOString(),
        notifySlack: true,
      },
    );
    if (result.kind !== 'applied') throw new Error('trip unexpectedly rejected');
    return { auditEventId: result.auditEvent.id, scope };
  }

  it('hard-kills a Slack-blocked worker, reclaims its lease, fences it, and succeeds idempotently', async () => {
    const created = await createJob('hard-crash');
    const blocker = await startBlockingSlackServer();
    const crashedWorkerId = `crashed-${randomUUID()}`;
    const jobStoreModule = new URL(
      '../../../packages/breaker-store/src/diagnosis-job-store.ts',
      import.meta.url,
    ).href;
    const slackClientModule = new URL(
      '../../../packages/diagnosis/src/slack-client.ts',
      import.meta.url,
    ).href;
    const childScript = `
      import pg from 'pg';
      import { DiagnosisJobStore } from ${JSON.stringify(jobStoreModule)};
      import { postIncidentCard } from ${JSON.stringify(slackClientModule)};
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (String(input) === 'https://slack.com/api/chat.postMessage') {
          return nativeFetch(process.env.BLOCKING_SLACK_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: init?.body,
            signal: init?.signal,
          });
        }
        return nativeFetch(input, init);
      };
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      pool.on('error', () => {});
      const store = new DiagnosisJobStore(pool);
      const [job] = await store.claim(process.env.WORKER_ID, 1, ${DISPATCHER_CONFIG.leaseMs}, ${DISPATCHER_CONFIG.maxAttempts});
      if (!job) throw new Error('crash worker did not claim a diagnosis job');
      await postIncidentCard(
        { text: 'blocked crash integration card', blocks: [] },
        {
          botToken: 'xoxb-child-placeholder',
          channel: 'C_INTEGRATION',
          messageIdentity: job.auditEventId + ':' + job.correlationId,
        },
      );
    `;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', childScript],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: container.getConnectionUri(),
          BLOCKING_SLACK_URL: blocker.url,
          WORKER_ID: crashedWorkerId,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let childError = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      childError += chunk.toString('utf8');
    });

    let replacement: DiagnosisDispatcher | undefined;
    let releaseReplacement = () => {};
    try {
      const firstSlackBody = JSON.parse(
        await Promise.race([
          blocker.requestBody,
          waitForChildExit(child).then(() => {
            throw new Error(`crash worker exited before Slack blocked: ${childError}`);
          }),
        ]),
      ) as { client_msg_id: string };
      expect(await jobs.get(created.auditEventId)).toMatchObject({
        status: 'running',
        attempts: 1,
        leasedBy: crashedWorkerId,
      });

      child.kill('SIGKILL');
      await waitForChildExit(child);
      await delay(DISPATCHER_CONFIG.leaseMs + 100);

      const replacementGate = new Promise<void>((resolve) => {
        releaseReplacement = resolve;
      });
      let resolveReplacementBody!: (body: { client_msg_id: string }) => void;
      const replacementBody = new Promise<{ client_msg_id: string }>((resolve) => {
        resolveReplacementBody = resolve;
      });
      globalThis.fetch = vi.fn(async (input, init) => {
        expect(String(input)).toBe('https://slack.com/api/chat.postMessage');
        const body = JSON.parse(String(init?.body)) as { client_msg_id: string };
        resolveReplacementBody(body);
        await replacementGate;
        return new Response(JSON.stringify({ ok: true, ts: '170.001' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      replacement = new DiagnosisDispatcher(
        {
          store: jobs,
          diagnosisConfig: DIAGNOSIS_CONFIG,
          log: logger(),
          workerId: 'replacement-worker',
        },
        DISPATCHER_CONFIG,
      );
      replacement.start();
      const secondSlackBody = await replacementBody;

      expect(await jobs.get(created.auditEventId)).toMatchObject({
        status: 'running',
        attempts: 2,
        leasedBy: 'replacement-worker',
      });
      await expect(jobs.complete(created.auditEventId, crashedWorkerId)).resolves.toBe(
        false,
      );
      expect(secondSlackBody.client_msg_id).toBe(firstSlackBody.client_msg_id);
      expect(secondSlackBody.client_msg_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      releaseReplacement();
      await vi.waitFor(
        async () =>
          expect((await jobs.get(created.auditEventId))?.status).toBe('succeeded'),
        { timeout: 5_000 },
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await waitForChildExit(child);
      releaseReplacement();
      await replacement?.stop();
      await blocker.close();
    }
  }, 30_000);

  it('recovers after PostgreSQL is unavailable during renewal and dead-letters the reclaimed final attempt', async () => {
    const created = await createJob('postgres-outage');
    const workerPool = new pg.Pool({
      connectionString: container.getConnectionUri(),
      connectionTimeoutMillis: 150,
    });
    workerPool.on('error', () => {});
    const workerStore = new DiagnosisJobStore(workerPool);
    const outageLog = logger();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstDispatcher = new DiagnosisDispatcher(
      {
        store: workerStore,
        diagnosisConfig: DIAGNOSIS_CONFIG,
        log: outageLog,
        workerId: 'outage-worker',
        deliver: async () => {
          markFirstStarted();
          await firstGate;
          return { delivered: true, channel: 'slack' };
        },
      },
      { ...DISPATCHER_CONFIG, leaseMs: 600, maxAttempts: 2 },
    );
    const firstRun = firstDispatcher.runOnce();
    await firstStarted;

    const runtime = await getContainerRuntimeClient();
    const rawContainer = runtime.container.getById(container.getId());
    let databaseStopped = false;
    let replacement: DiagnosisDispatcher | undefined;
    let releaseReplacement = () => {};
    try {
      await runtime.container.stop(rawContainer, { timeout: 0 });
      databaseStopped = true;
      await vi.waitFor(
        () =>
          expect(outageLog.error).toHaveBeenCalledWith(
            expect.objectContaining({ auditEventId: created.auditEventId }),
            'diagnosis lease renewal failed',
          ),
        { timeout: 5_000 },
      );

      await container.restart();
      await reconnectPrimaryPool();
      databaseStopped = false;
      releaseFirst();
      await firstRun;

      await delay(700);
      const replacementGate = new Promise<void>((resolve) => {
        releaseReplacement = resolve;
      });
      let markReplacementStarted!: () => void;
      const replacementStarted = new Promise<void>((resolve) => {
        markReplacementStarted = resolve;
      });
      replacement = new DiagnosisDispatcher(
        {
          store: jobs,
          diagnosisConfig: DIAGNOSIS_CONFIG,
          log: logger(),
          workerId: 'outage-replacement',
          deliver: async () => {
            markReplacementStarted();
            await replacementGate;
            return { delivered: false, reason: 'Slack remains unavailable' };
          },
        },
        { ...DISPATCHER_CONFIG, leaseMs: 5_000, maxAttempts: 2 },
      );
      replacement.start();
      await replacementStarted;

      expect(await jobs.get(created.auditEventId)).toMatchObject({
        status: 'running',
        attempts: 2,
        leasedBy: 'outage-replacement',
      });
      await expect(jobs.complete(created.auditEventId, 'outage-worker')).resolves.toBe(
        false,
      );
      releaseReplacement();
      await vi.waitFor(
        async () =>
          expect(await jobs.get(created.auditEventId)).toMatchObject({
            status: 'dead-letter',
            attempts: 2,
            lastError: 'Slack remains unavailable',
          }),
        { timeout: 5_000 },
      );
    } finally {
      releaseFirst();
      if (databaseStopped) {
        await container.restart();
        await reconnectPrimaryPool();
      }
      await firstRun.catch(() => {});
      releaseReplacement();
      await replacement?.stop();
      await workerPool.end();
    }
  }, 30_000);
});
