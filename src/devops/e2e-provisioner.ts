import type { Job, JobSpec } from './types.js';
import type { JobPatch, ProvisionerDeps } from './provisioner.js';

const E2E_REPO = 'gantri-e2e';
const E2E_WF = 'qase-trigger.yml';

/**
 * Drives an on-demand suite run (kind = 'e2e', the /e2e Slack command):
 * create a Qase run up-front (so its URL is linkable immediately), dispatch
 * gantri-e2e's qase-trigger.yml with the chosen options, find the run by the
 * job-id marker, poll it, and complete the Qase run when it settles. Same
 * choreography as the pre-deploy E2E gate, minus the deploy.
 */
export async function advanceE2eJob(job: Job, deps: ProvisionerDeps): Promise<JobPatch> {
  const run = job.spec.e2eRun;
  if (!run) return { status: 'failed', error: 'e2e job has no run spec' };

  if (job.status === 'pending') {
    const label = `Slack /e2e · ${run.project} · ${run.scope}${run.area ? ` · ${run.area}` : ''}`;
    const qaseRunId = deps.qase ? await deps.qase.createRun(label) : null;
    const inputs: Record<string, string> = {
      marker: job.id,
      project: run.project,
      scope: run.scope,
      include_long_running: run.includeLongRunning ? 'true' : 'false',
      area: run.area ?? '(all areas)',
    };
    if (run.grepOverride) inputs.grep_override = run.grepOverride;
    if (qaseRunId) inputs.qase_run_id = String(qaseRunId);
    await deps.gh.dispatch(E2E_REPO, E2E_WF, 'main', inputs);
    const spec: JobSpec = { ...job.spec, e2eRun: { ...run, qaseRunId } };
    return { status: 'e2e_running', spec };
  }

  if (job.status === 'e2e_running' && job.runId == null) {
    const runId = await deps.gh.findRunByMarker(E2E_REPO, E2E_WF, job.id);
    return runId == null ? {} : { runId };
  }

  if (job.status === 'e2e_running' && job.runId != null) {
    const state = await deps.gh.getRunState(E2E_REPO, job.runId);
    if (state === 'running') return {};
    // The bot created the Qase run, so the bot closes it — qase-trigger only
    // appends results to runs it didn't create.
    if (deps.qase && run.qaseRunId) await deps.qase.completeRun(run.qaseRunId);
    return state === 'success'
      ? { status: 'ready' }
      : { status: 'failed', error: 'some tests failed — check the Qase run' };
  }

  return {};
}
