import { z } from 'zod';
import type { WebClient } from '@slack/web-api';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import { DateRangeArg, normalizeDateRange } from '../base/date-range.js';
import type { AuthorizedUsersRepo } from '../../storage/repositories/authorized-users.js';
import type { ConversationsRepo, ConversationUsageRow } from '../../storage/repositories/conversations.js';
import type { ActorContext } from '../../orchestrator/orchestrator.js';
import { logger } from '../../logger.js';
import { INTRO_MESSAGE } from './intro-message.js';

const BroadcastArgs = z.object({
  message: z.string().min(1).max(8000).describe('Message body to send to each recipient. Slack mrkdwn supported. Will be prefixed with a small "Broadcast from <sender>" line so recipients know who sent it.'),
  excludeUserIds: z.array(z.string()).optional().describe('Slack user IDs to skip (e.g. ["U03KJCV1Z"]).'),
  excludeEmails: z.array(z.string()).optional().describe('Email addresses to skip — matched against authorized_users.email (case-insensitive). Useful when you know the person but not the Slack ID.'),
  dryRun: z.boolean().default(false).describe('When true, returns the recipient list and would-be message WITHOUT sending. Use this first when the user asks for a "test" or "preview" broadcast.'),
});
type BroadcastArgs = z.infer<typeof BroadcastArgs>;

const AddUserArgs = z.object({
  email: z.string().email().optional().describe('Email of the person to enable. The connector resolves their Slack user ID via users.lookupByEmail.'),
  slackUserId: z.string().optional().describe('Direct Slack user ID (alternative to email).'),
  role: z.enum(['user', 'admin', 'marketing']).default('user').describe('"user" (default), "admin" (broadcast + add_user + update_user_role), or "marketing" (Klaviyo write tools — import_profiles, delete_profiles).'),
  sendIntro: z.boolean().default(true).describe('Whether to DM the new user the standard intro message after enabling. Default true.'),
}).refine((v) => Boolean(v.email || v.slackUserId), { message: 'Provide email or slackUserId.' });
type AddUserArgs = z.infer<typeof AddUserArgs>;

const UpdateUserRoleArgs = z.object({
  slack_user_id: z.string().describe('Slack user id of the existing authorized user (e.g. "U086PLKBEBT").'),
  role: z.enum(['admin', 'marketing', 'user']).describe('New role to set. "admin" = broadcast + add_user + update_user_role. "marketing" = Klaviyo write tools. "user" = read-only.'),
});
type UpdateUserRoleArgs = z.infer<typeof UpdateUserRoleArgs>;

const ListUsersArgs = z.object({
  role: z.enum(['admin', 'marketing', 'user']).optional()
    .describe('Optional filter: only return users with this role. Omit to return everyone.'),
});
type ListUsersArgs = z.infer<typeof ListUsersArgs>;

const UsageSummaryArgs = z.object({
  dateRange: DateRangeArg.optional()
    .describe('Time window in Pacific Time. Defaults to the last 7 days if omitted. Accepts presets (e.g. "last_7_days", "last_30_days") or explicit { startDate, endDate } (YYYY-MM-DD inclusive).'),
  groupBy: z.enum(['user', 'tool', 'day']).default('user')
    .describe('"user" (default) → one row per Slack user with their question count, last activity, top tools, errors, tokens. "tool" → one row per tool name with usage count across all users. "day" → one row per day with the daily volume.'),
  limit: z.number().int().min(1).max(100).default(50)
    .describe('Max rows to return in the aggregated result. Default 50, max 100.'),
  includeQuestions: z.boolean().default(false)
    .describe('When true, the user-grouped response includes the top 5 most recent question snippets per user (truncated to 120 chars). Off by default to keep responses small.'),
});
type UsageSummaryArgs = z.infer<typeof UsageSummaryArgs>;

export interface BroadcastConnectorDeps {
  slackClient: WebClient;
  usersRepo: AuthorizedUsersRepo;
  conversationsRepo: ConversationsRepo;
  /** The single maintainer's Slack user id (env MAINTAINER_SLACK_USER_ID). The
   *  usage_summary tool is gated on this — only Danny can see who used the bot
   *  and what they asked. If unset, usage_summary returns MAINTAINER_NOT_CONFIGURED. */
  maintainerSlackUserId: string | undefined;
  getActor: () => ActorContext | undefined;
}

