import { z } from 'zod';
import type { WebClient } from '@slack/web-api';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import type { AuthorizedUsersRepo } from '../../storage/repositories/authorized-users.js';
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
  role: z.enum(['user', 'admin']).default('user').describe('"user" (default) or "admin". Admins can call broadcast and add_user themselves.'),
  sendIntro: z.boolean().default(true).describe('Whether to DM the new user the standard intro message after enabling. Default true.'),
}).refine((v) => Boolean(v.email || v.slackUserId), { message: 'Provide email or slackUserId.' });
type AddUserArgs = z.infer<typeof AddUserArgs>;

export interface BroadcastConnectorDeps {
  slackClient: WebClient;
  usersRepo: AuthorizedUsersRepo;
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
        'Optional `role` (default "user", set to "admin" to also grant broadcast/add-user privileges).',
        'Optional `sendIntro` (default true). Set to false if the user already knows the bot and just needs allowlist access.',
        'Idempotent — calling on an already-enabled user updates their email/role and (by default) does NOT re-DM the intro. Returns `{created: true|false, alreadyEnabled, user, introSent}`.',
        'Use when the operator says: "give X access to the bot", "add lana@gantri.com to the bot", "enable Ian", "habilita a Pedro", "add as admin".',
      ].join(' '),
      schema: AddUserArgs as z.ZodType<AddUserArgs>,
      jsonSchema: zodToJsonSchema(AddUserArgs),
      execute: (args) => this.addUser(args),
    };
    return [broadcast, addUser];
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
    } else if (!resolvedEmail) {
      // Best-effort: backfill the email from Slack so we store it.
      try {
        const info = await this.deps.slackClient.users.info({ user: slackUserId });
        const email = (info as { user?: { profile?: { email?: string } } }).user?.profile?.email;
        if (email) resolvedEmail = email;
      } catch {
        // Non-fatal; continue without email.
      }
    }

    const wasAuthorized = await this.deps.usersRepo.isAuthorized(slackUserId);
    const upsert = await this.deps.usersRepo.upsertUser({
      slackUserId,
      email: resolvedEmail ?? undefined,
      role: args.role,
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
