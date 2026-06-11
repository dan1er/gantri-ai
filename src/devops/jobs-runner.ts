import type { WebClient } from '@slack/web-api';
import type { Job } from './types.js';
import type { DevopsJobsRepo } from './jobs-repo.js';
import type { JobPatch, ProvisionerDeps } from './provisioner.js';
import { renderJobBlocks, e2eLocalConfig, idlePingBlocks } from './messages.js';
import { logger } from '../logger.js';

// Backend previews run in the cluster, so a ready one that's been forgotten
// costs money. Once it's been up this long (and every interval after) the bot
// pings the requester in the thread to tear it down or keep it.
const IDLE_PING_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

type Advance = (job: Job, deps: ProvisionerDeps) => Promise<JobPatch>;

// Short progress line posted to the message thread on each status change.
function statusNote(job: Job): string | null {
  if (job.kind === 'cron') {
    switch (job.status) {
      case 'backend_running': return '⏱️ Cron dispatched — running…';
      case 'ready': return '✅ Cron run completed';
      case 'failed': return `✗ Cron run failed${job.error ? ` — ${job.error}` : ''}`;
      default: return null;
    }
  }
  if (job.kind === 'e2e') {
    switch (job.status) {
      case 'e2e_running': return '🧪 Suite dispatched — running…';
      case 'ready': return '✅ E2E run passed';
      case 'failed': return `✗ E2E run failed${job.error ? ` — ${job.error}` : ''}`;
      default: return null;
    }
  }
  switch (job.status) {
    case 'backend_running': return job.kind === 'deploy' ? '🚀 Deploying backend…' : '🛠️ Provisioning backend…';
    case 'frontend_running':
      return job.kind === 'deploy'
        ? (job.spec.e2e ? '🧪 Testing + deploying frontends…' : '🚀 Deploying frontends…')
        : '🌐 Building frontend(s)…';
    case 'ready': {
      if (job.kind !== 'deploy') return '✅ Preview ready';
      const prev = job.spec.deployBackend?.prevDeployTag;
      // Surface the prior deploy so a manual rollback is possible if the
      // *Rollback backend* button ever fails.
      return prev
        ? `✅ Deployed to production\n↩️ Previous deploy: \`${prev}\` — if the *Rollback backend* button fails, roll back manually with \`/deploy ${prev}\` (or dispatch prod-deploy with that tag).`
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
      // Idle reminders poll ready previews separately: 'ready' is a terminal
      // status, so listActive never returns them — but a ready backend preview
      // is still a live (billable) environment until torn down.
      const readyPreviews = await this.deps.repo.listReadyPreviews(25);
      for (const job of readyPreviews) {
        await this.maybePingIdle(job).catch((err) =>
          logger.warn({ jobId: job.id, err: String((err as Error)?.message ?? err) }, 'devops idle ping failed'),
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
        // When a preview with a backend goes ready, thread the ready-to-run
        // gantri-e2e config (env + tunnel command) for that specific preview.
        const e2eCfg = e2eLocalConfig(updated);
        if (e2eCfg) {
          await this.deps.slack.chat
            .postMessage({ channel: job.channelId, thread_ts: job.messageTs, text: e2eCfg, unfurl_links: false, unfurl_media: false })
            .catch((err) => logger.warn({ jobId: job.id, err: String((err as Error)?.message ?? err) }, 'devops e2e config note failed'));
        }
      }
    }
  }

  // Hourly reminder for a ready backend preview: ping the requester with a
  // top-level channel message (visible without opening the thread) to tear it
  // down (it's running in the cluster) or snooze.
  private async maybePingIdle(job: Job): Promise<void> {
    if (job.kind !== 'preview' || job.status !== 'ready' || !job.spec.backend) return;
    const now = Date.now();
    const since = new Date(job.idlePingedAt ?? job.createdAt).getTime();
    if (!Number.isFinite(since) || now - since < IDLE_PING_INTERVAL_MS) return;

    const { text, blocks } = idlePingBlocks(job, humanAge(now - new Date(job.createdAt).getTime()));
    await this.deps.slack.chat.postMessage({
      channel: job.channelId, text,
      blocks: blocks as any, unfurl_links: false, unfurl_media: false,
    });
    await this.deps.repo.update(job.id, { idlePingedAt: new Date(now).toISOString() });
    logger.info({ jobId: job.id, by: job.requestedBy }, 'devops idle preview ping sent');
  }
}

function humanAge(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return 'about an hour';
  if (h < 24) return h === 1 ? '1 hour' : `${h} hours`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day' : `${d} days`;
}

