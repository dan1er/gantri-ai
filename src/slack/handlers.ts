import type { AuthorizedUsersRepo } from '../storage/repositories/authorized-users.js';
import type { ConversationsRepo } from '../storage/repositories/conversations.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import type { ReportAttachment } from '../connectors/reports/reports-connector.js';
import { markdownToSlackBlocks } from '../orchestrator/formatter.js';
import { logger } from '../logger.js';
import { loadEnv } from '../config/env.js';

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
  gantri: 'Porter',
  grafana: 'Grafana',
  reports: 'Reports',
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
    try {
      const out = await deps.orchestrator.run({
        question: event.text,
        threadHistory,
        actor: { slackUserId: event.user, slackChannelId: event.channel },
      });
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
