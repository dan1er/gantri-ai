import { logger } from '../../logger.js';
import type { KlaviyoApiClient } from './client.js';
import type { KlaviyoImportsRepo, KlaviyoImportRow } from '../../storage/repositories/klaviyo-imports.js';
import type { PendingConfirmationsRepo } from '../../storage/repositories/pending-confirmations.js';

export interface CallerLookup {
  resolve(slackUserId: string): Promise<{ slackUserId: string; dmChannelId: string } | null>;
}

export interface KlaviyoImportPollerDeps {
  importsRepo: KlaviyoImportsRepo;
  pendingRepo: PendingConfirmationsRepo;
  client: Pick<KlaviyoApiClient, 'getBulkImportJobStatus'>;
  slack: { postMessage(channel: string, text: string, threadTs?: string): Promise<void> };
  callerLookup: CallerLookup;
  now?: () => Date;
}

const STUCK_TIMEOUT_MS = 30 * 60 * 1000;

export class KlaviyoImportPollerJob {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly deps: KlaviyoImportPollerDeps) {}

  start(intervalMs: number = 60_000) {
    this.tick().catch((e) => logger.error({ err: String(e?.message ?? e) }, 'klaviyo_poller_first_tick_failed'));
    this.timer = setInterval(() => {
      this.tick().catch((e) => logger.error({ err: String(e?.message ?? e) }, 'klaviyo_poller_tick_failed'));
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    await this.deps.pendingRepo.sweepExpired().catch((e) =>
      logger.warn({ err: String(e?.message ?? e) }, 'klaviyo_poller_sweep_failed'),
    );
    const rows = await this.deps.importsRepo.listInFlight(50);
    for (const row of rows) {
      try {
        await this.processRow(row);
      } catch (err) {
        logger.warn({ err: String((err as any)?.message ?? err), auditId: row.id }, 'klaviyo_poller_row_failed');
      }
    }
  }

  private async processRow(row: KlaviyoImportRow) {
    const now = (this.deps.now ?? (() => new Date()))();
    const ageMs = now.getTime() - new Date(row.startedAt).getTime();
    if (ageMs > STUCK_TIMEOUT_MS) {
      await this.deps.importsRepo.updateStatus(row.id, {
        status: 'failed',
        errorSummary: 'timeout (>30 min in processing)',
      });
      await this.dmCaller(
        row,
        `Klaviyo import \`${row.id}\` timed out after 30 minutes. Job id: \`${row.klaviyoJobId}\`. Check Klaviyo's job page or re-run.`,
      );
      logger.warn({ auditId: row.id, jobId: row.klaviyoJobId }, 'klaviyo_import_timeout');
      return;
    }

    const status = await this.deps.client.getBulkImportJobStatus(row.klaviyoJobId);

    if (status.status === 'queued' || status.status === 'processing') {
      if (row.status !== status.status) {
        await this.deps.importsRepo.updateStatus(row.id, { status: status.status });
      }
      return;
    }

    if (status.status === 'complete') {
      await this.deps.importsRepo.updateStatus(row.id, {
        status: 'complete',
        succeededCount: status.completedCount ?? row.totalImported,
        alreadySubscribedCount: 0,
        failedCount: status.failedCount ?? 0,
      });
      const succeeded = status.completedCount ?? row.totalImported;
      const failTail = (status.failedCount ?? 0) > 0 ? `, ${status.failedCount} failed` : '';
      await this.dmCaller(
        row,
        `Done — ${succeeded} profile${succeeded === 1 ? '' : 's'} subscribed${failTail}. Audit \`${row.id}\`.`,
      );
      logger.info({ auditId: row.id, succeeded, failed: status.failedCount ?? 0 }, 'klaviyo_import_complete');
      return;
    }

    if (status.status === 'failed') {
      const summary = (status.errors ?? []).map((e) => e.detail).join('; ').slice(0, 4000) || 'Klaviyo reported failed';
      await this.deps.importsRepo.updateStatus(row.id, { status: 'failed', errorSummary: summary });
      await this.dmCaller(row, `Klaviyo import failed: ${summary}. Audit \`${row.id}\`.`);
      logger.warn({ auditId: row.id, summary }, 'klaviyo_import_failed');
      return;
    }
  }

  private async dmCaller(row: KlaviyoImportRow, text: string) {
    const c = await this.deps.callerLookup.resolve(row.callerSlackId);
    if (!c) {
      logger.warn({ caller: row.callerSlackId, auditId: row.id }, 'klaviyo_poller_dm_lookup_miss');
      return;
    }
    await this.deps.slack.postMessage(c.dmChannelId, text);
  }
}
