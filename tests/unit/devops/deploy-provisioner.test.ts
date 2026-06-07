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

  it('fullstack: backend success hands off to frontend_running (then frontends deploy)', async () => {
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

  it('e2e gate: pending → persists e2e_running WITHOUT dispatching (dup-safe)', async () => {
    const gh = { dispatch: vi.fn(), findRunByMarker: vi.fn(), getRunState: vi.fn() } as any;
    const patch = await advanceDeployJob({ ...feE2e, status: 'pending' }, { gh } as any);
    expect(gh.dispatch).not.toHaveBeenCalled();
    expect(patch.status).toBe('e2e_running');
  });

  it('e2e gate: e2e_running + not dispatched → dispatches qase-trigger for the project', async () => {
    const gh = { dispatch: vi.fn().mockResolvedValue(undefined), findRunByMarker: vi.fn(), getRunState: vi.fn() } as any;
    const patch = await advanceDeployJob({ ...feE2e, status: 'e2e_running' }, { gh } as any);
    expect(gh.dispatch).toHaveBeenCalledWith('gantri-e2e', 'qase-trigger.yml', 'main', {
      project: 'marketplace', scope: 'smoke', marker: 'd1',
    });
    expect(patch.spec?.e2e?.dispatched).toBe(true);
  });

  it('e2e gate: with Qase wired → creates a run + passes qase_run_id', async () => {
    const gh = { dispatch: vi.fn().mockResolvedValue(undefined) } as any;
    const qase = { createRun: vi.fn().mockResolvedValue(297), runUrl: vi.fn() };
    const patch = await advanceDeployJob({ ...feE2e, status: 'e2e_running' }, { gh, qase } as any);
    expect(qase.createRun).toHaveBeenCalled();
    expect(gh.dispatch).toHaveBeenCalledWith('gantri-e2e', 'qase-trigger.yml', 'main', {
      project: 'marketplace', scope: 'smoke', marker: 'd1', qase_run_id: '297',
    });
    expect(patch.spec?.e2e?.qaseRunId).toBe(297);
  });

  it('e2e gate: run passes → hands off to the deploy phase', async () => {
    const gh = { getRunState: vi.fn().mockResolvedValue('success') } as any;
    const job: Job = { ...feE2e, status: 'e2e_running', spec: { ...feE2e.spec, e2e: { scope: 'smoke', project: 'marketplace', dispatched: true, runId: 5 } } };
    const patch = await advanceDeployJob(job, { gh } as any);
    expect(patch.status).toBe('pending');
    expect(patch.spec?.e2e?.passed).toBe(true);
  });

  it('e2e gate: run fails → deploy blocked', async () => {
    const gh = { getRunState: vi.fn().mockResolvedValue('failed') } as any;
    const job: Job = { ...feE2e, status: 'e2e_running', spec: { ...feE2e.spec, e2e: { scope: 'smoke', project: 'marketplace', dispatched: true, runId: 5 } } };
    const patch = await advanceDeployJob(job, { gh } as any);
    expect(patch.status).toBe('failed');
    expect(patch.error).toMatch(/E2E/);
  });

  it('e2e gate: completes the Qase run when the gate concludes', async () => {
    const gh = { getRunState: vi.fn().mockResolvedValue('failed') } as any;
    const qase = { createRun: vi.fn(), completeRun: vi.fn().mockResolvedValue(undefined), runUrl: vi.fn() };
    const job: Job = { ...feE2e, status: 'e2e_running', spec: { ...feE2e.spec, e2e: { scope: 'smoke', project: 'marketplace', dispatched: true, runId: 5, qaseRunId: 298 } } };
    await advanceDeployJob(job, { gh, qase } as any);
    expect(qase.completeRun).toHaveBeenCalledWith(298);
  });
});
