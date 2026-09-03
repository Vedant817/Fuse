import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { DiagnosisJobStore } from '@fuse/breaker-store';
import {
  decodeDiagnosisCursor,
  encodeDiagnosisCursor,
  registerDiagnosisRoutes,
} from './diagnosis.js';

const AUDIT_ID = '00000000-0000-4000-8000-000000000001';
const SCOPE = { tenant: 'tenant-a', environment: 'prod', agentId: 'agent-1' };
const JOB = {
  auditEventId: AUDIT_ID,
  scope: SCOPE,
  status: 'dead-letter' as const,
};

describe('diagnosis operations routes', () => {
  it('passes bounded filters and an opaque cursor to the store', async () => {
    const list = vi.fn().mockResolvedValue({
      jobs: [JOB],
      nextCursor: { createdAt: '2026-08-24T10:00:00.000Z', auditEventId: AUDIT_ID },
    });
    const app = Fastify();
    registerDiagnosisRoutes(app, { list } as unknown as DiagnosisJobStore);
    const cursor = encodeDiagnosisCursor({
      createdAt: '2026-08-24T10:01:00.000Z',
      auditEventId: '00000000-0000-4000-8000-000000000002',
    });

    const response = await app.inject({
      method: 'GET',
      url:
        `/v1/diagnosis/jobs?tenant=tenant-a&environment=prod&agentId=agent-1` +
        `&status=dead-letter&limit=25&cursor=${cursor}`,
    });

    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith({
      tenant: 'tenant-a',
      environment: 'prod',
      agentId: 'agent-1',
      status: 'dead-letter',
      limit: 25,
      cursor: {
        createdAt: '2026-08-24T10:01:00.000Z',
        auditEventId: '00000000-0000-4000-8000-000000000002',
      },
    });
    expect(decodeDiagnosisCursor(response.json().nextCursor)).toEqual({
      createdAt: '2026-08-24T10:00:00.000Z',
      auditEventId: AUDIT_ID,
    });
    await app.close();
  });

  it('rejects malformed and oversized pagination input before querying', async () => {
    const list = vi.fn();
    const app = Fastify();
    registerDiagnosisRoutes(app, { list } as unknown as DiagnosisJobStore);
    for (const url of [
      '/v1/diagnosis/jobs?tenant=tenant-a&limit=101',
      '/v1/diagnosis/jobs?tenant=tenant-a&status=unknown',
      '/v1/diagnosis/jobs?tenant=tenant-a&cursor=not-json',
      `/v1/diagnosis/jobs?tenant=tenant-a&cursor=${'x'.repeat(513)}`,
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(400);
    }
    expect(list).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires bounded manual attribution and returns idempotent replay state', async () => {
    const replay = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'requeued', job: { ...JOB, status: 'pending' } })
      .mockResolvedValueOnce({ kind: 'replayed', job: { ...JOB, status: 'pending' } });
    const app = Fastify();
    registerDiagnosisRoutes(app, { replay } as unknown as DiagnosisJobStore);
    const payload = {
      scope: SCOPE,
      actor: { type: 'manual', id: 'operator:alice' },
      reason: 'Slack configuration repaired',
      idempotencyKey: 'replay-1',
    };

    const first = await app.inject({
      method: 'POST',
      url: `/v1/diagnosis/jobs/${AUDIT_ID}/replay`,
      payload,
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: `/v1/diagnosis/jobs/${AUDIT_ID}/replay`,
      payload,
    });
    expect(first.json()).toMatchObject({ replayed: false, job: { status: 'pending' } });
    expect(duplicate.json()).toMatchObject({
      replayed: true,
      job: { status: 'pending' },
    });
    expect(replay).toHaveBeenCalledWith({ auditEventId: AUDIT_ID, ...payload });

    const invalid = await app.inject({
      method: 'POST',
      url: `/v1/diagnosis/jobs/${AUDIT_ID}/replay`,
      payload: { ...payload, actor: { type: 'system', id: 'spoofed' }, reason: '' },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it('rejects replay of live/succeeded work as an explicit conflict', async () => {
    const replay = vi.fn().mockResolvedValue({ kind: 'not-dead-letter' });
    const app = Fastify();
    registerDiagnosisRoutes(app, { replay } as unknown as DiagnosisJobStore);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/diagnosis/jobs/${AUDIT_ID}/replay`,
      payload: {
        scope: SCOPE,
        actor: { type: 'manual', id: 'operator:alice' },
        reason: 'retry',
        idempotencyKey: 'replay-live',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('invalid_transition');
    await app.close();
  });
});
