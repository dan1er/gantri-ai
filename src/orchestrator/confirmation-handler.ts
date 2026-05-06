import { logger } from '../logger.js';
import type { KlaviyoApiClient } from '../connectors/klaviyo/client.js';
import type { KlaviyoImportsRepo } from '../storage/repositories/klaviyo-imports.js';
import type { KlaviyoDeletionsRepo } from '../storage/repositories/klaviyo-deletions.js';
import type { PendingConfirmationsRepo, PendingConfirmationRow } from '../storage/repositories/pending-confirmations.js';

export interface ConfirmationHandlerDeps {
  pendingRepo: PendingConfirmationsRepo;
  importsRepo: KlaviyoImportsRepo;
  deletionsRepo: KlaviyoDeletionsRepo;
  client: Pick<KlaviyoApiClient, 'bulkSubscribeProfiles' | 'requestProfileDeletion'>;
  slack: { postMessage(channel: string, text: string, threadTs?: string): Promise<void> };
  sleep?: (ms: number) => Promise<void>;
}

export interface IncomingMessage {
  slackUserId: string;
  channelId: string;
  threadTs: string;
  text: string;
}

const DELETE_RATE_DELAY_MS = 500; // <=2/s under Klaviyo's 3/s burst

function decisionOf(text: string): 'yes' | 'cancel' | null {
  const t = text.trim().toLowerCase();
  if (t === 'yes' || t === 'y') return 'yes';
  if (t === 'cancel' || t === 'no' || t === 'n') return 'cancel';
  return null;
}

/** Slack rejects thread_ts that isn't a real message timestamp (it expects
 *  something like "1761234567.000100"). When we use the channel id as a
 *  pending-lookup key for DM-flat conversations, we must NOT pass it back as
 *  a thread_ts on chat.postMessage — that returns invalid_thread_ts and
 *  silently breaks the bot's reply. This filter keeps real ts strings and
 *  drops anything else. */
function safeThreadTs(threadTs: string | undefined): string | undefined {
  if (!threadTs) return undefined;
  return /^\d+\.\d+$/.test(threadTs) ? threadTs : undefined;
}

export class ConfirmationHandler {
  constructor(private readonly deps: ConfirmationHandlerDeps) {}

  /** Returns true if this message was consumed by the handler (do not pass to LLM). */
  async tryHandle(msg: IncomingMessage): Promise<boolean> {
    // Look up any pending row first so we can dispatch by kind.
    const pending = await this.deps.pendingRepo.lookupByThread(msg.slackUserId, msg.channelId, msg.threadTs);
    if (!pending) return false;
    if (pending.callerSlackId !== msg.slackUserId) {
      logger.warn(
        { pendingId: pending.id, expected: pending.callerSlackId, actual: msg.slackUserId },
        'klaviyo_confirmation_caller_mismatch',
      );
      return false;
    }

    if (pending.kind === 'klaviyo_csv_pending') {
      const text = msg.text.trim();
      if (/^(cancel|cancelar|abort)$/i.test(text)) {
        await this.deps.pendingRepo.deleteById(pending.id);
        await this.deps.slack.postMessage(msg.channelId, 'Cancelled. CSV import not submitted.', safeThreadTs(msg.threadTs));
        logger.info({ pendingId: pending.id, caller: pending.callerSlackId }, 'klaviyo_csv_cancelled');
        return true;
      }
      // Anything other than cancel: let the orchestrator interpret the reply
      // with pending CSV state injected as a system note. The slack handler
      // re-fetches the pending row and builds OrchestratorPendingCsvContext.
      logger.info({ pendingId: pending.id, caller: pending.callerSlackId }, 'klaviyo_csv_routed_to_orchestrator');
      return false;
    }

    // klaviyo_import / klaviyo_delete: yes/cancel only.
    const decision = decisionOf(msg.text);
    if (!decision) return false;

    if (decision === 'cancel') {
      await this.deps.pendingRepo.deleteById(pending.id);
      await this.deps.slack.postMessage(msg.channelId, 'Cancelled. No Klaviyo write happened.', safeThreadTs(msg.threadTs));
      logger.info(
        { pendingId: pending.id, kind: pending.kind, caller: pending.callerSlackId },
        'klaviyo_confirmation_cancelled',
      );
      return true;
    }

    try {
      if (pending.kind === 'klaviyo_import') await this.executeImport(pending, msg);
      else if (pending.kind === 'klaviyo_delete') await this.executeDelete(pending, msg);
    } catch (err: any) {
      logger.error({ pendingId: pending.id, err: String(err?.message ?? err) }, 'klaviyo_confirmation_exec_failed');
      await this.deps.slack.postMessage(
        msg.channelId,
        `Sorry — something failed while running the confirmation. (${String(err?.message ?? err)})`,
        safeThreadTs(msg.threadTs),
      );
    } finally {
      await this.deps.pendingRepo.deleteById(pending.id).catch(() => {});
    }
    return true;
  }

