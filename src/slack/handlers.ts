import type { AuthorizedUsersRepo } from '../storage/repositories/authorized-users.js';
import type { ConversationsRepo } from '../storage/repositories/conversations.js';
import type { Orchestrator, OrchestratorPendingCsvContext } from '../orchestrator/orchestrator.js';
import type { ConfirmationHandler } from '../orchestrator/confirmation-handler.js';
import type { ReportAttachment } from '../connectors/reports/reports-connector.js';
import type { PendingConfirmationsRepo } from '../storage/repositories/pending-confirmations.js';
import type { KlaviyoApiClient } from '../connectors/klaviyo/client.js';
import { markdownToSlackBlocks } from '../orchestrator/formatter.js';
import { logger } from '../logger.js';
import { loadEnv } from '../config/env.js';
import { parseRawCsv } from '../connectors/klaviyo/csv-parser.js';
import { validateAndMapForKlaviyo, type HeaderMapperDeps } from '../connectors/klaviyo/header-mapper.js';

/**
 * Upload a text file to a Slack channel using the external-upload API (three
 * steps: getUploadURLExternal → POST binary → completeUploadExternal). This is
 * the Slack-recommended flow for 2026+; the SDK's `files.uploadV2` helper has
 * been observed to silently fail in some environments, so we drive the raw
 * endpoints ourselves.
 */
async function uploadSlackFile(params: {
  token: string;
  channel: string;
  threadTs: string | undefined;
  filename: string;
  content: string;
  title?: string;
}): Promise<void> {
  const contentBytes = Buffer.byteLength(params.content, 'utf8');

  // Step 1: get signed upload URL + file ID.
  const step1 = await fetch(
    `https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(
      params.filename,
    )}&length=${contentBytes}`,
    { headers: { authorization: `Bearer ${params.token}` } },
  ).then((r) => r.json() as Promise<{ ok: boolean; upload_url?: string; file_id?: string; error?: string }>);
  if (!step1.ok || !step1.upload_url || !step1.file_id) {
    throw new Error(`getUploadURLExternal failed: ${step1.error ?? 'unknown'}`);
  }

  // Step 2: upload the raw bytes to the signed URL.
  const step2 = await fetch(step1.upload_url, {
    method: 'POST',
    body: params.content,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
  if (!step2.ok) {
    throw new Error(`upload POST returned HTTP ${step2.status}: ${await step2.text().catch(() => '')}`);
  }

  // Step 3: complete and share into the channel/thread.
  const step3 = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      files: [{ id: step1.file_id, title: params.title ?? params.filename }],
      channel_id: params.channel,
      thread_ts: params.threadTs,
    }),
  }).then((r) => r.json() as Promise<{ ok: boolean; error?: string }>);
  if (!step3.ok) {
    throw new Error(`completeUploadExternal failed: ${step3.error ?? 'unknown'}`);
  }
}

export interface HandlerDeps {
  orchestrator: Orchestrator;
  usersRepo: AuthorizedUsersRepo;
  conversationsRepo: ConversationsRepo;
  /** Intercepts "yes"/"cancel" replies for pending Klaviyo write confirmations
   *  BEFORE the LLM dispatch — a literal "yes" must execute the queued
   *  import/delete instead of being interpreted as a fresh request. */
  confirmationHandler: ConfirmationHandler;
  /** Used to detect klaviyo_csv_pending rows after `confirmationHandler.tryHandle`
   *  returned false, so we can build OrchestratorPendingCsvContext for the LLM. */
  pendingRepo: Pick<PendingConfirmationsRepo, 'lookupByThread'>;
  /** Used to fetch the Klaviyo list directory once when assembling
   *  pendingContext. Optional: if the call fails, the handler proceeds with
   *  availableLists=[] and lets the LLM call klaviyo.list_lists itself. */
  klaviyoClient: Pick<KlaviyoApiClient, 'listLists'>;
}

