import type { Job, JobSpec } from './types.js';
import type { ProvisionerDeps, JobPatch } from './provisioner.js';

const PORTER = 'porter';
const PROD_WF = 'prod-deploy.yml';
const PROD_API = 'https://api.gantri.com';
const E2E_REPO = 'gantri-e2e';
const E2E_WF = 'qase-trigger.yml';
const E2E_PROJECT: Record<string, string> = { mantle: 'marketplace', core: 'factoryOs', made: 'madeOs' };

/**
 * Advance a `deploy` job: ship the chosen tags to production. Backend goes
 * through the porter prod-deploy workflow; each frontend is a Vercel
 * production-target deploy (prod env vars) that is promoted once it's ready.
 */
export async function advanceDeployJob(job: Job, deps: ProvisionerDeps): Promise<JobPatch> {
  const b = job.spec.deployBackend;
  const fes = job.spec.deployFrontends ?? [];
  const e2e = job.spec.e2e;

  // E2E gate — runs before any deploy. Persist e2e_running FIRST, then dispatch
  // (guarded by `dispatched`) so a failed state update can never re-fire the
  // dispatch. Passing hands off to the deploy phase (status back to 'pending').
  if (e2e?.scope && e2e.passed !== true) {
    if (job.status === 'pending') {
      return { status: 'e2e_running' };
    }
    if (job.status === 'e2e_running' && !e2e.dispatched) {
      const project = E2E_PROJECT[fes[0]?.repo ?? ''] ?? 'marketplace';
      // Create the Qase run up front so we know its exact URL; qase-trigger
      // appends the Playwright results to it via qase_run_id.
      const qaseRunId = deps.qase
        ? await deps.qase.createRun(`Deploy gate · ${project} · ${e2e.scope}`)
        : null;
      const inputs: Record<string, string> = {
        project, scope: e2e.scope === 'both' ? 'all' : 'smoke', marker: job.id,
      };
      if (qaseRunId) inputs.qase_run_id = String(qaseRunId);
      await deps.gh.dispatch(E2E_REPO, E2E_WF, 'main', inputs);
      return { spec: { ...job.spec, e2e: { ...e2e, dispatched: true, project, qaseRunId } } };
    }
    if (job.status === 'e2e_running' && e2e.dispatched && e2e.runId == null) {
      const runId = await deps.gh.findRunByMarker(E2E_REPO, E2E_WF, job.id);
      return runId == null ? {} : { spec: { ...job.spec, e2e: { ...e2e, runId } } };
    }
    if (job.status === 'e2e_running' && e2e.runId != null) {
      const state = await deps.gh.getRunState(E2E_REPO, e2e.runId);
      if (state === 'running') return {};
      // Gate concluded — the bot created the Qase run, so it closes it.
      if (deps.qase && e2e.qaseRunId) await deps.qase.completeRun(e2e.qaseRunId);
      if (state === 'failed') {
        return { status: 'failed', error: 'E2E gate failed — deploy blocked', spec: { ...job.spec, e2e: { ...e2e, passed: false } } };
      }
      return { status: 'pending', spec: { ...job.spec, e2e: { ...e2e, passed: true } } };
    }
  }

  // Backend half (backend + fullstack)
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

  // Frontend half (frontend + fullstack) — deploy(prod) -> poll -> promote, per
  // repo, in parallel. A failure is recorded on that frontend (not thrown) so
  // the siblings keep going and the failed one can be retried on its own.
  if ((job.target === 'frontend' || job.target === 'fullstack') && fes.some((x) => x.repo && !x.url && !x.error)) {
    const vercel = deps.vercel;
    if (!vercel) return { status: 'failed', error: 'vercel reader not configured' };
    const advanced = await Promise.all(fes.map(async (fe) => {
      if (fe.url || !fe.repo || fe.error) return fe;
      try {
        if (!fe.deploymentId) {
          const { projectId, deploymentId, inspectorUrl } = await vercel.deployToProd(fe.repo, fe.tag);
          return { ...fe, projectId, deploymentId, deploymentUrl: inspectorUrl };
        }
        const state = await vercel.deploymentState(fe.deploymentId);
        if (state === 'error') return { ...fe, error: 'Vercel deployment errored' };
        if (state === 'ready') {
          await vercel.promoteToProd(fe.projectId ?? '', fe.deploymentId);
          return { ...fe, url: vercel.prodUrl(fe.repo) };
        }
        return fe;
      } catch (err) {
        return { ...fe, error: String((err as Error)?.message ?? err).slice(0, 120) };
      }
    }));
    const spec: JobSpec = { ...job.spec, deployFrontends: advanced };
    if (advanced.some((x) => x.repo && !x.url && !x.error)) return { status: 'frontend_running', spec };
    if (advanced.some((x) => x.error)) return { status: 'failed', error: 'one or more frontends failed to deploy', spec };
    return { status: 'ready', spec };
  }

  return {};
}
