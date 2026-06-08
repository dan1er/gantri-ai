import type { Job, JobSpec, JobStatus, FrontendRepo } from './types.js';
import { backendUrl } from './slug.js';
import type { GithubDispatcher } from './github.js';
import type { QaseReader } from './qase.js';

export interface VercelReader {
  previewUrlForBranch(repo: FrontendRepo, ref: string): Promise<string>;
  wireAndRedeploy(repo: FrontendRepo, ref: string, backendUrl: string): Promise<{ url: string; deploymentUrl?: string }>;
  deployToProd(repo: FrontendRepo, ref: string): Promise<{ projectId: string; deploymentId: string; inspectorUrl?: string }>;
  deploymentState(deploymentId: string): Promise<'building' | 'ready' | 'error'>;
  promoteToProd(projectId: string, deploymentId: string): Promise<void>;
  prodUrl(repo: FrontendRepo): string;
  removeBranchEnv(repo: FrontendRepo, ref: string): Promise<void>;
}

export interface ProvisionerDeps {
  gh: GithubDispatcher;
  vercel?: VercelReader;
  qase?: QaseReader;
}

export interface JobPatch {
  status?: JobStatus;
  spec?: JobSpec;
  runId?: number | null;
  error?: string | null;
}

const PORTER = 'porter';
// Entry point: builds porter-api from the branch (→ ECR) then calls the reusable
// preview-create.yml to provision. Takes { ref, slug, job_id }; its run-name
// carries job_id so the bot can find the run. (preview-create.yml itself is now
// the inner reusable workflow that takes a pre-built image.)
const CREATE_WF = 'preview-from-branch.yml';
// The workflow definition only lives on porter's default branch, so dispatch
// the run from there. The actual preview target branch travels as the `ref`
// input (a feature branch usually won't have the workflow file yet).
const WORKFLOW_REF = 'master';

export async function advancePreviewJob(job: Job, deps: ProvisionerDeps): Promise<JobPatch> {
  const b = job.spec.backend;
  const fes = job.spec.frontends ?? [];

  // Backend half (backend + fullstack)
  if ((job.target === 'backend' || job.target === 'fullstack') && b && !b.url) {
    if (job.status === 'pending') {
      await deps.gh.dispatch(PORTER, CREATE_WF, WORKFLOW_REF, { ref: b.ref, slug: b.slug, job_id: job.id });
      return { status: 'backend_running' };
    }
    if (job.status === 'backend_running' && job.runId == null) {
      const runId = await deps.gh.findRunByMarker(PORTER, CREATE_WF, job.id);
      return runId == null ? {} : { runId };
    }
    if (job.status === 'backend_running' && job.runId != null) {
      const state = await deps.gh.getRunState(PORTER, job.runId);
      if (state === 'running') return {};
      if (state === 'failed') return { status: 'failed', error: 'backend workflow failed' };
      const spec: JobSpec = { ...job.spec, backend: { ...b, url: backendUrl(b.slug) } };
      // Backend ready. Hand off to the frontend half only if a frontend still
      // needs wiring. On a backend refresh the frontends already carry their
      // URLs (the slug — hence the backend URL — is unchanged, so no re-wire),
      // so go straight to ready instead of stalling in frontend_running.
      return job.target === 'fullstack' && fes.some((x) => !x.url)
        ? { status: 'frontend_running', spec }
        : { status: 'ready', spec };
    }
  }

  // Frontend half (frontend + fullstack after backend is up) — fan out to all frontends
  if ((job.target === 'frontend' || job.target === 'fullstack') && fes.some((x) => !x.url)) {
    const vercel = deps.vercel;
    if (!vercel) return { status: 'failed', error: 'vercel reader not configured' };
    // Full stack: wire each frontend to the backend preview (set the branch env
    // var + rebuild). Frontend-only stays on staging (no wiring).
    const wired = await Promise.all(fes.map(async (x) => {
      if (x.url) return x;
      if (job.target === 'fullstack' && b?.url) {
        const { url, deploymentUrl } = await vercel.wireAndRedeploy(x.repo, x.ref, b.url);
        return { ...x, url, deploymentUrl };
      }
      return { ...x, url: await vercel.previewUrlForBranch(x.repo, x.ref) };
    }));
    const spec: JobSpec = { ...job.spec, frontends: wired };
    return { status: 'ready', spec };
  }

  return {};
}
