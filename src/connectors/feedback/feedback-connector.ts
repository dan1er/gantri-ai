import { z } from 'zod';
import type { WebClient } from '@slack/web-api';
import type { Connector, ToolDef, ToolResult } from '../base/connector.js';
import type { ActorContext } from '../../orchestrator/orchestrator.js';
import type { FeedbackRepo, FeedbackRow } from '../../storage/repositories/feedback.js';
import type { ConversationsRepo } from '../../storage/repositories/conversations.js';
import { logger } from '../../logger.js';

const FlagArgs = z.object({
  reason: z.string().min(1).max(2000).optional(),
  /** Optional: if the bot wants to attribute the flag to a specific thread (rare —
   *  default is the in-flight thread, which is fetched from a runtime accessor). */
  threadTs: z.string().optional(),
});
type FlagArgs = z.infer<typeof FlagArgs>;

const ResolveArgs = z.object({
  id: z.string().uuid(),
  resolution: z.string().min(1).max(2000),
});
type ResolveArgs = z.infer<typeof ResolveArgs>;

const UpdateStatusArgs = z.object({
  id: z.string().uuid(),
  status: z.enum(['open', 'investigating', 'resolved', 'wontfix']),
  resolution: z.string().min(1).max(2000).optional(),
});
type UpdateStatusArgs = z.infer<typeof UpdateStatusArgs>;

const ListOpenArgs = z.object({ limit: z.number().int().min(1).max(100).default(50) });
type ListOpenArgs = z.infer<typeof ListOpenArgs>;

/** Per-call thread context — the Slack handler sets it before each
 *  orchestrator.run() so flag_response can capture the current thread.
 *  Same shape as ActorContext but with the thread anchor explicit. */
export interface ThreadContext {
  channelId: string;
  threadTs: string;
}

export interface FeedbackConnectorDeps {
  repo: FeedbackRepo;
  conversationsRepo: ConversationsRepo;
  slackClient: WebClient;
  /** Maintainer Slack user id (env MAINTAINER_SLACK_USER_ID). Tools that require
   *  maintainer auth check that the active actor matches this. If unset (env not
   *  configured), maintainer-only tools all return MAINTAINER_NOT_CONFIGURED. */
  maintainerSlackUserId: string | undefined;
  /** Resolves the calling actor for the in-flight orchestrator run. */
  getActor: () => ActorContext | undefined;
  /** Resolves the in-flight Slack thread context (channel + thread_ts).
   *  Set by the Slack handler before each orchestrator.run(). */
  getThread: () => ThreadContext | undefined;
}

export class FeedbackConnector implements Connector {
  readonly name = 'feedback';
  readonly tools: readonly ToolDef[];

  constructor(private readonly deps: FeedbackConnectorDeps) {
    this.tools = this.buildTools();
  }

  async healthCheck() {
    return { ok: true };
  }