/**
 * Sends a one-off message to every authorized bot user, except those the
 * caller explicitly excludes. Admin-only — only users with role='admin' in
 * authorized_users can trigger it. Audit-logged via pino.
 */
export class BroadcastConnector implements Connector {
  readonly name = 'broadcast';
  readonly tools: readonly ToolDef[];

  constructor(private readonly deps: BroadcastConnectorDeps) {
    this.tools = this.buildTools();
  }

  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  private buildTools(): ToolDef[] {
    const broadcast: ToolDef<BroadcastArgs> = {
      name: 'bot.broadcast_notification',
      description: [
        'Send a one-off DM to every authorized user of this bot, optionally excluding specific Slack user IDs or emails.',
        'ADMIN-ONLY — fails with FORBIDDEN if the calling user is not role="admin" in authorized_users. The bot has a small allowlist (~5–10 employees), so a broadcast reaches the whole team.',
        'Use ONLY when the user explicitly asks to "broadcast", "notify everyone", "send to all users", "anuncio para el equipo", "mandar a todos", etc. NEVER fire this tool to send a personal message — for that use the conversation thread.',
        'Pass `dryRun: true` first whenever the user says "test", "preview", "simulate", "ensayo" — that returns the would-be recipient list without sending. Then call again with `dryRun: false` after confirmation.',
        'Returns: totalAuthorized, recipients (list), excluded (with reason), delivered (per-user), failed (with error). Always show the excluded list back to the user so they can confirm.',
      ].join(' '),
      schema: BroadcastArgs as z.ZodType<BroadcastArgs>,
      jsonSchema: zodToJsonSchema(BroadcastArgs),
      execute: (args) => this.run(args),
    };
    const addUser: ToolDef<AddUserArgs> = {
      name: 'bot.add_user',
      description: [
        'Enable a new user on the bot — inserts them into the allowlist (`authorized_users`) and (by default) DMs them the standard intro message so they can start using the bot immediately.',
        'ADMIN-ONLY (gated by role="admin").',
        'Identify the user by EITHER `email` (preferred — I\'ll resolve the Slack ID via Slack\'s users.lookupByEmail) OR `slackUserId` (e.g. `U086PLKBEBT`).',
        'Optional `role` (default "user"). "admin" grants broadcast/add_user/update_user_role; "marketing" grants Klaviyo write tools (import_profiles, delete_profiles).',
        'Optional `sendIntro` (default true). Set to false if the user already knows the bot and just needs allowlist access.',
        'Idempotent — calling on an already-enabled user updates their email/role and (by default) does NOT re-DM the intro. Returns `{created: true|false, alreadyEnabled, user, introSent}`.',
        'Use when the operator says: "give X access to the bot", "add lana@gantri.com to the bot", "enable Ian", "habilita a Pedro", "add as admin", "agrega a Lana como marketing".',
      ].join(' '),
      schema: AddUserArgs as z.ZodType<AddUserArgs>,
      jsonSchema: zodToJsonSchema(AddUserArgs),
      execute: (args) => this.addUser(args),
    };
    const updateRole: ToolDef<UpdateUserRoleArgs> = {
      name: 'bot.update_user_role',
      description: [
        'Change an existing authorized user\'s role.',
        'ADMIN-ONLY (gated by role="admin" on the caller).',
        'Roles: "admin" (full powers — broadcast, add_user, update_user_role), "marketing" (Klaviyo write tools), "user" (read-only).',
        'Use when the operator says: "make Lana marketing", "give Pedro admin access", "demote X to user", "haz a Lana marketing".',
        'Returns `{ok:true, previous_role, new_role}` on success, or `{error:{code,message}}` (codes: NO_ACTOR, FORBIDDEN, USER_NOT_FOUND).',
        'If the target is not yet authorized, this returns USER_NOT_FOUND — call `bot.add_user` first.',
      ].join(' '),
      schema: UpdateUserRoleArgs as z.ZodType<UpdateUserRoleArgs>,
      jsonSchema: zodToJsonSchema(UpdateUserRoleArgs),
      execute: (args) => this.updateRole(args),
    };
    const listUsers: ToolDef<ListUsersArgs> = {
      name: 'bot.list_users',
      description: [
        'List every authorized user of the bot with their role.',
        'ADMIN-ONLY (gated by role="admin" on the caller).',
        'Optional `role` filter: when set, returns only users with that role. Omit to get everyone.',
        'Use when the operator says: "who has access to the bot", "list users and roles", "who is admin", "show all marketing users", "quien tiene acceso".',
        'Returns `{count, users: [{slackUserId, email, role, createdAt}, ...]}` sorted by createdAt ascending. `email` is null when we never resolved one (legacy rows added by slack id only).',
      ].join(' '),
      schema: ListUsersArgs as z.ZodType<ListUsersArgs>,
      jsonSchema: zodToJsonSchema(ListUsersArgs),
      execute: (args) => this.listUsers(args),
    };
    const usageSummary: ToolDef<UsageSummaryArgs> = {
      name: 'bot.usage_summary',
      description: [
        'MAINTAINER-ONLY analytics on bot activity from the conversations log. Surfaces who has used the bot, what they asked, which tools fired, errors, and per-day volume.',
        'Gated on the SINGLE maintainer (MAINTAINER_SLACK_USER_ID env). Not just admin — only the maintainer can see other users\' questions, since they may contain customer PII (emails, order ids, etc.). Non-maintainer callers get FORBIDDEN even if their role is "admin".',
        'Args: `dateRange` (default last 7 days, accepts presets like "last_7_days" / "last_30_days" or {startDate,endDate}), `groupBy` ("user" default | "tool" | "day"), `limit` (default 50), `includeQuestions` (default false; when true, the user-grouped response includes the 5 most recent question snippets per user truncated to 120 chars).',
        'Trigger words: "who has used the bot", "bot usage this week", "show me what people asked", "actividad del bot", "quién usó el bot", "bot analytics", "uso del bot última semana".',
        'Returns: `{ period, groupBy, totalMessages, uniqueUsers, rows: [...], note? }`. Each row shape depends on groupBy. Includes a `note` when the row cap was hit so we know we truncated.',
      ].join(' '),
      schema: UsageSummaryArgs as z.ZodType<UsageSummaryArgs>,
      jsonSchema: zodToJsonSchema(UsageSummaryArgs),
      execute: (args) => this.usageSummary(args),
    };
    return [broadcast, addUser, updateRole, listUsers, usageSummary];
  }

