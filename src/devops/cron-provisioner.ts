import type { Job, JobSpec } from './types.js';
import type { JobPatch, ProvisionerDeps } from './provisioner.js';

const PORTER = 'porter';
const CRON_WF = 'run-cron.yml';
const LOGS_START = '===CRON-LOGS-START===';
const LOGS_END = '===CRON-LOGS-END===';

/**
 * Pull the cron pod's output out of the Actions job log: take the section the
 * workflow brackets with CRON-LOGS markers (fall back to the whole log when a
 * run predates the markers), strip the per-line timestamps Actions prepends,
 * and keep a Slack-sized tail.
 */
export function extractCronLogs(raw: string): string {
  let lines = raw.split('\n');
  const start = lines.findIndex((l) => l.includes(LOGS_START));
  const end = lines.findIndex((l) => l.includes(LOGS_END));
  if (start !== -1 && end > start) lines = lines.slice(start + 1, end);
  const cleaned = lines
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ''))
    .filter((l) => l.trim().length > 0);
  const tail = cleaned.slice(-40).join('\n');
  return tail.length > 2700 ? `…${tail.slice(-2700)}` : tail;
}

/**
 * Drives an on-demand porter CronJob run (kind = 'cron', the /cron Slack
 * command): dispatch porter's run-cron.yml with the chosen environment +
 * cronjob, find the run by the job-id marker, poll it, and report. The
 * workflow itself creates a k8s Job from the CronJob, waits for it, and tails
 * its logs into the run summary.
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
    // Thread the pod logs alongside the verdict (best-effort — the run links
    // to the full log either way).
    let logsTail: string | undefined;
    try {
      logsTail = extractCronLogs(await deps.gh.runJobLogs(PORTER, job.runId));
    } catch {
      logsTail = undefined;
    }
    const spec: JobSpec = { ...job.spec, cronRun: { ...run, ...(logsTail ? { logsTail } : {}) } };
    return state === 'success'
      ? { status: 'ready', spec }
      : { status: 'failed', error: 'cron run failed — see the threaded logs', spec };
  }

  return {};
}
