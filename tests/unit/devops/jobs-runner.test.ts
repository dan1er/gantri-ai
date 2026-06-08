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

  it('on a deploy going ready, threads a note with the previous deploy + manual rollback steps', async () => {
    const deployJob: Job = {
      id: 'd1', kind: 'deploy', target: 'backend', status: 'backend_running',
      spec: { deployBackend: { tag: 'deploy-5198-2026.06.08', sha: 's', pr: 5198, url: 'https://api.gantri.com', prevDeployTag: 'deploy-5196-2026.06.08' } },
      requestedBy: 'U1', channelId: 'C1', messageTs: 'tsD', runId: 9, error: null, createdAt: 't', updatedAt: 't',
    };
    const repo = { listActive: vi.fn().mockResolvedValue([deployJob]), update: vi.fn().mockResolvedValue(undefined) } as any;
    const advance = vi.fn().mockResolvedValue({ status: 'ready' });
    const slack = { chat: { update: vi.fn().mockResolvedValue({}), postMessage: vi.fn().mockResolvedValue({}) } } as any;
    const runner = new JobsRunner({ repo, advance, slack, gh: {} as any });
    await runner.tick();
    expect(slack.chat.postMessage).toHaveBeenCalledOnce();
    const arg = slack.chat.postMessage.mock.calls[0][0];
    expect(arg.thread_ts).toBe('tsD');
    expect(arg.text).toContain('deploy-5196-2026.06.08');
    expect(arg.text).toMatch(/\/deploy/i);
  });
});
