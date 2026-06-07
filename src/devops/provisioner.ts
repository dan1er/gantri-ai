import type { Job, JobSpec, JobStatus, FrontendRepo } from './types.js';
import { backendUrl } from './slug.js';
import type { GithubDispatcher } from './github.js';

export interface VercelReader {
  previewUrlForBranch(repo: FrontendRepo, ref: string): Promise<string>;
  wireAndRedeploy(repo: FrontendRepo, ref: string, backendUrl: string): Promise<string>;
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
  const f = job.spec.frontend;

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
      // backend ready; if fullstack, hand off to the frontend half
      return job.target === 'fullstack'
        ? { status: 'frontend_running', spec }
        : { status: 'ready', spec };
    }
  }

  // Frontend half (frontend + fullstack after backend is up)
  if ((job.target === 'frontend' || job.target === 'fullstack') && f && !f.url) {
    if (!deps.vercel) return { status: 'failed', error: 'vercel reader not configured' };
    // Full stack: wire the frontend to the backend preview (set the branch env
    // var + rebuild). Frontend-only stays on staging (no wiring).
    const url = job.target === 'fullstack' && b?.url
      ? await deps.vercel.wireAndRedeploy(f.repo, f.ref, b.url)
      : await deps.vercel.previewUrlForBranch(f.repo, f.ref);
    const spec: JobSpec = { ...job.spec, frontend: { ...f, url } };
    return { status: 'ready', spec };
  }

  return {};
}