/**
 * Display labels for each connector namespace. The orchestrator's tool names
 * follow `{connector}.{tool}` (e.g. `gantri.orders_query`); we collect the
 * connector prefixes that appeared in the run's tool calls and show those as
 * the source list. Unknown prefixes are passed through capitalized as-is.
 */
const SOURCE_LABELS: Record<string, string> = {
  northbeam: 'Northbeam',
  // User-facing label: Porter is internal; surface as Grafana so non-technical
  // readers see a recognizable name. Order-data tools (`gantri.*`, `late_orders.*`)
  // also pull from / reconcile against Grafana panels.
  gantri: 'Grafana',
  grafana: 'Grafana',
  reports: 'Reports',
  late_orders: 'Grafana',
  feedback: 'Feedback',
};

function buildFooter(out: {
  model: string;
  iterations: number;
  toolCalls: Array<{ name: string }>;
}): string {
  const sources = new Set<string>();
  for (const call of out.toolCalls) {
    const prefix = call.name.split('.')[0];
    if (!prefix) continue;
    sources.add(SOURCE_LABELS[prefix] ?? prefix.charAt(0).toUpperCase() + prefix.slice(1));
  }
  const sourceLabel = sources.size > 0 ? `Source: ${[...sources].join(', ')} • ` : '';
  return `${sourceLabel}Model: ${out.model} • ${out.iterations} iteration${out.iterations === 1 ? '' : 's'}`;
}