  private async usageSummary(args: UsageSummaryArgs) {
    const actor = this.deps.getActor();
    if (!actor) {
      return { error: { code: 'NO_ACTOR', message: 'bot.usage_summary requires an active actor.' } };
    }
    if (!this.deps.maintainerSlackUserId) {
      return {
        error: {
          code: 'MAINTAINER_NOT_CONFIGURED',
          message: 'No maintainer Slack user is configured (MAINTAINER_SLACK_USER_ID env var). Bot owner needs to set this before usage_summary can be called.',
        },
      };
    }
    if (actor.slackUserId !== this.deps.maintainerSlackUserId) {
      logger.warn({ caller: actor.slackUserId }, 'usage_summary denied: non-maintainer');
      return {
        error: {
          code: 'FORBIDDEN',
          message: 'bot.usage_summary is restricted to the maintainer (single user). This tool exposes other users\' questions which may contain PII.',
        },
      };
    }

    // Resolve date range — default to last 7 days when omitted.
    const range = args.dateRange
      ? normalizeDateRange(args.dateRange)
      : normalizeDateRange('last_7_days');
    // Convert YYYY-MM-DD (PT) → ISO timestamps covering the full day in PT.
    // `gte from 00:00 PT`, `lte to 23:59:59.999 PT`. We use UTC equivalents:
    // PT is UTC-7 (PDT) or UTC-8 (PST) — `created_at` is stored as UTC, so we
    // widen by a full day to be safe. The downstream UI quotes the PT range.
    const from = new Date(`${range.startDate}T00:00:00-08:00`).toISOString();
    const to = new Date(`${range.endDate}T23:59:59.999-07:00`).toISOString();

    const MAX_ROWS = 5000;
    const rows = await this.deps.conversationsRepo.loadInRange({ from, to, maxRows: MAX_ROWS });
    const truncated = rows.length >= MAX_ROWS;

    // Hydrate user emails so the response is human-readable.
    const allAuthorized = await this.deps.usersRepo.listAll();
    const emailBySlackId = new Map<string, string | null>();
    const nameBySlackId = new Map<string, string | null>();
    for (const u of allAuthorized) {
      emailBySlackId.set(u.slackUserId, u.email);
      // `name` is on AuthorizedUser but TS doesn't see it on the type yet — read defensively.
      nameBySlackId.set(u.slackUserId, (u as { name?: string | null }).name ?? null);
    }

    let resultRows: unknown[] = [];
    if (args.groupBy === 'user') {
      resultRows = aggregateByUser(rows, emailBySlackId, nameBySlackId, args.includeQuestions, args.limit);
    } else if (args.groupBy === 'tool') {
      resultRows = aggregateByTool(rows, args.limit);
    } else {
      resultRows = aggregateByDay(rows, args.limit);
    }

    return {
      period: { startDate: range.startDate, endDate: range.endDate, timezone: 'America/Los_Angeles' },
      groupBy: args.groupBy,
      totalMessages: rows.length,
      uniqueUsers: new Set(rows.map((r) => r.slackUserId)).size,
      rows: resultRows,
      ...(truncated
        ? { note: `Result truncated at ${MAX_ROWS} rows. Narrow the date range for an exact count.` }
        : {}),
    };
  }

