import type { Job, JobSpec, DeployItem } from './types.js';
import type { ProvisionerDeps, JobPatch } from './provisioner.js';

const PORTER = 'porter';
const PROD_WF = 'prod-deploy.yml';
const PROD_API = 'https://api.gantri.com';
const E2E_REPO = 'gantri-e2e';
const E2E_WF = 'qase-trigger.yml';
const E2E_PROJECT: Record<string, string> = { mantle: 'marketplace', core: 'factoryOs', made: 'madeOs' };

type Vercel = NonNullable<ProvisionerDeps['vercel']>;

/**
 * Advance a `deploy` job: ship the chosen tags to production. For fullstack the
 * backend goes through the porter prod-deploy workflow first. Each frontend
 * then runs its OWN pipeline, independently and in parallel: its project's E2E
 * smoke runs WHILE its Vercel production build builds (overlap), and it promotes
 * the moment its own test is green. A frontend's failure never blocks a sibling
 * — the fast ones go live while the slow one is still testing.
 */
export async function advanceDeployJob(job: Job, deps: ProvisionerDeps): Promise<JobPatch> {
  const b = job.spec.deployBackend;
  const fes = job.spec.deployFrontends ?? [];
  const gateScope = job.spec.e2e?.scope;

  // Backend half (backend + fullstack) — deploys first.
  if ((job.target === 'backend' || job.target === 'fullstack') && b && !b.url) {
    if (job.status === 'pending') {
      await deps.gh.dispatch(PORTER, PROD_WF, 'master', { tag: b.tag, job_id: job.id });
      return { status: 'backend_running' };
    }
    if (job.status === 'backend_running' && job.runId == null) {
      const runId = await deps.gh.findRunByMarker(PORTER, PROD_WF, job.id);
      return runId == null ? {} : { runId };
    }
    if (job.status === 'backend_running' && job.runId != null) {
      const state = await deps.gh.getRunState(PORTER, job.runId);
      if (state === 'running') return {};
      if (state === 'failed') return { status: 'failed', error: 'prod-deploy workflow failed' };
      const spec: JobSpec = { ...job.spec, deployBackend: { ...b, url: PROD_API } };
      return job.target === 'fullstack' && fes.length > 0
        ? { status: 'frontend_running', spec }
        : { status: 'ready', spec };
    }
  }

  // Frontend-only: enter the frontend phase (status transition only, no side
  // effects — keeps the dispatch/build out of the status update).
  if (job.target === 'frontend' && job.status === 'pending') {
    return { status: 'frontend_running' };
  }

  // Frontend phase — each frontend its own test→build→promote pipeline, run in
  // parallel and resolved independently.
  if ((job.target === 'frontend' || job.target === 'fullstack') && job.status === 'frontend_running') {
    const vercel = deps.vercel;
    if (!vercel) return { status: 'failed', error: 'vercel reader not configured' };
    const advanced = await Promise.all(fes.map((f) => advanceFrontend(f, job.id, gateScope, deps, vercel)));
    const spec: JobSpec = { ...job.spec, deployFrontends: advanced };
    if (advanced.some(inProgress)) return { status: 'frontend_running', spec };
    return advanced.some((f) => f.error || f.e2ePassed === false)
      ? { status: 'failed', error: 'one or more frontends did not deploy', spec }
      : { status: 'ready', spec };
  }

  return {};
}

// A frontend still working: has a repo, isn't live, isn't deploy-errored, and
// its gate hasn't blocked it.
function inProgress(f: DeployItem): boolean {
  return !!f.repo && !f.url && !f.error && f.e2ePassed !== false;
}

async function advanceFrontend(
  fe: DeployItem, jobId: string, gateScope: 'smoke' | 'both' | undefined,
  deps: ProvisionerDeps, vercel: Vercel,
): Promise<DeployItem> {
  if (!inProgress(fe)) return fe;
  let f = fe;
  // E2E leg (if gated) — advances one step; overlaps the build leg below.
  if (gateScope && f.e2ePassed === undefined) {
    f = await advanceE2eLeg(f, jobId, gateScope, deps);
    if (f.e2ePassed === false) return f; // blocked — no build/promote
  }
  // Build leg — start the production build eagerly (it builds WHILE the test
  // runs); promote only once the test is green (or there is no gate).
  try {
    if (!f.deploymentId) {
      const r = await vercel.deployToProd(f.repo!, f.tag);
      return { ...f, projectId: r.projectId, deploymentId: r.deploymentId, deploymentUrl: r.inspectorUrl };
    }
    if (!gateScope || f.e2ePassed === true) {
      const state = await vercel.deploymentState(f.deploymentId);
      if (state === 'error') return { ...f, error: 'Vercel deployment errored' };
      if (state === 'ready') {
        await vercel.promoteToProd(f.projectId ?? '', f.deploymentId);
        return { ...f, url: vercel.prodUrl(f.repo!) };
      }
    }
    return f;
  } catch (err) {
    return { ...f, error: String((err as Error)?.message ?? err).slice(0, 120) };
  }
}

async function advanceE2eLeg(
  f: DeployItem, jobId: string, scope: 'smoke' | 'both', deps: ProvisionerDeps,
): Promise<DeployItem> {
  const project = E2E_PROJECT[f.repo ?? ''] ?? 'marketplace';
  const marker = `${jobId}:${f.repo}`;
  if (!f.e2eDispatched) {
    const qaseRunId = deps.qase ? await deps.qase.createRun(`Deploy gate · ${project} · ${scope}`) : null;
    const inputs: Record<string, string> = {
      project, scope: scope === 'both' ? 'all' : 'smoke', marker,
    };
    if (qaseRunId) inputs.qase_run_id = String(qaseRunId);
    await deps.gh.dispatch(E2E_REPO, E2E_WF, 'main', inputs);
    return { ...f, e2eDispatched: true, e2eQaseRunId: qaseRunId };
  }
  if (f.e2eRunId == null) {
    const runId = await deps.gh.findRunByMarker(E2E_REPO, E2E_WF, marker);
    return runId == null ? f : { ...f, e2eRunId: runId };
  }
  const state = await deps.gh.getRunState(E2E_REPO, f.e2eRunId);
  if (state === 'running') return f;
  if (deps.qase && f.e2eQaseRunId) await deps.qase.completeRun(f.e2eQaseRunId);
  return { ...f, e2ePassed: state === 'success' };
}
