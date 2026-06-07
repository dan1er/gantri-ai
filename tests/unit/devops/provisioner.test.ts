import { describe, it, expect, vi } from 'vitest';
import { advancePreviewJob } from '../../../src/devops/provisioner.js';
import type { Job } from '../../../src/devops/types.js';

const backendJob: Job = {
  id: 'j1', kind: 'preview', target: 'backend', status: 'pending',
  spec: { backend: { ref: 'feat/as-1', slug: 'as-1' } },
  requestedBy: 'U1', channelId: 'C1', messageTs: 'ts', runId: null,
  error: null, createdAt: 't', updatedAt: 't',
};

describe('advancePreviewJob', () => {
  it('pending backend → dispatches and moves to backend_running', async () => {
    const gh = { dispatch: vi.fn().mockResolvedValue(undefined), findRunByMarker: vi.fn(), getRunState: vi.fn() } as any;
    const patch = await advancePreviewJob(backendJob, { gh });
    expect(gh.dispatch).toHaveBeenCalledWith('porter', 'preview-create.yml', 'feat/as-1', { ref: 'feat/as-1', slug: 'as-1', job_id: 'j1' });
    expect(patch.status).toBe('backend_running');
  });

  it('backend_running with no runId → resolves the run id', async () => {
    const gh = { findRunByMarker: vi.fn().mockResolvedValue(42), getRunState: vi.fn() } as any;
    const patch = await advancePreviewJob({ ...backendJob, status: 'backend_running', runId: null }, { gh });
    expect(patch.runId).toBe(42);
  });

  it('backend_running success → sets url + ready', async () => {
    const gh = { getRunState: vi.fn().mockResolvedValue('success') } as any;
    const patch = await advancePreviewJob({ ...backendJob, status: 'backend_running', runId: 42 }, { gh });
    expect(patch.status).toBe('ready');
    expect(patch.spec?.backend?.url).toBe('https://as-1.api.preview.gantri.com');
  });

  it('backend_running failed → failed with error', async () => {
    const gh = { getRunState: vi.fn().mockResolvedValue('failed') } as any;
    const patch = await advancePreviewJob({ ...backendJob, status: 'backend_running', runId: 42 }, { gh });
    expect(patch.status).toBe('failed');
    expect(patch.error).toMatch(/workflow/i);
  });

  it('frontend job → reads the staging preview url and is ready', async () => {
    const gh = {} as any;
    const vercel = { previewUrlForBranch: vi.fn().mockResolvedValue('https://mantle-git-x.vercel.app') };
    const fe: Job = { ...backendJob, target: 'frontend', spec: { frontend: { repo: 'mantle', ref: 'feat/as-1' } } };
    const patch = await advancePreviewJob(fe, { gh, vercel } as any);
    expect(patch.status).toBe('ready');
    expect(patch.spec?.frontend?.url).toContain('vercel.app');
  });
});
