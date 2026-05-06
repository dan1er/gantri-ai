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
  /** Optional tool dispatcher used to run klaviyo.commit_pending_csv_import.
   *  When omitted (or in tests), CSV-pending dispatch is skipped. */
  runTool?: (
    name: string,
    args: unknown,
    actor: { slackUserId: string; channelId: string; threadTs?: string },
  ) => Promise<unknown>;
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

    // CSV-list-pending uses ANY non-empty text as the list selection (deterministic
    // — we don't want the LLM to misinterpret "prueba nueva" as a help request).
    // Special cases:
    //   - cancel / abort → delete pending, abort
    //   - awaiting-create state + "yes" / "si" → create the previously-named
    //     list AND finalize the import in one step
    //   - awaiting-create state + anything else → clear that state and treat
    //     the new text as a fresh list-name attempt
    if (pending.kind === 'klaviyo_csv_pending') {
      const text = msg.text.trim();
      const payload = pending.payload as { awaitingCreateForName?: string | null } & Record<string, unknown>;
      const awaitingName = payload.awaitingCreateForName ?? null;

      const isCancel = /^(cancel|cancelar|abort)$/i.test(text);
      if (isCancel) {
        await this.deps.pendingRepo.deleteById(pending.id);
        await this.deps.slack.postMessage(msg.channelId, 'Cancelled. CSV import not submitted.', safeThreadTs(msg.threadTs));
        logger.info({ pendingId: pending.id, caller: pending.callerSlackId }, 'klaviyo_csv_cancelled');
        return true;
      }
      if (!text) return false;

      const isYes = /^(yes|y|si|sí|yes,?\s*create\s*it|create\s*it|dale|ok)$/i.test(text);
      const isNo = /^(no|nope|nada)$/i.test(text);

      try {
        if (awaitingName && isYes) {
          // User confirmed creation of the previously-named list.
          await this.executeCreateAndImport(pending, msg, awaitingName);
          return true;
        }
        if (awaitingName && isNo) {
          // User declined creating that list. Clear the awaiting state and
          // ask them for a new list name without aborting the import.
          await this.deps.pendingRepo.updatePayload(pending.id, { awaitingCreateForName: null }).catch(() => {});
          await this.deps.slack.postMessage(
            msg.channelId,
            `Ok, won't create it. Reply with a different list name (or "cancel" to abort the import).`,
            safeThreadTs(msg.threadTs),
          );
          return true;
        }
        // If we're awaiting and the user typed something other than yes/no,
        // assume they're picking a new list name — clear the awaiting state
        // and treat the text as a fresh attempt.
        if (awaitingName) {
          await this.deps.pendingRepo.updatePayload(pending.id, { awaitingCreateForName: null }).catch(() => {});
        }
        await this.executeCsvImport(pending, msg, text);
      } catch (err: any) {
        logger.error({ pendingId: pending.id, err: String(err?.message ?? err) }, 'klaviyo_csv_exec_failed');
        await this.deps.slack.postMessage(
          msg.channelId,
          `Couldn't run the CSV import: ${String(err?.message ?? err)}`,
          safeThreadTs(msg.threadTs),
        );
      }
      return true;
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

  /** Two-step "create the list the user named, then import" used when the
   *  prior CSV-pending response was "no list called X — want me to create it?"
   *  and the user replied "yes". Calls klaviyo.create_list, then runs the
   *  ordinary CSV commit with the freshly-created list's name. Clears the
   *  awaiting-create state regardless of outcome. */
  private async executeCreateAndImport(pending: PendingConfirmationRow, msg: IncomingMessage, listName: string) {
    if (!this.deps.runTool) {
      await this.deps.slack.postMessage(msg.channelId, 'Internal: CSV commit handler is not wired up.', safeThreadTs(msg.threadTs));
      return;
    }
    // Clear the awaiting state up front so a re-entry doesn't loop.
    await this.deps.pendingRepo.updatePayload(pending.id, { awaitingCreateForName: null }).catch(() => {});

    const createResult: any = await this.deps.runTool(
      'klaviyo.create_list',
      { name: listName },
      { slackUserId: pending.callerSlackId, channelId: pending.channelId, threadTs: pending.threadTs },
    );
    if (createResult?.error) {
      await this.deps.slack.postMessage(
        msg.channelId,
        `Couldn't create the list "${listName}": ${createResult.error.message}`,
        safeThreadTs(msg.threadTs),
      );
      return;
    }
    if (!createResult?.ok) {
      await this.deps.slack.postMessage(msg.channelId, `Couldn't create the list "${listName}".`, safeThreadTs(msg.threadTs));
      return;
    }
    logger.info({ pendingId: pending.id, listId: createResult.id, listName }, 'klaviyo_csv_list_created_for_pending');
    await this.deps.slack.postMessage(msg.channelId, `Created list *${createResult.name}*. Importing now...`, safeThreadTs(msg.threadTs));
    // Now run the ordinary commit with the new list.
    await this.executeCsvImport(pending, msg, createResult.name);
  }

  private async executeCsvImport(pending: PendingConfirmationRow, msg: IncomingMessage, listInput: string) {
    if (!this.deps.runTool) {
      await this.deps.slack.postMessage(msg.channelId, 'Internal: CSV commit handler is not wired up.', safeThreadTs(msg.threadTs));
      return;
    }
    const result: any = await this.deps.runTool(
      'klaviyo.commit_pending_csv_import',
      { list: listInput },
      { slackUserId: pending.callerSlackId, channelId: pending.channelId, threadTs: pending.threadTs },
    );

    if (result?.error?.code === 'LIST_NOT_FOUND') {
      const sugg = result.error.details?.suggestions ?? [];
      const lines: string[] = [];
      if (sugg.length === 0) {
        // No similar lists. Offer to create a new one with the user's input.
        // Stash the candidate name in the pending row so a follow-up "yes"
        // creates THIS list (instead of a list literally named "yes").
        await this.deps.pendingRepo.updatePayload(pending.id, { awaitingCreateForName: listInput }).catch(() => {});
        lines.push(`There's no list called *${listInput}*. Want me to create it? Reply *yes* (creates "${listInput}") or pick a different list name.`);
      } else if (sugg.length === 1) {
        lines.push(`Did you mean *${sugg[0].name}*? Reply with the exact name or "no" to pick something else.`);
      } else {
        lines.push(
          `I see a few lists that could match: ${sugg.map((s: any) => `*${s.name}*`).join(', ')} — which one? Reply with the exact name.`,
        );
      }
      await this.deps.slack.postMessage(msg.channelId, lines.join('\n'), safeThreadTs(msg.threadTs));
      return;
    }
    if (result?.error) {
      await this.deps.slack.postMessage(msg.channelId, `Couldn't import: ${result.error.message}`, safeThreadTs(msg.threadTs));
      return;
    }
    if (result?.kind === 'imported_directly') {
      await this.deps.slack.postMessage(
        msg.channelId,
        `Submitted ${result.total_imported} profile${result.total_imported === 1 ? '' : 's'} to Klaviyo${result.list ? ` (list: ${result.list.name})` : ''}. They typically appear within ~1 minute.`,
        safeThreadTs(msg.threadTs),
      );
      return;
    }
    if (result?.kind === 'awaiting_confirmation') {
      await this.deps.slack.postMessage(msg.channelId, result.message, safeThreadTs(msg.threadTs));
      return;
    }
    if (result?.kind === 'all_invalid') {
      await this.deps.slack.postMessage(msg.channelId, `All ${result.invalid_count} rows failed validation.`, safeThreadTs(msg.threadTs));
      return;
    }
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