export function createDmHandler(deps: HandlerDeps) {
  const env = loadEnv();
  return async ({ event, client }: any) => {
    if (event.channel_type !== 'im') return;
    if (event.bot_id) return;
    if (event.subtype) return;
    if (!event.text || !event.user) return;

    // Slack DMs use event.ts as the thread root for the bot's replies (so the
    // bot's progress messages and any attachments thread under the user's
    // original message). Used for the bot's outbound `chat.postMessage`s.
    const threadTs = event.thread_ts ?? event.ts;

    // For pending-confirmation lookups, use channel_id as the key when the
    // user's message is at the DM top level (no thread_ts). The file_shared
    // handler stashes pending rows keyed by channel_id, so this is the only
    // way the user's text reply can locate them.
    const pendingThreadKey = event.thread_ts ?? event.channel;

    // Confirmation flow: if this is a "yes"/"cancel"/list-name reply that
    // matches a pending row, the handler runs the queued import/delete/csv
    // and consumes the message — so the LLM doesn't try to interpret a
    // literal list name as a fresh request. Returns true when consumed.
    const consumed = await deps.confirmationHandler.tryHandle({
      slackUserId: event.user,
      channelId: event.channel,
      threadTs: pendingThreadKey,
      text: event.text,
    });
    if (consumed) return;

    // Pending CSV context: when a klaviyo_csv_pending row is alive in this
    // thread for this caller, build a non-cached system note for the LLM with
    // the row count + Klaviyo list directory so the user's reply (e.g. a list
    // name) is interpreted as a list selection instead of a fresh request.
    // The Klaviyo `listLists()` call is best-effort — failures degrade
    // gracefully to availableLists=[], letting the LLM call klaviyo.list_lists
    // on its own if it needs the directory.
    let pendingContext: OrchestratorPendingCsvContext | undefined;
    {
      const pending = await deps.pendingRepo.lookupByThread(event.user, event.channel, pendingThreadKey);
      if (pending && pending.kind === 'klaviyo_csv_pending' && pending.callerSlackId === event.user) {
        const payload = pending.payload as { profiles: Array<unknown>; filename: string; channels?: string[] };
        let availableLists: Array<{ id: string; name: string }> = [];
        try {
          const lists = await deps.klaviyoClient.listLists();
          availableLists = lists.map((l) => ({ id: l.id, name: l.name }));
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'klaviyo_listLists_failed_for_pending_context',
          );
        }
        pendingContext = {
          kind: 'klaviyo_csv_pending',
          filename: payload.filename,
          rowCount: payload.profiles.length,
          channels: ((payload.channels as ('email' | 'sms')[] | undefined) ?? ['email']),
          availableLists,
        };
      }
    }

    if (!(await deps.usersRepo.isAuthorized(event.user))) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "You are not authorized to use this bot. Please ask Danny for access.",
      });
      return;
    }

    const placeholder = await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: "🔍 Thinking…",
    });

    if (!placeholder.ts) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "⚠️ Couldn't start the reply thread. Try again.",
      });
      return;
    }

    const threadHistory = await deps.conversationsRepo.loadRecentByThread(threadTs, 10);
    const started = Date.now();

    // Live progress: render each tool the orchestrator invokes with status —
    // running ("⏳ ga4.list_events"), done ("✓ ga4.list_events 1.5s"), or
    // failed ("✗ ga4.list_events"). After all tools finish, an idle ticker
    // keeps refreshing the message every ~10s with elapsed time so the user
    // knows the bot is still working (not hung). chat.update calls are
    // throttled to one per 600ms to stay under Slack rate limits.
    type ToolStatus = { name: string; state: 'running' | 'done' | 'failed'; elapsedMs?: number };
    const toolHistory: ToolStatus[] = [];
    let lastToolFinishedAt = 0;
    let lastUpdateAt = 0;
    let pendingUpdate: NodeJS.Timeout | null = null;
    let idleTicker: NodeJS.Timeout | null = null;
    const renderProgress = (): string => {
      if (toolHistory.length === 0) return '🔍 Thinking…';
      const lines = toolHistory.map((t) => {
        const icon = t.state === 'running' ? '⏳' : t.state === 'done' ? '✓' : '✗';
        const timing = t.elapsedMs != null ? ` _(${(t.elapsedMs / 1000).toFixed(1)}s)_` : '';
        return `${icon} \`${t.name}\`${timing}`;
      });
      const anyRunning = toolHistory.some((t) => t.state === 'running');
      let trailing = '';
      if (!anyRunning && lastToolFinishedAt > 0) {
        const idleSec = Math.round((Date.now() - lastToolFinishedAt) / 1000);
        if (idleSec < 15) {
          trailing = `\n_writing answer…_`;
        } else if (idleSec < 45) {
          trailing = `\n_writing answer… (${idleSec}s)_`;
        } else if (idleSec < 90) {
          trailing = `\n_still writing answer… (${idleSec}s — Claude is taking longer than usual)_`;
        } else {
          trailing = `\n_still working… (${idleSec}s — likely Claude API rate-limit retry; will resolve on its own)_`;
        }
      }
      return lines.join('\n') + trailing;
    };
    const flushProgress = () => {
      if (!placeholder.ts) return;
      lastUpdateAt = Date.now();
      void client.chat.update({
        channel: event.channel,
        ts: placeholder.ts,
        text: renderProgress(),
      }).catch((err: unknown) => {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'progress chat.update failed');
      });
    };
    const scheduleFlush = () => {
      const elapsed = Date.now() - lastUpdateAt;
      if (pendingUpdate) clearTimeout(pendingUpdate);
      if (elapsed >= 600) {
        flushProgress();
      } else {
        pendingUpdate = setTimeout(() => {
          pendingUpdate = null;
          flushProgress();
        }, 600 - elapsed);
      }
    };
    const startIdleTicker = () => {
      if (idleTicker) return;
      // Refresh the elapsed counter every 10s. Stops automatically when the
      // outer try/finally clears it.
      idleTicker = setInterval(() => {
        if (toolHistory.some((t) => t.state === 'running')) return;
        scheduleFlush();
      }, 10_000);
    };
    const stopIdleTicker = () => {
      if (idleTicker) { clearInterval(idleTicker); idleTicker = null; }
    };
    const onToolCall = (toolName: string) => {
      toolHistory.push({ name: toolName, state: 'running' });
      scheduleFlush();
    };
    const onToolFinish = (toolName: string, ok: boolean, elapsedMs: number) => {
      for (let i = toolHistory.length - 1; i >= 0; i--) {
        if (toolHistory[i].name === toolName && toolHistory[i].state === 'running') {
          toolHistory[i] = { name: toolName, state: ok ? 'done' : 'failed', elapsedMs };
          break;
        }
      }
      // If no more tools are running, this is the start of an LLM-only phase —
      // kick off the idle ticker so the message stays fresh.
      if (!toolHistory.some((t) => t.state === 'running')) {
        lastToolFinishedAt = Date.now();
        startIdleTicker();
      }
      scheduleFlush();
    };

    try {
      const out = await deps.orchestrator.run({
        question: event.text,
        threadHistory,
        actor: { slackUserId: event.user, slackChannelId: event.channel },
        thread: { channelId: event.channel, threadTs },
        onToolCall,
        onToolFinish,
        pendingContext,
      });
      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
        pendingUpdate = null;
      }
      stopIdleTicker();
      const blocks = markdownToSlackBlocks(out.response, {
        footer: buildFooter(out),
      });
      await client.chat.update({
        channel: event.channel,
        ts: placeholder.ts,
        text: out.response.slice(0, 200),
        blocks,
      });

      // If Claude attached any files, upload each to the same thread.
      for (const a of (out.attachments ?? []) as ReportAttachment[]) {
        try {
          logger.info(
            { filename: a.normalizedFilename, bytes: a.content.length, format: a.format },
            'uploading attachment',
          );
          await uploadSlackFile({
            token: env.SLACK_BOT_TOKEN,
            channel: event.channel,
            threadTs,
            filename: a.normalizedFilename,
            content: a.content,
            title: a.title,
          });
          logger.info({ filename: a.normalizedFilename }, 'attachment uploaded');
        } catch (uploadErr) {
          const msg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
          logger.error({ err: msg, filename: a.normalizedFilename }, 'file upload failed');
          await client.chat.postMessage({
            channel: event.channel,
            thread_ts: threadTs,
            text: `⚠️ Couldn't attach \`${a.normalizedFilename}\`: ${msg}`,
          });
        }
      }

      await deps.conversationsRepo.insert({
        slack_thread_ts: threadTs,
        slack_channel_id: event.channel,
        slack_user_id: event.user,
        question: event.text,
        tool_calls: env.DEBUG_FULL_LOGS
          ? out.toolCalls
          : out.toolCalls.map(({ name, ok, errorMessage }) => ({ name, ok, errorMessage })),
        response: out.response,
        model: out.model,
        tokens_input: out.tokensInput,
        tokens_output: out.tokensOutput,
        duration_ms: Date.now() - started,
      });
    } catch (err) {
      stopIdleTicker();
      if (pendingUpdate) { clearTimeout(pendingUpdate); pendingUpdate = null; }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'orchestrator failed');
      await client.chat.update({
        channel: event.channel,
        ts: placeholder.ts,
        text: `⚠️ Something went wrong: ${msg}`,
      });
      await deps.conversationsRepo.insert({
        slack_thread_ts: threadTs,
        slack_channel_id: event.channel,
        slack_user_id: event.user,
        question: event.text,
        error: msg,
        duration_ms: Date.now() - started,
      });
    }
  };
}