  private async executeImport(pending: PendingConfirmationRow, msg: IncomingMessage) {
    const p = pending.payload as any;
    const consentedAt = new Date().toISOString();
    const result = await this.deps.client.bulkSubscribeProfiles({
      profiles: p.valid.map((v: any) => ({
        email: v.email,
        phone_number: v.phone_e164,
        first_name: v.first_name,
        last_name: v.last_name,
        custom_source: v.consent_source ?? p.defaultConsentSource ?? `Slack import — ${p.listName ?? 'no list'} (${consentedAt.slice(0, 10)})`,
        consented_at: v.consented_at ?? consentedAt,
      })),
      listId: p.listId ?? undefined,
      channels: p.channels,
    });
    // Klaviyo's bulk-subscribe returns 202 with no body, so there's no
    // real job to poll. The DB CHECK constraint forbids inserting with
    // status='complete' AND completed_at=null in a single statement, so we
    // insert as 'queued' first then updateStatus to 'complete' which sets
    // completed_at automatically.
    const isLocalJob = result.job_id.startsWith('local-');
    const audit = await this.deps.importsRepo.insert({
      callerSlackId: pending.callerSlackId, callerEmail: null,
      source: p.source, filename: p.filename, storagePath: p.storagePath,
      listId: p.listId, listName: p.listName, channels: p.channels,
      totalSubmitted: p.totalSubmitted, totalImported: p.valid.length, totalInvalidRejected: p.totalInvalidRejected,
      klaviyoJobId: result.job_id, status: 'queued',
    });
    if (isLocalJob) {
      await this.deps.importsRepo.updateStatus(audit.id, {
        status: 'complete', succeededCount: p.valid.length, alreadySubscribedCount: 0, failedCount: 0,
      });
    }
    await this.deps.slack.postMessage(
      msg.channelId,
      isLocalJob
        ? `Submitted ${p.valid.length} profile${p.valid.length === 1 ? '' : 's'} to Klaviyo (audit \`${audit.id}\`). Klaviyo accepted — profiles typically appear within ~1 minute.`
        : `Queued ${p.valid.length} profile${p.valid.length === 1 ? '' : 's'} (audit \`${audit.id}\`, job \`${result.job_id}\`). I'll DM when it's done.`,
      safeThreadTs(msg.threadTs),
    );
    logger.info(
      { auditId: audit.id, jobId: result.job_id, valid: p.valid.length, rejected: p.totalInvalidRejected, immediateComplete: isLocalJob },
      'klaviyo_import_submitted',
    );
  }

  private async executeDelete(pending: PendingConfirmationRow, msg: IncomingMessage) {
    const p = pending.payload as any;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const failedDetails: Array<{ email: string; profile_id?: string; status?: number; error?: string }> = [];
    let deletedCount = 0;

    for (let i = 0; i < p.found.length; i++) {
      const item = p.found[i];
      try {
        await this.deps.client.requestProfileDeletion({ email: item.email });
        deletedCount += 1;
      } catch (err: any) {
        const status = err?.status as number | undefined;
        if (status === 429) {
          await sleep(5000);
          try {
            await this.deps.client.requestProfileDeletion({ email: item.email });
            deletedCount += 1;
            if (i < p.found.length - 1) await sleep(DELETE_RATE_DELAY_MS);
            continue;
          } catch (err2: any) {
            failedDetails.push({
              email: item.email, profile_id: item.profile_id,
              status: err2?.status, error: String(err2?.message ?? err2),
            });
          }
        } else {
          failedDetails.push({
            email: item.email, profile_id: item.profile_id,
            status, error: String(err?.message ?? err),
          });
        }
      }
      if (i < p.found.length - 1) await sleep(DELETE_RATE_DELAY_MS);
    }

    const audit = await this.deps.deletionsRepo.insert({
      callerSlackId: pending.callerSlackId, callerEmail: null,
      requestedEmails: p.requested,
      foundCount: p.found.length,
      deletedCount,
      failedCount: failedDetails.length,
      failedDetails,
    });
    const failTail = failedDetails.length === 0 ? '' : `\nFailed (${failedDetails.length}): ${failedDetails.map((f) => f.email).join(', ')}`;
    await this.deps.slack.postMessage(
      msg.channelId,
      `Submitted ${deletedCount} of ${p.found.length} profile${p.found.length === 1 ? '' : 's'} for deletion (audit \`${audit.id}\`). They'll appear on Klaviyo's "Deleted Profiles" page within ~5 min.${failTail}`,
      safeThreadTs(msg.threadTs),
    );
    logger.info(
      { auditId: audit.id, requested: p.requested.length, found: p.found.length, deleted: deletedCount, failed: failedDetails.length },
      'klaviyo_delete_submitted',
    );
  }
}
