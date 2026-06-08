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

  // E2E gate — one qase-trigger run per distinct deployed frontend project, in
  // parallel. Persist e2e_running FIRST, then dispatch (guarded per run by
  // `dispatched`) so a failed state update can never re-fire a dispatch. The
  // gate passes only when EVERY project's run is green.
  if (e2e?.scope && e2e.passed !== true) {
    const projects = [...new Set(fes.map((f) => E2E_PROJECT[f.repo ?? '']).filter(Boolean))];
    if (job.status === 'pending') {
      return { status: 'e2e_running', spec: { ...job.spec, e2e: { ...e2e, runs: projects.map((project) => ({ project })) } } };
    }
    if (job.status === 'e2e_running') {
      const runs = e2e.runs ?? [];
      const advanced = await Promise.all(runs.map(async (r) => {
        if (r.passed !== undefined) return r;
        const marker = `${job.id}:${r.project}`;
        if (!r.dispatched) {
          // Create the Qase run up front so we know its exact URL; qase-trigger
          // appends the Playwright results to it via qase_run_id.
          const qaseRunId = deps.qase ? await deps.qase.createRun(`Deploy gate · ${r.project} · ${e2e.scope}`) : null;
          const inputs: Record<string, string> = {
            project: r.project, scope: e2e.scope === 'both' ? 'all' : 'smoke', marker,
          };
          if (qaseRunId) inputs.qase_run_id = String(qaseRunId);
          await deps.gh.dispatch(E2E_REPO, E2E_WF, 'main', inputs);
          return { ...r, dispatched: true, qaseRunId };
        }
        if (r.runId == null) {
          const runId = await deps.gh.findRunByMarker(E2E_REPO, E2E_WF, marker);
          return runId == null ? r : { ...r, runId };
        }
        const state = await deps.gh.getRunState(E2E_REPO, r.runId);
        if (state === 'running') return r;
        if (deps.qase && r.qaseRunId) await deps.qase.completeRun(r.qaseRunId);
        return { ...r, passed: state === 'success' };
      }));
      if (advanced.some((r) => r.passed === undefined)) {
        return { status: 'e2e_running', spec: { ...job.spec, e2e: { ...e2e, runs: advanced } } };
      }
      if (advanced.some((r) => r.passed === false)) {
        return { status: 'failed', error: 'E2E gate failed — deploy blocked', spec: { ...job.spec, e2e: { ...e2e, runs: advanced, passed: false } } };
      }
      return { status: 'pending', spec: { ...job.spec, e2e: { ...e2e, runs: advanced, passed: true } } };
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