export function createMentionHandler() {
  return async ({ event, say }: any) => {
    await say({
      channel: event.channel,
      thread_ts: event.ts,
      text:
        "Hi! For privacy, I only answer in DMs. Open a direct message with me and ask there.",
    });
  };
}

export interface FileSharedEvent {
  channel_id: string;
  user_id: string;
  file_id: string;
}

export interface FileSharedDeps {
  /** The bot's own Slack user id (from auth.test at startup). Used to drop
   *  file_shared events triggered by the bot's own uploads — those would
   *  otherwise hit the role check below with a non-human user_id and surface
   *  a misleading "requires admin or marketing role" reply. */
  botUserId?: string | null;
  usersRepo: { getRole(slackUserId: string): Promise<string | null> };
  slack: {
    filesInfo(fileId: string): Promise<{
      ok: boolean;
      file?: {
        id: string; name: string; filetype: string; mimetype: string;
        size: number; url_private_download: string;
        // Slack delivers a `shares` map indexed by channel — each entry has the
        // file's parent message ts (the ts of the message the user sent when
        // they uploaded). Used to thread the bot's reply under the upload.
        shares?: {
          public?: Record<string, Array<{ ts?: string; thread_ts?: string }>>;
          private?: Record<string, Array<{ ts?: string; thread_ts?: string }>>;
        };
      };
    }>;
    downloadFile(url: string): Promise<Buffer>;
    postMessage(channel: string, text: string, threadTs?: string): Promise<void>;
  };
  orchestrator: {
    runTool(
      name: string,
      args: unknown,
      actor: { slackUserId: string; channelId: string; threadTs?: string; role?: string },
    ): Promise<unknown>;
  };
  storage: {
    upload(path: string, body: Buffer | string, contentType: string): Promise<{ path: string }>;
  };
  pendingRepo: {
    insert(input: {
      callerSlackId: string;
      channelId: string;
      threadTs: string;
      kind: 'klaviyo_csv_pending';
      payload: unknown;
      ttlMinutes?: number;
    }): Promise<{ id: string; confirmationToken: string }>;
  };
  /** Anthropic SDK client used for the LLM-driven header validation +
   *  mapping step. The mapper accepts CSVs whose headers are in any language
   *  (Spanish, German, etc.) without us having to maintain an alias table. */
  claude: HeaderMapperDeps['claude'];
}

