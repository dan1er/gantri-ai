import { describe, it, expect, vi } from 'vitest';
import { DevopsJobsRepo } from '../../../src/devops/jobs-repo.js';

const ROW = {
  id: 'j1', kind: 'preview', target: 'backend', status: 'pending',
  spec: { backend: { ref: 'feat/as-1', slug: 'as-1' } },
  requested_by: 'U1', channel_id: 'C1', message_ts: null,
  run_id: null, error: null, created_at: 't', updated_at: 't',
};

describe('DevopsJobsRepo', () => {
  it('create inserts and maps the row to a Job', async () => {
    const insert = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: ROW, error: null }) }),
    });
    const client = { from: () => ({ insert }) } as any;
    const repo = new DevopsJobsRepo(client);
    const job = await repo.create({
      kind: 'preview', target: 'backend',
      spec: { backend: { ref: 'feat/as-1', slug: 'as-1' } },
      requestedBy: 'U1', channelId: 'C1',
    });
    expect(job.id).toBe('j1');
    expect(job.spec.backend?.slug).toBe('as-1');
    expect(insert).toHaveBeenCalledOnce();
  });

  it('listActive returns only non-terminal jobs', async () => {
    const not = vi.fn().mockResolvedValue({ data: [ROW], error: null });
    const client = { from: () => ({ select: () => ({ not: () => ({ order: () => ({ limit: () => not() }) }) }) }) } as any;
    const repo = new DevopsJobsRepo(client);
    const jobs = await repo.listActive(10);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
  });

  it('update throws on a Supabase error', async () => {
    const eq = vi.fn().mockResolvedValue({ data: null, error: { message: 'denied' } });
    const client = { from: () => ({ update: () => ({ eq }) }) } as any;
    const repo = new DevopsJobsRepo(client);
    await expect(repo.update('j1', { status: 'ready' })).rejects.toThrow(/denied/);
  });
});