  private buildTools(): ToolDef[] {
    const flagResponse: ToolDef<FlagArgs> = {
      name: 'feedback.flag_response',
      description:
        "Flag the bot's most recent answer in the current thread as wrong / incomplete / weird, sending a notification to the maintainer for follow-up. Use when the user explicitly says the answer is wrong, makes no sense, doesn't match what they expected, or otherwise asks to \"report this\" / \"send to danny\" / \"esto está mal\". Captures the latest Q/A + tool calls from the thread automatically; the user only needs to provide an optional `reason` summarizing the complaint. The reporter (calling user) gets a confirmation reply with the feedback id; the maintainer gets a DM with the full context and a link back to the thread. The reporter will later be notified by DM when the maintainer resolves or closes the report.",
      schema: FlagArgs as z.ZodType<FlagArgs>,
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reason: { type: 'string', description: 'Optional one-line summary of what the user thinks is wrong.' },
          threadTs: { type: 'string', description: 'Override thread anchor; default is the in-flight thread.' },
        },
      },
      execute: (args) => this.executeFlag(args),
    };

    const resolve: ToolDef<ResolveArgs> = {
      name: 'feedback.resolve',
      description:
        "Mark a feedback report resolved with a short note explaining the fix. **Maintainer-only.** Sets status='resolved', resolved_at=now, persists the resolution text, and DMs the original reporter the resolution note + a link to the original thread.",
      schema: ResolveArgs as z.ZodType<ResolveArgs>,
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'resolution'],
        properties: {
          id: { type: 'string', description: 'The feedback report id (uuid).' },
          resolution: {
            type: 'string',
            description: 'Plain-language note about what was fixed / why the issue happened.',
          },
        },
      },
      execute: (args) => this.executeResolve(args),
    };

    const updateStatus: ToolDef<UpdateStatusArgs> = {
      name: 'feedback.update_status',
      description:
        "Move a feedback report through statuses ('open' / 'investigating' / 'resolved' / 'wontfix'). **Maintainer-only.** Use 'investigating' to acknowledge a report you're actively looking at (no user notification fires for this status). Use 'wontfix' for reports you're explicitly closing as not-a-bug — the reporter gets a DM with your `resolution` note. For 'resolved' prefer the dedicated `feedback.resolve` tool, which is shorter to call.",
      schema: UpdateStatusArgs as z.ZodType<UpdateStatusArgs>,
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['open', 'investigating', 'resolved', 'wontfix'] },
          resolution: {
            type: 'string',
            description: 'Required when transitioning to a closing status (resolved or wontfix).',
          },
        },
      },
      execute: (args) => this.executeUpdateStatus(args),
    };

    const listOpen: ToolDef<ListOpenArgs> = {
      name: 'feedback.list_open',
      description:
        "Return the open and in-progress feedback reports, newest first. **Maintainer-only.** Useful for triage when the user asks \"what feedback do I have\" / \"what's open in feedback\" / \"show me reports\". Each row has id, reporter, reason, captured Q/A snippet, status, and a Slack permalink.",
      schema: ListOpenArgs as z.ZodType<ListOpenArgs>,
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
      },
      execute: (args) => this.executeListOpen(args),
    };

    return [flagResponse, resolve, updateStatus, listOpen];
  }

  // ------------------ Tool implementations ------------------

  private async executeFlag(args: FlagArgs): Promise<ToolResult | Record<string, unknown>> {
    const actor = this.deps.getActor();
    if (!actor) {
      return {
        ok: false,
        error: { code: 'NO_ACTOR', message: 'feedback.flag_response requires an active actor context.' },
      };
    }
    const thread = this.deps.getThread();
    if (!thread && !args.threadTs) {
      return {
        ok: false,
        error: {
          code: 'NO_THREAD',
          message: 'No thread context available — the bot must be running in a Slack DM thread.',
        },
      };
    }
    const channelId = thread?.channelId ?? '';
    const threadTs = args.threadTs ?? thread!.threadTs;

    // Capture the most recent Q/A from this thread.
    const recent = await this.deps.conversationsRepo.loadRecentByThread(threadTs, 1);
    const captured = recent.length > 0 ? recent[recent.length - 1] : null;

    // Best-effort permalink — failure here doesn't block the flag.
    let permalink: string | null = null;
    try {
      const r = await this.deps.slackClient.chat.getPermalink({ channel: channelId, message_ts: threadTs });
      if (r.ok && r.permalink) permalink = r.permalink as string;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'chat.getPermalink failed (non-fatal)',
      );
    }

    const row = await this.deps.repo.insert({
      reporter_slack_user_id: actor.slackUserId,
      reason: args.reason ?? null,
      channel_id: channelId,
      thread_ts: threadTs,
      thread_permalink: permalink,
      captured_question: captured?.question ?? null,
      captured_response: captured?.response ?? null,
      captured_tool_calls: null,
      captured_model: null,
      captured_iterations: null,
    });

    // Notify the maintainer (best-effort).
    if (this.deps.maintainerSlackUserId) {
      void this.notifyMaintainerOfNewFlag(row).catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), id: row.id },
          'maintainer notify failed',
        );
      });
    }

    return {
      feedback: {
        id: row.id,
        status: row.status,
        threadPermalink: row.thread_permalink,
      },
    };
  }

  private async executeResolve(args: ResolveArgs): Promise<ToolResult | Record<string, unknown>> {
    const auth = this.requireMaintainer();
    if (auth) return auth;
    return this.transitionToClosed(args.id, 'resolved', args.resolution);
  }

  private async executeUpdateStatus(args: UpdateStatusArgs): Promise<ToolResult | Record<string, unknown>> {
    const auth = this.requireMaintainer();
    if (auth) return auth;
    if ((args.status === 'resolved' || args.status === 'wontfix') && !args.resolution) {
      return {
        ok: false,
        error: {
          code: 'MISSING_RESOLUTION',
          message: 'A resolution note is required when closing a feedback report.',
        },
      };
    }
    if (args.status === 'resolved' || args.status === 'wontfix') {
      return this.transitionToClosed(args.id, args.status, args.resolution!);
    }
    // Non-closing transition (open / investigating).
    const row = await this.deps.repo.getById(args.id);
    if (!row) return { ok: false, error: { code: 'NOT_FOUND', message: 'Feedback report not found.' } };
    const updated = await this.deps.repo.update(args.id, {
      status: args.status,
      resolution: args.resolution ?? row.resolution,
    });
    return { feedback: shape(updated) };
  }

  private async executeListOpen(args: ListOpenArgs): Promise<ToolResult | Record<string, unknown>> {
    const auth = this.requireMaintainer();
    if (auth) return auth;
    const rows = await this.deps.repo.listOpen(args.limit);
    return { count: rows.length, reports: rows.map(shape) };
  }

  // ------------------ Helpers ------------------

  private requireMaintainer(): { ok: false; error: { code: string; message: string } } | null {
    const actor = this.deps.getActor();
    if (!actor) {
      return {
        ok: false,
        error: { code: 'NO_ACTOR', message: 'maintainer-only tool called without an actor context' },
      };
    }
    if (!this.deps.maintainerSlackUserId) {
      return {
        ok: false,
        error: {
          code: 'MAINTAINER_NOT_CONFIGURED',
          message: 'No maintainer user is configured (MAINTAINER_SLACK_USER_ID).',
        },
      };
    }
    if (actor.slackUserId !== this.deps.maintainerSlackUserId) {
      return {
        ok: false,
        error: { code: 'FORBIDDEN', message: 'This action is restricted to the maintainer.' },
      };
    }
    return null;
  }

  private async transitionToClosed(
    id: string,
    status: 'resolved' | 'wontfix',
    resolution: string,
  ): Promise<ToolResult | Record<string, unknown>> {
    const row = await this.deps.repo.getById(id);
    if (!row) return { ok: false, error: { code: 'NOT_FOUND', message: 'Feedback report not found.' } };
    const updated = await this.deps.repo.update(id, {
      status,
      resolution,
      resolved_at: new Date().toISOString(),
    });
    void this.notifyReporterOfClose(updated).catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), id },
        'reporter notify failed',
      );
    });
    return { feedback: shape(updated) };
  }

  private async notifyMaintainerOfNewFlag(row: FeedbackRow): Promise<void> {
    if (!this.deps.maintainerSlackUserId) return;
    const dm = await this.deps.slackClient.conversations.open({ users: this.deps.maintainerSlackUserId });
    const channel = dm.ok ? dm.channel?.id : null;
    if (!channel) return;
    const reporterMention = `<@${row.reporter_slack_user_id}>`;
    const reasonLine = row.reason ? `> *Reason:* ${row.reason}\n` : '';
    const threadLine = row.thread_permalink ? `*Thread:* <${row.thread_permalink}|open in Slack>\n` : '';
    const qLine = row.captured_question ? `*Q:* ${truncate(row.captured_question, 300)}\n` : '';
    const aLine = row.captured_response ? `*A:* ${truncate(row.captured_response, 600)}\n` : '';
    const text = [
      `🚩 New feedback flagged by ${reporterMention}`,
      reasonLine,
      threadLine,
      qLine,
      aLine,
      `Feedback id: \`${row.id}\``,
    ]
      .filter((l) => l && l.length > 0)
      .join('\n');
    await this.deps.slackClient.chat.postMessage({ channel, text });
  }

  private async notifyReporterOfClose(row: FeedbackRow): Promise<void> {
    const dm = await this.deps.slackClient.conversations.open({ users: row.reporter_slack_user_id });
    const channel = dm.ok ? dm.channel?.id : null;
    if (!channel) return;
    const headline =
      row.status === 'resolved' ? '✅ Your feedback was resolved' : "🛑 Your feedback was closed (won't fix)";
    const original = row.reason ? `> *Original report:* ${row.reason}` : '';
    const resolution = row.resolution ? `*Resolution:* ${row.resolution}` : '';
    const link = row.thread_permalink ? `*Original thread:* <${row.thread_permalink}|open in Slack>` : '';
    const text = [headline, original, resolution, link].filter((l) => l && l.length > 0).join('\n');
    await this.deps.slackClient.chat.postMessage({ channel, text });
  }
}

function shape(row: FeedbackRow) {
  return {
    id: row.id,
    reporterSlackUserId: row.reporter_slack_user_id,
    reason: row.reason,
    threadPermalink: row.thread_permalink,
    capturedQuestion: row.captured_question ? truncate(row.captured_question, 200) : null,
    capturedResponse: row.captured_response ? truncate(row.captured_response, 200) : null,
    status: row.status,
    resolution: row.resolution,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
