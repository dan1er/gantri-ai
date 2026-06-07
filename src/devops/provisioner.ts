import type { Job, JobSpec, JobStatus, FrontendRepo } from './types.js';
import { backendUrl } from './slug.js';
import type { GithubDispatcher } from './github.js';

export interface VercelReader {
  previewUrlForBranch(repo: FrontendRepo, ref: string): Promise<string>;
  wireAndRedeploy(repo: FrontendRepo, ref: string, backendUrl: string): Promise<{ url: string; deploymentUrl?: string }>;
  deployToProd(repo: FrontendRepo, ref: string): Promise<{ projectId: string; deploymentId: string; inspectorUrl?: string }>;
  deploymentState(deploymentId: string): Promise<'building' | 'ready' | 'error'>;
  promoteToProd(projectId: string, deploymentId: string): Promise<void>;
  prodUrl(repo: FrontendRepo): string;
}

export interface ProvisionerDeps {
  gh: GithubDispatcher;
  vercel?: VercelReader;
}

export interface JobPatch {
  status?: JobStatus;
  spec?: JobSpec;
  runId?: number | null;
  error?: string | null;
}

const PORTER = 'porter';
const CREATE_WF = 'preview-create.yml';
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
      // backend ready; if fullstack with frontends, hand off to the frontend half
      return job.target === 'fullstack' && fes.length > 0
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
