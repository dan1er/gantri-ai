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

  it('frontend (no gate): pending → frontend_running (status only) → build → promote → ready', async () => {
    const vercel = {
      deployToProd: vi.fn().mockResolvedValue({ projectId: 'p1', deploymentId: 'dpl_1', inspectorUrl: 'u' }),
      deploymentState: vi.fn().mockResolvedValue('ready'),
      promoteToProd: vi.fn().mockResolvedValue(undefined),
      prodUrl: vi.fn().mockReturnValue('https://www.gantri.com'),
    };
    const fe: Job = { ...base, target: 'frontend', spec: { deployFrontends: [{ repo: 'mantle', tag: 't', sha: 'a', pr: 1 }] } };

    const p1 = await advanceDeployJob(fe, { gh: {} as any, vercel } as any);
    expect(p1.status).toBe('frontend_running');
    expect(vercel.deployToProd).not.toHaveBeenCalled();

    const p2 = await advanceDeployJob({ ...fe, status: 'frontend_running' }, { gh: {} as any, vercel } as any);
    expect(vercel.deployToProd).toHaveBeenCalledWith('mantle', 't');
    expect(p2.status).toBe('frontend_running');
    expect(p2.spec?.deployFrontends?.[0]?.deploymentId).toBe('dpl_1');

    const p3 = await advanceDeployJob({ ...fe, status: 'frontend_running', spec: p2.spec! }, { gh: {} as any, vercel } as any);
    expect(vercel.promoteToProd).toHaveBeenCalledWith('p1', 'dpl_1');
    expect(p3.status).toBe('ready');
    expect(p3.spec?.deployFrontends?.[0]?.url).toBe('https://www.gantri.com');
  });

  it('frontends are independent: one deploy errors, the sibling still promotes', async () => {
    const vercel = {
      deployToProd: vi.fn(),
      deploymentState: vi.fn().mockImplementation((id: string) => (id === 'd1' ? 'ready' : 'error')),
      promoteToProd: vi.fn().mockResolvedValue(undefined),
      prodUrl: vi.fn().mockReturnValue('https://www.gantri.com'),
    };
    const job: Job = {
      ...base, target: 'frontend', status: 'frontend_running',
      spec: { deployFrontends: [
        { repo: 'mantle', tag: 't1', sha: 'a', pr: 1, deploymentId: 'd1', projectId: 'p1' },
        { repo: 'core', tag: 't2', sha: 'b', pr: 2, deploymentId: 'd2', projectId: 'p2' },
      ] },
    };
    const patch = await advanceDeployJob(job, { gh: {} as any, vercel } as any);
    expect(patch.status).toBe('failed');
    expect(patch.spec?.deployFrontends?.find((f) => f.repo === 'mantle')?.url).toBe('https://www.gantri.com');
    expect(patch.spec?.deployFrontends?.find((f) => f.repo === 'core')?.error).toBeTruthy();
  });

  const fullstack: Job = {
    ...base, target: 'fullstack',
    spec: {
      deployBackend: { tag: 'deploy-5187-2026.06.07', sha: 'a', pr: 5187 },
      deployFrontends: [{ repo: 'mantle', tag: 'deploy-1199-2026.06.07', sha: 'b', pr: 1199 }],
    },
  };

  it('fullstack: frontends do NOT deploy while the backend is still running', async () => {
    const gh = { getRunState: vi.fn().mockResolvedValue('running') } as any;
    const vercel = { deployToProd: vi.fn(), deploymentState: vi.fn(), promoteToProd: vi.fn(), prodUrl: vi.fn() };
    const patch = await advanceDeployJob({ ...fullstack, status: 'backend_running', runId: 7 }, { gh, vercel } as any);
    expect(vercel.deployToProd).not.toHaveBeenCalled();
    expect(patch.status).toBeUndefined();
  });

  it('fullstack: backend success hands off to frontend_running', async () => {
    const gh = { getRunState: vi.fn().mockResolvedValue('success') } as any;
    const patch = await advanceDeployJob({ ...fullstack, status: 'backend_running', runId: 7 }, { gh } as any);
    expect(patch.status).toBe('frontend_running');
    expect(patch.spec?.deployBackend?.url).toBe('https://api.gantri.com');
  });

  const feE2e: Job = {
    ...base, target: 'frontend',
    spec: {
      deployFrontends: [{ repo: 'mantle', tag: 'deploy-1201-2026.06.07', sha: 'def', pr: 1201 }],
      e2e: { scope: 'smoke' },
    },
  };

  it('gated frontend: pending → frontend_running (no side effects)', async () => {
    const gh = { dispatch: vi.fn() } as any;
    const patch = await advanceDeployJob({ ...feE2e, status: 'pending' }, { gh, vercel: {} } as any);
    expect(gh.dispatch).not.toHaveBeenCalled();
    expect(patch.status).toBe('frontend_running');
  });

  it('gated frontend: frontend_running → dispatches its E2E AND starts its build (overlap)', async () => {
    const gh = { dispatch: vi.fn().mockResolvedValue(undefined), findRunByMarker: vi.fn(), getRunState: vi.fn() } as any;
    const vercel = {
      deployToProd: vi.fn().mockResolvedValue({ projectId: 'p1', deploymentId: 'dpl_1', inspectorUrl: 'u' }),
      deploymentState: vi.fn(), promoteToProd: vi.fn(), prodUrl: vi.fn(),
    };
    const patch = await advanceDeployJob({ ...feE2e, status: 'frontend_running' }, { gh, vercel } as any);
    expect(gh.dispatch).toHaveBeenCalledWith('gantri-e2e', 'qase-trigger.yml', 'main', {
      project: 'marketplace', scope: 'smoke', marker: 'd1:mantle',
    });
    expect(vercel.deployToProd).toHaveBeenCalledWith('mantle', 'deploy-1201-2026.06.07');
    const fe = patch.spec?.deployFrontends?.[0];
    expect(fe?.e2eDispatched).toBe(true);
    expect(fe?.deploymentId).toBe('dpl_1');
  });

  it('gated frontend: E2E green + build ready → promote → live', async () => {
    const gh = { getRunState: vi.fn().mockResolvedValue('success'), findRunByMarker: vi.fn() } as any;
    const vercel = {
      deployToProd: vi.fn(), deploymentState: vi.fn().mockResolvedValue('ready'),
      promoteToProd: vi.fn().mockResolvedValue(undefined), prodUrl: vi.fn().mockReturnValue('https://www.gantri.com'),
    };
    const job: Job = {
      ...feE2e, status: 'frontend_running',
      spec: { deployFrontends: [{ repo: 'mantle', tag: 't', sha: 'a', pr: 1, e2eDispatched: true, e2eRunId: 5, deploymentId: 'dpl_1', projectId: 'p1' }], e2e: { scope: 'smoke' } },
    };
    const patch = await advanceDeployJob(job, { gh, vercel } as any);
    expect(vercel.promoteToProd).toHaveBeenCalledWith('p1', 'dpl_1');
    expect(patch.status).toBe('ready');
    expect(patch.spec?.deployFrontends?.[0]?.url).toBe('https://www.gantri.com');
  });

  it('gated frontend: E2E fails → blocked, build NOT promoted', async () => {
    const gh = { getRunState: vi.fn().mockResolvedValue('failed'), findRunByMarker: vi.fn() } as any;
    const vercel = { deployToProd: vi.fn(), deploymentState: vi.fn(), promoteToProd: vi.fn(), prodUrl: vi.fn() };
    const job: Job = {
      ...feE2e, status: 'frontend_running',
      spec: { deployFrontends: [{ repo: 'mantle', tag: 't', sha: 'a', pr: 1, e2eDispatched: true, e2eRunId: 5, deploymentId: 'dpl_1', projectId: 'p1' }], e2e: { scope: 'smoke' } },
    };
    const patch = await advanceDeployJob(job, { gh, vercel } as any);
    expect(vercel.promoteToProd).not.toHaveBeenCalled();
    expect(patch.status).toBe('failed');
    expect(patch.spec?.deployFrontends?.[0]?.e2ePassed).toBe(false);
  });

  it('independence: one frontend fails its gate, the other still deploys', async () => {
    const gh = {
      findRunByMarker: vi.fn(),
      getRunState: vi.fn().mockImplementation((_r: string, id: number) => (id === 5 ? 'success' : 'failed')),
    } as any;
    const vercel = {
      deployToProd: vi.fn(), deploymentState: vi.fn().mockResolvedValue('ready'),
      promoteToProd: vi.fn().mockResolvedValue(undefined), prodUrl: vi.fn().mockReturnValue('https://www.gantri.com'),
    };
    const job: Job = {
      ...base, target: 'frontend', status: 'frontend_running',
      spec: {
        deployFrontends: [
          { repo: 'mantle', tag: 't1', sha: 'a', pr: 1, e2eDispatched: true, e2eRunId: 5, deploymentId: 'dpl_1', projectId: 'p1' },
          { repo: 'core', tag: 't2', sha: 'b', pr: 2, e2eDispatched: true, e2eRunId: 6, deploymentId: 'dpl_2', projectId: 'p2' },
        ],
        e2e: { scope: 'smoke' },
      },
    };
    const patch = await advanceDeployJob(job, { gh, vercel } as any);
    expect(patch.status).toBe('failed');
    expect(patch.spec?.deployFrontends?.find((f) => f.repo === 'mantle')?.url).toBe('https://www.gantri.com');
    expect(patch.spec?.deployFrontends?.find((f) => f.repo === 'core')?.e2ePassed).toBe(false);
  });

  it('Qase: creates a run + passes qase_run_id on dispatch, completes it on conclusion', async () => {
    const gh1 = { dispatch: vi.fn().mockResolvedValue(undefined), findRunByMarker: vi.fn(), getRunState: vi.fn() } as any;
    const qase1 = { createRun: vi.fn().mockResolvedValue(297), completeRun: vi.fn(), runUrl: vi.fn() };
    const vercel = {
      deployToProd: vi.fn().mockResolvedValue({ projectId: 'p1', deploymentId: 'dpl_1', inspectorUrl: 'u' }),
      deploymentState: vi.fn(), promoteToProd: vi.fn(), prodUrl: vi.fn(),
    };
    const p1 = await advanceDeployJob({ ...feE2e, status: 'frontend_running' }, { gh: gh1, qase: qase1, vercel } as any);
    expect(qase1.createRun).toHaveBeenCalled();
    expect(gh1.dispatch).toHaveBeenCalledWith('gantri-e2e', 'qase-trigger.yml', 'main', {
      project: 'marketplace', scope: 'smoke', marker: 'd1:mantle', qase_run_id: '297',
    });
    expect(p1.spec?.deployFrontends?.[0]?.e2eQaseRunId).toBe(297);

    const gh2 = { getRunState: vi.fn().mockResolvedValue('failed'), findRunByMarker: vi.fn() } as any;
    const qase2 = { createRun: vi.fn(), completeRun: vi.fn().mockResolvedValue(undefined), runUrl: vi.fn() };
    const job2: Job = {
      ...feE2e, status: 'frontend_running',
      spec: { deployFrontends: [{ repo: 'mantle', tag: 't', sha: 'a', pr: 1, e2eDispatched: true, e2eRunId: 5, e2eQaseRunId: 298 }], e2e: { scope: 'smoke' } },
    };
    await advanceDeployJob(job2, { gh: gh2, qase: qase2, vercel: {} as any } as any);
    expect(qase2.completeRun).toHaveBeenCalledWith(298);
  });
});