  private async listUsers(args: ListUsersArgs) {
    const actor = this.deps.getActor();
    if (!actor) {
      return { error: { code: 'NO_ACTOR', message: 'bot.list_users requires an active actor.' } };
    }
    const callerRole = await this.deps.usersRepo.getRole(actor.slackUserId);
    if (callerRole !== 'admin') {
      logger.warn({ caller: actor.slackUserId, role: callerRole }, 'list_users denied: non-admin');
      return { error: { code: 'FORBIDDEN', message: 'Only role="admin" can list bot users.' } };
    }
    const all = await this.deps.usersRepo.listAll();
    const filtered = args.role ? all.filter((u) => u.role === args.role) : all;
    return {
      count: filtered.length,
      users: filtered.map((u) => ({
        slackUserId: u.slackUserId,
        email: u.email,
        role: u.role,
        createdAt: u.createdAt,
      })),
    };
  }

  private async updateRole(args: UpdateUserRoleArgs) {
    const actor = this.deps.getActor();
    if (!actor) {
      return { error: { code: 'NO_ACTOR', message: 'bot.update_user_role requires an active actor.' } };
    }
    const callerRole = await this.deps.usersRepo.getRole(actor.slackUserId);
    if (callerRole !== 'admin') {
      logger.warn({ caller: actor.slackUserId, role: callerRole }, 'update_user_role denied: non-admin');
      return { error: { code: 'FORBIDDEN', message: 'Only role="admin" can change roles.' } };
    }
    const result = await this.deps.usersRepo.updateRole(args.slack_user_id, args.role);
    if (!result) {
      return {
        error: {
          code: 'USER_NOT_FOUND',
          message: `No authorized user with slack id ${args.slack_user_id}. Run bot.add_user first to enable them.`,
        },
      };
    }
    logger.info(
      { caller: actor.slackUserId, target: args.slack_user_id, from: result.previousRole, to: args.role },
      'bot_role_changed',
    );
    return { ok: true as const, previous_role: result.previousRole ?? null, new_role: args.role };
  }

