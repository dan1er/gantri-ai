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
    expect(gh.dispatch).toHaveBeenCalledWith('porter', 'preview-from-branch.yml', 'master', { ref: 'feat/as-1', slug: 'as-1', job_id: 'j1' });
    expect(patch.status).toBe('backend_running');
  });

  it('backend_running with no runId → resolves the run id', async () => {
    const gh = { findRunByMarker: vi.fn().mockResolvedValue(42), getRunState: vi.fn() } as any;
    const patch = await advancePreviewJob({ ...backendJob, status: 'backend_running', runId: null }, { gh });
    expect(patch.runId).toBe(42);
    expect(gh.findRunByMarker).toHaveBeenCalledWith('porter', 'preview-from-branch.yml', 'j1');
  });

  it('refresh (attempt set) uses preview-refresh + a unique marker job_id#N (in-place roll, DB preserved)', async () => {
    const refreshJob: Job = { ...backendJob, spec: { backend: { ref: 'feat/as-1', slug: 'as-1', attempt: 2 } } };
    const gh = { dispatch: vi.fn().mockResolvedValue(undefined), findRunByMarker: vi.fn().mockResolvedValue(99) } as any;
    // pending → dispatch carries the suffixed marker so it can't collide with the original run
    await advancePreviewJob(refreshJob, { gh });
    expect(gh.dispatch).toHaveBeenCalledWith('porter', 'preview-refresh.yml', 'master', { ref: 'feat/as-1', slug: 'as-1', job_id: 'j1#2' });
    // backend_running → findRunByMarker polls the SAME workflow with the same suffixed marker
    const patch = await advancePreviewJob({ ...refreshJob, status: 'backend_running', runId: null }, { gh });
    expect(gh.findRunByMarker).toHaveBeenCalledWith('porter', 'preview-refresh.yml', 'j1#2');
    expect(patch.runId).toBe(99);
  });

  it('backend_running success → sets url + ready', async () => {
    const gh = { getRunState: vi.fn().mockResolvedValue('success') } as any;
    const patch = await advancePreviewJob({ ...backendJob, status: 'backend_running', runId: 42 }, { gh });
    expect(patch.status).toBe('ready');
    expect(patch.spec?.backend?.url).toBe('https://as-1.preview.api.gantri.com');
  });

  it('fullstack backend success with un-wired frontends → hands off to frontend_running', async () => {
    const gh = { getRunState: vi.fn().mockResolvedValue('success') } as any;
    const job: Job = {
      ...backendJob, target: 'fullstack', status: 'backend_running', runId: 42,
      spec: { backend: { ref: 'feat/as-1', slug: 'as-1' }, frontends: [{ repo: 'mantle', ref: 'feat/as-1' }] },
    };
    const patch = await advancePreviewJob(job, { gh });
    expect(patch.status).toBe('frontend_running');
    expect(patch.spec?.backend?.url).toBe('https://as-1.preview.api.gantri.com');
  });

  it('backend refresh: fullstack backend success with already-wired frontends → ready, no re-wire', async () => {
    const gh = { getRunState: vi.fn().mockResolvedValue('success') } as any;
    const vercel = { wireAndRedeploy: vi.fn() };
    // Refresh re-runs the backend half (backend.url cleared) while the frontends
    // already carry their URLs — they must NOT be re-wired and the job goes
    // straight to ready rather than stalling in frontend_running.
    const job: Job = {
      ...backendJob, target: 'fullstack', status: 'backend_running', runId: 42,
      spec: {
        backend: { ref: 'feat/as-1', slug: 'as-1' },
        frontends: [{ repo: 'mantle', ref: 'feat/as-1', url: 'https://marketplace-git-x.vercel.app' }],
      },
    };
    const patch = await advancePreviewJob(job, { gh, vercel } as any);
    expect(patch.status).toBe('ready');
    expect(vercel.wireAndRedeploy).not.toHaveBeenCalled();
    expect(patch.spec?.backend?.url).toBe('https://as-1.preview.api.gantri.com');
  });

  it('backend_running failed → failed with error', async () => {
    const gh = { getRunState: vi.fn().mockResolvedValue('failed') } as any;
    const patch = await advancePreviewJob({ ...backendJob, status: 'backend_running', runId: 42 }, { gh });
    expect(patch.status).toBe('failed');
    expect(patch.error).toMatch(/workflow/i);
  });

  it('frontend job → reads the staging preview url for each frontend and is ready', async () => {
    const gh = {} as any;
    const vercel = { previewUrlForBranch: vi.fn().mockResolvedValue('https://mantle-git-x.vercel.app') };
    const fe: Job = { ...backendJob, target: 'frontend', spec: { frontends: [{ repo: 'mantle', ref: 'feat/as-1' }] } };
    const patch = await advancePreviewJob(fe, { gh, vercel } as any);
    expect(patch.status).toBe('ready');
    expect(patch.spec?.frontends?.[0]?.url).toContain('vercel.app');
  });

  it('fullstack frontend half wires each frontend to the backend + keeps the deployment url', async () => {
    const gh = {} as any;
    const vercel = {
      wireAndRedeploy: vi.fn().mockResolvedValue({
        url: 'https://marketplace-git-x.vercel.app', deploymentUrl: 'https://marketplace-abc.vercel.app',
      }),
    };
    const job: Job = {
      ...backendJob, target: 'fullstack', status: 'frontend_running',
      spec: {
        backend: { ref: 'feat/as-1', slug: 'as-1', url: 'https://as-1.preview.api.gantri.com' },
        frontends: [{ repo: 'mantle', ref: 'feat/as-1' }],
      },
    };
    const patch = await advancePreviewJob(job, { gh, vercel } as any);
    expect(vercel.wireAndRedeploy).toHaveBeenCalledWith('mantle', 'feat/as-1', 'https://as-1.preview.api.gantri.com');
    expect(patch.status).toBe('ready');
    expect(patch.spec?.frontends?.[0]?.deploymentUrl).toContain('marketplace-abc');
  });
});