const MAX_BYTES = 1_000_000;
const ALLOWED_MIME = new Set(['text/csv', 'application/csv', 'text/plain']);

export async function handleFileShared(input: { event: FileSharedEvent; deps: FileSharedDeps }) {
  const { event, deps } = input;
  if (!event.channel_id.startsWith('D')) return;

  // Drop events triggered by the bot's own uploads (e.g. canvas / file
  // attachments the bot creates while answering analytics queries). Without
  // this, those events fall through to the role check below — the bot's own
  // user_id has no row in authorized_users, so it surfaces a confusing
  // "requires admin or marketing role" reply to the human caller.
  if (deps.botUserId && event.user_id === deps.botUserId) {
    logger.debug({ user: event.user_id, file: event.file_id }, 'file_shared from bot — ignored');
    return;
  }

  const role = await deps.usersRepo.getRole(event.user_id);
  if (!['admin', 'marketing'].includes(role ?? '')) {
    await deps.slack.postMessage(
      event.channel_id,
      'Sorry — uploading CSVs to Klaviyo requires the admin or marketing role.',
      undefined,
    );
    logger.warn({ user: event.user_id, role }, 'klaviyo_write_denied_csv');
    return;
  }

  const info = await deps.slack.filesInfo(event.file_id);
  const file = info.file;
  if (!file) return;

  if (file.size > MAX_BYTES) {
    await deps.slack.postMessage(
      event.channel_id,
      `That CSV is ${(file.size / 1024).toFixed(0)} KB; max is ${(MAX_BYTES / 1024).toFixed(0)} KB. Split into smaller files.`,
      undefined,
    );
    return;
  }

  const okExt = file.filetype === 'csv' || file.name.toLowerCase().endsWith('.csv');
  const okMime = ALLOWED_MIME.has(file.mimetype);
  if (!okExt && !okMime) return;

  let buf: Buffer;
  try {
    buf = await deps.slack.downloadFile(file.url_private_download);
  } catch (err: any) {
    logger.warn({ err: String(err?.message ?? err), fileId: file.id }, 'klaviyo_csv_download_failed');
    await deps.slack.postMessage(
      event.channel_id,
      `Couldn't download your file (${String(err?.message ?? err)}). Try re-sharing.`,
      undefined,
    );
    return;
  }

  let parsed;
  try {
    parsed = parseRawCsv(buf.toString('utf8'));
  } catch (err: any) {
    await deps.slack.postMessage(
      event.channel_id,
      `Couldn't parse the CSV: ${String(err?.message ?? err)}. Make sure it has a header row and is comma-delimited.`,
      undefined,
    );
    return;
  }

  // LLM-driven header validation + canonical mapping. Accepts CSVs in any
  // language; throws with a user-facing reason when infeasible (e.g. no
  // email-like column). Cost is one Haiku call per upload — negligible.
  let mapped: { rows: import('../connectors/klaviyo/csv-parser.js').ParsedCsvRow[]; warnings: string[] };
  try {
    mapped = await validateAndMapForKlaviyo(parsed, { claude: deps.claude });
  } catch (err: any) {
    await deps.slack.postMessage(
      event.channel_id,
      String(err?.message ?? err),
      undefined,
    );
    return;
  }

  const upload = await deps.storage
    .upload(`klaviyo-imports/${file.id}-${Date.now()}.csv`, buf, 'text/csv')
    .catch(() => ({ path: null as any }));

  // Find the ts of the message that uploaded this file, so the bot's ack
  // (and every subsequent commit reply) can thread under it instead of
  // landing in the main DM. Slack's files.info returns a `shares` map per
  // channel; we pick the first entry for the channel where the upload
  // happened. Falls back to undefined (main channel reply) if absent.
  const shareTs =
    file.shares?.public?.[event.channel_id]?.[0]?.thread_ts ??
    file.shares?.public?.[event.channel_id]?.[0]?.ts ??
    file.shares?.private?.[event.channel_id]?.[0]?.thread_ts ??
    file.shares?.private?.[event.channel_id]?.[0]?.ts;

  // Klaviyo's bulk-subscribe endpoint silently drops profiles when no list is
  // attached (returns 202 OK but no work is done), so we CANNOT auto-import a
  // CSV upload without first confirming the target list. Stash the parsed
  // rows in pending_confirmations and prompt the user — the confirmation
  // handler picks up the reply and calls klaviyo.commit_pending_csv_import.
  const profiles = mapped.rows.map(({ rowIndex: _i, ...rest }) => rest);
  const pending = await deps.pendingRepo.insert({
    callerSlackId: event.user_id,
    channelId: event.channel_id,
    // Use the file-share ts as the thread key when present; this matches the
    // ts the user's text reply will carry (Slack auto-sets thread_ts for replies
    // in a thread). Fallback to channel_id for DMs that don't return a share ts.
    threadTs: shareTs ?? event.channel_id,
    kind: 'klaviyo_csv_pending',
    payload: {
      profiles,
      filename: file.name,
      storagePath: upload.path ?? null,
      channels: ['email'],
      replyThreadTs: shareTs ?? null,
    },
  });

  const lines: string[] = [];
  const allWarnings = [...parsed.warnings, ...mapped.warnings];
  if (allWarnings.length > 0) lines.push(allWarnings.join('\n'), '');
  lines.push(
    `Got *${profiles.length} row${profiles.length === 1 ? '' : 's'}* from \`${file.name}\`. I'm assuming this is for a *Klaviyo import* — that's the only CSV flow I handle right now.`,
    `Which Klaviyo list should I import them to? Reply with the list name (or "no list" to create profiles without list-membership, or "cancel" to abort).`,
    `_Pending import token: \`${pending.confirmationToken}\` — expires in 30 minutes._`,
  );
  await deps.slack.postMessage(event.channel_id, lines.join('\n'), shareTs);
  logger.info(
    { pendingId: pending.id, fileId: file.id, profiles: profiles.length, caller: event.user_id },
    'klaviyo_csv_pending_created',
  );
}

// formatImportReply was used when the file_shared handler auto-submitted to
// klaviyo.import_profiles. The handler now stages the rows in
// pending_confirmations and asks the LLM to commit when the user picks a
// list, so this formatter is no longer needed.

