import type { AuthorizedUsersRepo } from '../storage/repositories/authorized-users.js';
import type { ConversationsRepo } from '../storage/repositories/conversations.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import type { ReportAttachment } from '../connectors/reports/reports-connector.js';
import { markdownToSlackBlocks } from '../orchestrator/formatter.js';
import { logger } from '../logger.js';
import { loadEnv } from '../config/env.js';
import { parseCsv } from '../connectors/klaviyo/csv-parser.js';

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

    const threadTs = event.thread_ts ?? event.ts;

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
  usersRepo: { getRole(slackUserId: string): Promise<string | null> };
  slack: {
    filesInfo(fileId: string): Promise<{
      ok: boolean;
      file?: {
        id: string; name: string; filetype: string; mimetype: string;
        size: number; url_private_download: string;
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
}

const MAX_BYTES = 1_000_000;
const ALLOWED_MIME = new Set(['text/csv', 'application/csv', 'text/plain']);

export async function handleFileShared(input: { event: FileSharedEvent; deps: FileSharedDeps }) {
  const { event, deps } = input;
  if (!event.channel_id.startsWith('D')) return;

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
    parsed = parseCsv(buf.toString('utf8'));
  } catch (err: any) {
    await deps.slack.postMessage(
      event.channel_id,
      `Couldn't parse the CSV: ${String(err?.message ?? err)}. Make sure it has a header row and is comma-delimited.`,
      undefined,
    );
    return;
  }

  const upload = await deps.storage
    .upload(`klaviyo-imports/${file.id}-${Date.now()}.csv`, buf, 'text/csv')
    .catch(() => ({ path: null as any }));

  if (parsed.warnings.length > 0) {
    await deps.slack.postMessage(event.channel_id, parsed.warnings.join('\n'), undefined);
  }

  const args = {
    source: 'csv' as const,
    storage_path: upload.path ?? undefined,
    filename: file.name,
    profiles: parsed.rows.map(({ rowIndex: _i, ...rest }) => rest),
    channels: ['email'] as const,
  };
  const result: any = await deps.orchestrator.runTool('klaviyo.import_profiles', args, {
    slackUserId: event.user_id,
    channelId: event.channel_id,
    role: role!,
  });
  await deps.slack.postMessage(event.channel_id, formatImportReply(result), undefined);
}

function formatImportReply(r: any): string {
  if (r?.kind === 'imported_directly') {
    return `Queued ${r.total_imported} profile${r.total_imported === 1 ? '' : 's'} (audit \`${r.audit_id}\`). I'll DM when it's done.`;
  }
  if (r?.kind === 'awaiting_confirmation') return r.message;
  if (r?.kind === 'all_invalid') {
    return `All ${r.invalid_count} rows failed validation. Examples: ${(r.invalid_rows || [])
      .slice(0, 3)
      .map((x: any) => `row ${x.rowIndex}: ${x.reason}`)
      .join(' | ')}`;
  }
  if (r?.error) return `Error (${r.error.code}): ${r.error.message}`;
  return 'Done.';
}
