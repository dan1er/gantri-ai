import { describe, it, expect, vi } from 'vitest';
import { JobsRunner } from '../../../src/devops/jobs-runner.js';
import type { Job } from '../../../src/devops/types.js';

const job: Job = {
  id: 'j1', kind: 'preview', target: 'backend', status: 'pending',
  spec: { backend: { ref: 'feat/as-1', slug: 'as-1' } },
  requestedBy: 'U1', channelId: 'C1', messageTs: 'ts1', runId: null,
  error: null, createdAt: 't', updatedAt: 't',
};

describe('JobsRunner.tick', () => {
  it('advances each active job, persists the patch, and refreshes Slack', async () => {
    const repo = { listActive: vi.fn().mockResolvedValue([job]), update: vi.fn().mockResolvedValue(undefined) } as any;
    const advance = vi.fn().mockResolvedValue({ status: 'backend_running' });
    const slack = { chat: { update: vi.fn().mockResolvedValue({}) } } as any;
    const runner = new JobsRunner({ repo, advance, slack, gh: {} as any });
    await runner.tick();
    expect(repo.update).toHaveBeenCalledWith('j1', { status: 'backend_running' });
    expect(slack.chat.update).toHaveBeenCalledOnce();
  });

  it('does not update Slack when the patch is empty', async () => {
    const repo = { listActive: vi.fn().mockResolvedValue([job]), update: vi.fn() } as any;
    const advance = vi.fn().mockResolvedValue({});
    const slack = { chat: { update: vi.fn() } } as any;
    const runner = new JobsRunner({ repo, advance, slack, gh: {} as any });
    await runner.tick();
    expect(repo.update).not.toHaveBeenCalled();
    expect(slack.chat.update).not.toHaveBeenCalled();
  });

  it('marks a job failed when advance throws', async () => {
    const repo = { listActive: vi.fn().mockResolvedValue([job]), update: vi.fn().mockResolvedValue(undefined) } as any;
    const advance = vi.fn().mockRejectedValue(new Error('kaboom'));
    const slack = { chat: { update: vi.fn().mockResolvedValue({}) } } as any;
    const runner = new JobsRunner({ repo, advance, slack, gh: {} as any });
    await runner.tick();
    expect(repo.update).toHaveBeenCalledWith('j1', expect.objectContaining({ status: 'failed' }));
  });
});
