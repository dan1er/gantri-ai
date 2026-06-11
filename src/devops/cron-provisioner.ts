import type { Job } from './types.js';
import type { JobPatch, ProvisionerDeps } from './provisioner.js';

const PORTER = 'porter';
const CRON_WF = 'run-cron.yml';

/**
 * Drives an on-demand porter CronJob run (kind = 'cron', the /cron Slack
 * command): dispatch porter's run-cron.yml with the chosen environment +
 * cronjob, find the run by the job-id marker, poll it, and report. The
 * workflow itself creates a k8s Job from the CronJob, waits for it, and tails
 * its logs into the run summary — Slack links there instead of mirroring logs.
 */
export async function advanceCronJob(job: Job, deps: ProvisionerDeps): Promise<JobPatch> {
  const run = job.spec.cronRun;
  if (!run) return { status: 'failed', error: 'cron job has no run spec' };

  if (job.status === 'pending') {
    await deps.gh.dispatch(PORTER, CRON_WF, 'master', {
      environment: run.environment,
      cronjob: run.cronjob,
      job_id: job.id,
    });
    return { status: 'backend_running' };
  }

  if (job.status === 'backend_running' && job.runId == null) {
    const runId = await deps.gh.findRunByMarker(PORTER, CRON_WF, job.id);
    return runId == null ? {} : { runId };
  }

  if (job.status === 'backend_running' && job.runId != null) {
    const state = await deps.gh.getRunState(PORTER, job.runId);
    if (state === 'running') return {};
    return state === 'success'
      ? { status: 'ready' }
      : { status: 'failed', error: 'cron run failed — see the workflow run logs' };
  }

  return {};
}
