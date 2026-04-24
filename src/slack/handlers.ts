import type { AuthorizedUsersRepo } from '../storage/repositories/authorized-users.js';
import type { ConversationsRepo } from '../storage/repositories/conversations.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { markdownToSlackBlocks } from '../orchestrator/formatter.js';
import { logger } from '../logger.js';
import { loadEnv } from '../config/env.js';

export interface HandlerDeps {
  orchestrator: Orchestrator;
  usersRepo: AuthorizedUsersRepo;
  conversationsRepo: ConversationsRepo;
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
      text: "🔍 Consultando datos…",
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
      const out = await deps.orchestrator.run({ question: event.text, threadHistory });
      const blocks = markdownToSlackBlocks(out.response, {
        footer: `Fuente: Northbeam • Modelo: ${out.model} • ${out.iterations} iteración${out.iterations === 1 ? '' : 'es'}`,
      });
      await client.chat.update({
        channel: event.channel,
        ts: placeholder.ts,
        text: out.response.slice(0, 200),
        blocks,
      });
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