  private async addUser(args: AddUserArgs) {
    const actor = this.deps.getActor();
    if (!actor) {
      return { error: { code: 'NO_ACTOR', message: 'bot.add_user requires an active actor.' } };
    }
    const role = await this.deps.usersRepo.getRole(actor.slackUserId);
    if (role !== 'admin') {
      logger.warn({ caller: actor.slackUserId, role }, 'add_user denied: non-admin');
      return { error: { code: 'FORBIDDEN', message: 'Only role="admin" can enable users.' } };
    }

    let slackUserId = args.slackUserId;
    let resolvedEmail: string | null = args.email ?? null;
    if (!slackUserId) {
      if (!args.email) return { error: { code: 'INVALID_ARGS', message: 'Pass email or slackUserId.' } };
      try {
        const lookup = await this.deps.slackClient.users.lookupByEmail({ email: args.email });
        const id = (lookup as { user?: { id?: string } }).user?.id;
        if (!lookup.ok || !id) {
          return { error: { code: 'EMAIL_NOT_FOUND', message: `Slack could not find a user with email ${args.email}: ${lookup.error ?? 'unknown'}.` } };
        }
        slackUserId = id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: { code: 'EMAIL_LOOKUP_FAILED', message: msg } };
      }
    }

    // Always fetch users.info now that we know slackUserId, regardless of how
    // we got there. We extract a human-readable name (display_name >
    // real_name) and opportunistically backfill the email if it's still null
    // (preserves the previous best-effort behavior). Any error here is
    // non-fatal — we still upsert the user without a name.
    let resolvedName: string | null = null;
    try {
      const info = await this.deps.slackClient.users.info({ user: slackUserId });
      const user = (info as {
        user?: {
          profile?: { display_name?: string; real_name?: string; email?: string };
          real_name?: string;
        };
      }).user;
      const profileDisplay = user?.profile?.display_name?.trim();
      const profileReal = user?.profile?.real_name?.trim();
      const topReal = user?.real_name?.trim();
      resolvedName = profileDisplay || profileReal || topReal || null;
      if (!resolvedEmail) {
        const email = user?.profile?.email;
        if (email) resolvedEmail = email;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ slackUserId, err: msg }, 'add_user: users.info failed; proceeding without name');
    }

    const wasAuthorized = await this.deps.usersRepo.isAuthorized(slackUserId);
    const upsert = await this.deps.usersRepo.upsertUser({
      slackUserId,
      email: resolvedEmail ?? undefined,
      role: args.role,
      name: resolvedName ?? undefined,
    });

    let introSent = false;
    let introError: string | undefined;
    const shouldSendIntro = args.sendIntro && !wasAuthorized;
    if (shouldSendIntro) {
      try {
        const im = await this.deps.slackClient.conversations.open({ users: slackUserId });
        const channelId = (im as { channel?: { id?: string } })?.channel?.id;
        if (!channelId) {
          introError = 'conversations.open returned no channel id';
        } else {
          const post = await this.deps.slackClient.chat.postMessage({ channel: channelId, text: INTRO_MESSAGE });
          if (!post.ok) introError = `chat.postMessage failed: ${post.error ?? 'unknown'}`;
          else introSent = true;
        }
      } catch (err) {
        introError = err instanceof Error ? err.message : String(err);
      }
    }

    logger.info(
      { caller: actor.slackUserId, target: slackUserId, role: args.role, created: upsert.created, alreadyEnabled: wasAuthorized, introSent },
      'add_user finished',
    );

    return {
      created: upsert.created,
      alreadyEnabled: wasAuthorized,
      user: upsert.user,
      introSent,
      ...(introError ? { introError } : {}),
      notes: wasAuthorized
        ? ['User was already enabled. Updated their record (email/role) and skipped the intro DM to avoid re-pinging them.']
        : (introSent
          ? ['User enabled and intro DM sent.']
          : ['User enabled. Intro DM was not sent (sendIntro=false or delivery error).']),
    };
  }

  private async run(args: BroadcastArgs) {
    const actor = this.deps.getActor();
    if (!actor) {
      return { error: { code: 'NO_ACTOR', message: 'bot.broadcast_notification requires an active actor.' } };
    }
    // Admin gate
    const role = await this.deps.usersRepo.getRole(actor.slackUserId);
    if (role !== 'admin') {
      logger.warn({ caller: actor.slackUserId, role }, 'broadcast denied: non-admin');
      return { error: { code: 'FORBIDDEN', message: 'Only users with role="admin" in authorized_users can broadcast.' } };
    }

    const all = await this.deps.usersRepo.listAll();
    const excludeIds = new Set((args.excludeUserIds ?? []).map((s) => s.trim()).filter(Boolean));
    const excludeEmailsLower = new Set((args.excludeEmails ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean));

    const excluded: Array<{ slackUserId: string; email: string | null; reason: string }> = [];
    const recipients: Array<{ slackUserId: string; email: string | null; role: string | null }> = [];
    for (const u of all) {
      if (excludeIds.has(u.slackUserId)) {
        excluded.push({ slackUserId: u.slackUserId, email: u.email, reason: 'excluded by id' });
        continue;
      }
      if (u.email && excludeEmailsLower.has(u.email.toLowerCase())) {
        excluded.push({ slackUserId: u.slackUserId, email: u.email, reason: 'excluded by email' });
        continue;
      }
      recipients.push({ slackUserId: u.slackUserId, email: u.email, role: u.role });
    }

    const senderLabel = `<@${actor.slackUserId}>`;
    const decoratedMessage = `📣 *Broadcast from ${senderLabel}*\n\n${args.message}`;

    logger.info(
      { caller: actor.slackUserId, totalAuthorized: all.length, recipients: recipients.length, excluded: excluded.length, dryRun: args.dryRun },
      'broadcast started',
    );

    if (args.dryRun) {
      return {
        dryRun: true,
        totalAuthorized: all.length,
        recipients,
        excluded,
        message: decoratedMessage,
        notes: ['No messages were sent. Re-run with dryRun:false (or omit dryRun) to actually deliver.'],
      };
    }

    const delivered: Array<{ slackUserId: string; email: string | null; ts: string }> = [];
    const failed: Array<{ slackUserId: string; email: string | null; error: string }> = [];
    for (const r of recipients) {
      try {
        const im = await this.deps.slackClient.conversations.open({ users: r.slackUserId });
        const channelId = (im as { channel?: { id?: string } })?.channel?.id;
        if (!channelId) {
          failed.push({ slackUserId: r.slackUserId, email: r.email, error: 'conversations.open returned no channel id' });
          continue;
        }
        const post = await this.deps.slackClient.chat.postMessage({
          channel: channelId,
          text: decoratedMessage,
        });
        if (!post.ok || typeof post.ts !== 'string') {
          failed.push({ slackUserId: r.slackUserId, email: r.email, error: `chat.postMessage failed: ${post.error ?? 'unknown'}` });
          continue;
        }
        delivered.push({ slackUserId: r.slackUserId, email: r.email, ts: post.ts });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ caller: actor.slackUserId, recipient: r.slackUserId, err: msg }, 'broadcast delivery failed');
        failed.push({ slackUserId: r.slackUserId, email: r.email, error: msg });
      }
    }

    logger.info(
      { caller: actor.slackUserId, delivered: delivered.length, failed: failed.length },
      'broadcast finished',
    );

    return {
      totalAuthorized: all.length,
      delivered,
      excluded,
      failed,
      message: decoratedMessage,
    };
  }
}

