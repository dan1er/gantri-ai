import type { WebClient } from '@slack/web-api';
import type { Job } from './types.js';
import type { DevopsJobsRepo } from './jobs-repo.js';
import type { JobPatch, ProvisionerDeps } from './provisioner.js';
import { renderJobBlocks } from './messages.js';
import { logger } from '../logger.js';

type Advance = (job: Job, deps: ProvisionerDeps) => Promise<JobPatch>;

// Short progress line posted to the message thread on each status change.
function statusNote(job: Job): string | null {
  switch (job.status) {
    case 'e2e_running': return '🧪 Running E2E gate…';
    case 'pending': return job.spec.e2e?.passed ? '✅ E2E passed — starting deploy' : null;
    case 'backend_running': return job.kind === 'deploy' ? '🚀 Deploying backend…' : '🛠️ Provisioning backend…';
    case 'frontend_running': return job.kind === 'deploy' ? '🚀 Deploying frontend(s)…' : '🌐 Building frontend(s)…';
    case 'ready': return job.kind === 'deploy' ? '✅ Deployed to production' : '✅ Preview ready';
    case 'failed': return `✗ Failed${job.error ? `: ${job.error}` : ''}`;
    case 'torn_down': return '🧹 Torn down';
    default: return null;
  }
}

export interface JobsRunnerDeps extends ProvisionerDeps {
  repo: DevopsJobsRepo;
  slack: WebClient;
  advance: Advance;
  tickIntervalMs?: number;
}

export class JobsRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(private readonly deps: JobsRunnerDeps) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.tickIntervalMs ?? 8000;
    this.timer = setInterval(() => { void this.tick(); }, interval);
    logger.info({ intervalMs: interval }, 'devops jobs runner started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const jobs = await this.deps.repo.listActive(25);
      for (const job of jobs) {
        await this.advanceOne(job).catch((err) =>
          logger.warn({ jobId: job.id, err: String((err as Error)?.message ?? err) }, 'devops job advance failed'),
        );
      }
    } catch (err) {
      logger.error({ err: String((err as Error)?.message ?? err) }, 'devops jobs tick failed');
    } finally {
      this.running = false;
    }
  }

  private async advanceOne(job: Job): Promise<void> {
    let patch: JobPatch;
    try {
      patch = await this.deps.advance(job, { gh: this.deps.gh, vercel: this.deps.vercel });
    } catch (err) {
      patch = { status: 'failed', error: String((err as Error)?.message ?? err).slice(0, 300) };
    }
    if (Object.keys(patch).length === 0) return;
    await this.deps.repo.update(job.id, patch);
    const updated: Job = { ...job, ...patch, spec: patch.spec ?? job.spec };
    if (job.messageTs) {
      await this.deps.slack.chat.update({
        channel: job.channelId, ts: job.messageTs,
        text: `${updated.kind} ${updated.status}`, blocks: renderJobBlocks(updated) as any,
      }).catch((err) => logger.warn({ jobId: job.id, err: String((err as Error)?.message ?? err) }, 'devops chat.update failed'));
      if (patch.status && patch.status !== job.status) {
        const note = statusNote(updated);
        if (note) {
          await this.deps.slack.chat
            .postMessage({ channel: job.channelId, thread_ts: job.messageTs, text: note })
            .catch((err) => logger.warn({ jobId: job.id, err: String((err as Error)?.message ?? err) }, 'devops thread note failed'));
        }
      }
    }
  }
}

