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
    case 'backend_running': return job.kind === 'deploy' ? '🚀 Deploying backend…' : '🛠️ Provisioning backend…';
    case 'frontend_running':
      return job.kind === 'deploy'
        ? (job.spec.e2e ? '🧪 Testing + deploying frontends…' : '🚀 Deploying frontends…')
        : '🌐 Building frontend(s)…';
    case 'ready': {
      if (job.kind !== 'deploy') return '✅ Preview ready';
      const prev = job.spec.deployBackend?.prevRelease;
      // Surface the prior release so a manual rollback is possible if the
      // Rollback button ever fails (Actions → Rollback Production).
      return prev
        ? `✅ Deployed to production\n↩️ Previous release: \`${prev}\` — if the *Rollback backend* button fails, run *Rollback Production* manually with release_tag \`${prev}\`, confirm \`rollback\`.`
        : '✅ Deployed to production';
    }
    case 'failed':
      return job.kind === 'deploy' ? '✗ Some frontends did not deploy — see message above' : `✗ Failed${job.error ? `: ${job.error}` : ''}`;
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
      patch = await this.deps.advance(job, { gh: this.deps.gh, vercel: this.deps.vercel, qase: this.deps.qase });
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
        unfurl_links: false, unfurl_media: false,
      } as any).catch((err) => logger.warn({ jobId: job.id, err: String((err as Error)?.message ?? err) }, 'devops chat.update failed'));
      if (patch.status && patch.status !== job.status) {
        const note = statusNote(updated);
        if (note) {
          await this.deps.slack.chat
            .postMessage({ channel: job.channelId, thread_ts: job.messageTs, text: note, unfurl_links: false, unfurl_media: false })
            .catch((err) => logger.warn({ jobId: job.id, err: String((err as Error)?.message ?? err) }, 'devops thread note failed'));
        }
      }
    }
  }
}