/** Per-user aggregation for `bot.usage_summary` (groupBy='user'). */
function aggregateByUser(
  rows: ConversationUsageRow[],
  emailBySlackId: Map<string, string | null>,
  nameBySlackId: Map<string, string | null>,
  includeQuestions: boolean,
  limit: number,
): unknown[] {
  const buckets = new Map<
    string,
    {
      slackUserId: string;
      messages: number;
      errors: number;
      threads: Set<string>;
      tools: Map<string, number>;
      tokensInput: number;
      tokensOutput: number;
      durations: number[];
      firstAt: string;
      lastAt: string;
      questionSamples: { createdAt: string; question: string }[];
    }
  >();

  for (const r of rows) {
    let b = buckets.get(r.slackUserId);
    if (!b) {
      b = {
        slackUserId: r.slackUserId,
        messages: 0,
        errors: 0,
        threads: new Set(),
        tools: new Map(),
        tokensInput: 0,
        tokensOutput: 0,
        durations: [],
        firstAt: r.createdAt,
        lastAt: r.createdAt,
        questionSamples: [],
      };
      buckets.set(r.slackUserId, b);
    }
    b.messages += 1;
    if (r.hadError) b.errors += 1;
    if (r.tokensInput) b.tokensInput += r.tokensInput;
    if (r.tokensOutput) b.tokensOutput += r.tokensOutput;
    if (typeof r.durationMs === 'number') b.durations.push(r.durationMs);
    if (r.toolCalls && Array.isArray(r.toolCalls)) {
      for (const t of r.toolCalls) {
        if (t?.name) b.tools.set(t.name, (b.tools.get(t.name) ?? 0) + 1);
      }
    }
    if (r.createdAt < b.firstAt) b.firstAt = r.createdAt;
    if (r.createdAt > b.lastAt) b.lastAt = r.createdAt;
    if (includeQuestions) {
      b.questionSamples.push({ createdAt: r.createdAt, question: r.question });
    }
  }

  const out = Array.from(buckets.values())
    .sort((a, b) => b.messages - a.messages)
    .slice(0, limit)
    .map((b) => {
      const topTools = Array.from(b.tools.entries())
        .sort((a, c) => c[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => ({ name, count }));
      const meanDurationMs = b.durations.length
        ? Math.round(b.durations.reduce((s, x) => s + x, 0) / b.durations.length)
        : null;
      return {
        slackUserId: b.slackUserId,
        email: emailBySlackId.get(b.slackUserId) ?? null,
        name: nameBySlackId.get(b.slackUserId) ?? null,
        messages: b.messages,
        threads: b.threads.size > 0 ? b.threads.size : undefined,
        errors: b.errors,
        topTools,
        tokensInput: b.tokensInput,
        tokensOutput: b.tokensOutput,
        meanDurationMs,
        firstAt: b.firstAt,
        lastAt: b.lastAt,
        ...(includeQuestions
          ? {
              recentQuestions: b.questionSamples
                .sort((a, c) => (a.createdAt > c.createdAt ? -1 : 1))
                .slice(0, 5)
                .map((q) => ({
                  createdAt: q.createdAt,
                  question: q.question.length > 120 ? `${q.question.slice(0, 117)}...` : q.question,
                })),
            }
          : {}),
      };
    });
  return out;
}

/** Per-tool aggregation for `bot.usage_summary` (groupBy='tool'). */
function aggregateByTool(rows: ConversationUsageRow[], limit: number): unknown[] {
  const counts = new Map<string, { calls: number; errors: number; users: Set<string> }>();
  for (const r of rows) {
    if (!r.toolCalls || !Array.isArray(r.toolCalls)) continue;
    for (const t of r.toolCalls) {
      if (!t?.name) continue;
      let c = counts.get(t.name);
      if (!c) {
        c = { calls: 0, errors: 0, users: new Set() };
        counts.set(t.name, c);
      }
      c.calls += 1;
      if (t.ok === false) c.errors += 1;
      c.users.add(r.slackUserId);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, limit)
    .map(([name, c]) => ({ name, calls: c.calls, errors: c.errors, uniqueUsers: c.users.size }));
}

/** Per-day aggregation for `bot.usage_summary` (groupBy='day'). */
function aggregateByDay(rows: ConversationUsageRow[], limit: number): unknown[] {
  const buckets = new Map<string, { day: string; messages: number; users: Set<string>; errors: number }>();
  for (const r of rows) {
    const day = r.createdAt.slice(0, 10); // YYYY-MM-DD (UTC) — good enough for daily trend.
    let b = buckets.get(day);
    if (!b) {
      b = { day, messages: 0, users: new Set(), errors: 0 };
      buckets.set(day, b);
    }
    b.messages += 1;
    if (r.hadError) b.errors += 1;
    b.users.add(r.slackUserId);
  }
  return Array.from(buckets.values())
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, limit)
    .map((b) => ({ day: b.day, messages: b.messages, uniqueUsers: b.users.size, errors: b.errors }));
}
