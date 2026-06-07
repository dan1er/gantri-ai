import { describe, it, expect, vi } from 'vitest';
import { advanceDeployJob } from '../../../src/devops/deploy-provisioner.js';
import type { Job } from '../../../src/devops/types.js';

const base: Job = {
  id: 'd1', kind: 'deploy', target: 'backend', status: 'pending',
  spec: { deployBackend: { tag: 'deploy-5188-2026.06.07', sha: 'abc', pr: 5188 } },
  requestedBy: 'U1', channelId: 'C1', messageTs: 'ts', runId: null, error: null, createdAt: 't', updatedAt: 't',
};

describe('advanceDeployJob', () => {
  it('pending backend → dispatches prod-deploy from master + backend_running', async () => {
    const gh = { dispatch: vi.fn().mockResolvedValue(undefined), findRunByMarker: vi.fn(), getRunState: vi.fn() } as any;
    const patch = await advanceDeployJob(base, { gh });
    expect(gh.dispatch).toHaveBeenCalledWith('porter', 'prod-deploy.yml', 'master', {
      tag: 'deploy-5188-2026.06.07', job_id: 'd1',
    });
    expect(patch.status).toBe('backend_running');
  });

  it('backend run success → sets prod api url + ready', async () => {
    const gh = { getRunState: vi.fn().mockResolvedValue('success') } as any;
    const patch = await advanceDeployJob({ ...base, status: 'backend_running', runId: 9 }, { gh });
    expect(patch.status).toBe('ready');
    expect(patch.spec?.deployBackend?.url).toBe('https://api.gantri.com');
  });

  it('frontend deploy: triggers prod deploy, then promotes when ready', async () => {
    const vercel = {
      deployToProd: vi.fn().mockResolvedValue({ projectId: 'p1', deploymentId: 'dpl_1', inspectorUrl: 'https://vercel.com/x' }),
      deploymentState: vi.fn().mockResolvedValue('ready'),
      promoteToProd: vi.fn().mockResolvedValue(undefined),
      prodUrl: vi.fn().mockReturnValue('https://www.gantri.com'),
    };
    const fe: Job = {
      ...base, target: 'frontend',
      spec: { deployFrontends: [{ repo: 'mantle', tag: 'deploy-1201-2026.06.07', sha: 'def', pr: 1201 }] },
    };
    const p1 = await advanceDeployJob(fe, { gh: {} as any, vercel } as any);
    expect(vercel.deployToProd).toHaveBeenCalledWith('mantle', 'deploy-1201-2026.06.07');
    expect(p1.status).toBe('frontend_running');

    const job2: Job = { ...fe, status: 'frontend_running', spec: p1.spec! };
    const p2 = await advanceDeployJob(job2, { gh: {} as any, vercel } as any);
    expect(vercel.promoteToProd).toHaveBeenCalledWith('p1', 'dpl_1');
    expect(p2.status).toBe('ready');
    expect(p2.spec?.deployFrontends?.[0]?.url).toBe('https://www.gantri.com');
  });
});
