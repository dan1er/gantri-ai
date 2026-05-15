import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BroadcastConnector } from '../../../../src/connectors/broadcast/broadcast-connector.js';
import { INTRO_MESSAGE } from '../../../../src/connectors/broadcast/intro-message.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type User = {
  slackUserId: string;
  email: string | null;
  role: string | null;
  createdAt?: string | null;
};

function makeUsersRepo(users: User[], callerRole: string | null = 'admin') {
  return {
    getRole: vi.fn(async (uid: string) => {
      // Caller check; for simplicity: first call to getRole returns callerRole.
      // The repo is also consulted per-user, so we keep a map.
      const found = users.find((u) => u.slackUserId === uid);
      return found ? found.role : callerRole;
    }),
    isAuthorized: vi.fn(async (uid: string) => users.some((u) => u.slackUserId === uid)),
    listAll: vi.fn(async () => users),
    upsertUser: vi.fn(async (input: { slackUserId: string; email?: string; role: string }) => ({
      created: !users.some((u) => u.slackUserId === input.slackUserId),
      user: { slackUserId: input.slackUserId, email: input.email ?? null, role: input.role },
    })),
    updateRole: vi.fn(async (uid: string, role: string) => {
      const found = users.find((u) => u.slackUserId === uid);
      if (!found) return null;
      const previousRole = found.role;
      found.role = role;
      return { previousRole };
    }),
  };
}

function makeSlackClient() {
  const conversationsOpen = vi.fn(async () => ({ ok: true, channel: { id: 'D_CHAN' } }));
  const chatPostMessage = vi.fn(async () => ({ ok: true, ts: '111.222' }));
  const usersLookupByEmail = vi.fn(async () => ({ ok: true, user: { id: 'U_LOOKED_UP' } }));
  const usersInfo = vi.fn(async () => ({ ok: true, user: { profile: { email: 'info@gantri.com' } } }));
  const authTest = vi.fn(async () => ({ ok: true, user_id: 'U_BOT' }));

  return {
    conversations: { open: conversationsOpen },
    chat: { postMessage: chatPostMessage },
    users: { lookupByEmail: usersLookupByEmail, info: usersInfo },
    auth: { test: authTest },
  };
}

function makeDeps(opts: {
  users: User[];
  callerRole?: string | null;
  actorUid?: string;
  slackClient?: ReturnType<typeof makeSlackClient>;
  conversationRows?: any[];
  maintainerSlackUserId?: string;
}) {
  const slackClient = opts.slackClient ?? makeSlackClient();
  const usersRepo = makeUsersRepo(opts.users, opts.callerRole ?? 'admin');
  const actorUid = opts.actorUid ?? 'U_ADMIN';

  // Make getRole specifically return the callerRole for the actor uid.
  usersRepo.getRole.mockImplementation(async (uid: string) => {
    if (uid === actorUid) return opts.callerRole ?? 'admin';
    const found = opts.users.find((u) => u.slackUserId === uid);
    return found ? found.role : null;
  });

  const conversationsRepo = {
    insert: vi.fn(async () => 'conv-id'),
    loadRecentByThread: vi.fn(async () => []),
    loadInRange: vi.fn(async () => opts.conversationRows ?? []),
  };

  const conn = new BroadcastConnector({
    slackClient: slackClient as any,
    usersRepo: usersRepo as any,
    conversationsRepo: conversationsRepo as any,
    maintainerSlackUserId: opts.maintainerSlackUserId,
    getActor: () => ({ slackUserId: actorUid }),
  });
  return { conn, slackClient, usersRepo, conversationsRepo };
}

function getTool(conn: BroadcastConnector, name: string) {
  const tool = conn.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

// ---------------------------------------------------------------------------
// broadcast_notification tests
// ---------------------------------------------------------------------------

describe('BroadcastConnector → bot.broadcast_notification', () => {
  const threeUsers: User[] = [
    { slackUserId: 'U1', email: 'alice@gantri.com', role: 'user' },
    { slackUserId: 'U2', email: 'bob@gantri.com', role: 'user' },
    { slackUserId: 'U3', email: 'carol@gantri.com', role: 'admin' },
  ];

  it('non-admin caller → returns FORBIDDEN, no posts', async () => {
    const { conn, slackClient } = makeDeps({ users: threeUsers, callerRole: 'user' });
    const tool = getTool(conn, 'bot.broadcast_notification');
    const args = tool.schema.parse({ message: 'hello' });
    const res: any = await tool.execute(args);
    expect(res.error.code).toBe('FORBIDDEN');
    expect(slackClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('admin + dryRun:true → returns preview, postMessage never called', async () => {
    const { conn, slackClient } = makeDeps({ users: threeUsers, callerRole: 'admin', actorUid: 'U3' });
    const tool = getTool(conn, 'bot.broadcast_notification');
    const args = tool.schema.parse({ message: 'test message', dryRun: true });
    const res: any = await tool.execute(args);
    expect(res.dryRun).toBe(true);
    expect(res.totalAuthorized).toBe(3);
    expect(Array.isArray(res.recipients)).toBe(true);
    expect(Array.isArray(res.excluded)).toBe(true);
    expect(typeof res.message).toBe('string');
    expect(slackClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('admin + dryRun:false + excludeUserIds=[U1] → posts to 2 users', async () => {
    const { conn, slackClient } = makeDeps({ users: threeUsers, callerRole: 'admin', actorUid: 'U3' });
    const tool = getTool(conn, 'bot.broadcast_notification');
    const args = tool.schema.parse({ message: 'broadcast msg', dryRun: false, excludeUserIds: ['U1'] });
    const res: any = await tool.execute(args);
    expect(res.delivered).toHaveLength(2);
    const deliveredIds = res.delivered.map((d: any) => d.slackUserId);
    expect(deliveredIds).toContain('U2');
    expect(deliveredIds).toContain('U3');
    expect(deliveredIds).not.toContain('U1');
    expect(res.excluded).toHaveLength(1);
    expect(res.excluded[0].slackUserId).toBe('U1');
    expect(res.excluded[0].reason).toBe('excluded by id');
  });

  it('excludeEmails is case-insensitive', async () => {
    const { conn, slackClient } = makeDeps({ users: threeUsers, callerRole: 'admin', actorUid: 'U3' });
    const tool = getTool(conn, 'bot.broadcast_notification');
    // alice@gantri.com should be excluded despite mixed case in the argument
    const args = tool.schema.parse({ message: 'hi', dryRun: false, excludeEmails: ['Alice@Gantri.COM'] });
    const res: any = await tool.execute(args);
    expect(res.excluded).toHaveLength(1);
    expect(res.excluded[0].slackUserId).toBe('U1');
    expect(res.excluded[0].reason).toBe('excluded by email');
    expect(res.delivered.map((d: any) => d.slackUserId)).not.toContain('U1');
  });

  it('postMessage returning {ok:false} goes into failed array, does not crash', async () => {
    const slackClient = makeSlackClient();
    // First call succeeds, second fails
    slackClient.chat.postMessage
      .mockResolvedValueOnce({ ok: true, ts: '1.1' })
      .mockResolvedValueOnce({ ok: false, error: 'message_too_long' });
    const { conn } = makeDeps({ users: threeUsers, callerRole: 'admin', actorUid: 'U3', slackClient });
    const tool = getTool(conn, 'bot.broadcast_notification');
    const args = tool.schema.parse({ message: 'hi', dryRun: false });
    const res: any = await tool.execute(args);
    // 3 users total, U3 is the actor AND a recipient
    // One delivered, one failed (second postMessage call)
    expect(res.failed.length).toBeGreaterThanOrEqual(1);
    expect(res.failed[0].error).toMatch(/message_too_long|chat\.postMessage failed/);
  });

  it('message is prefixed with "📣 *Broadcast from <@SENDER_ID>*"', async () => {
    const { conn, slackClient } = makeDeps({ users: threeUsers, callerRole: 'admin', actorUid: 'U3' });
    const tool = getTool(conn, 'bot.broadcast_notification');
    const args = tool.schema.parse({ message: 'hello team', dryRun: true });
    const res: any = await tool.execute(args);
    expect(res.message).toMatch(/^📣 \*Broadcast from <@U3>\*/);
    expect(res.message).toContain('hello team');
  });

  it('dryRun:false delivers the decorated message text via Slack', async () => {
    const slackClient = makeSlackClient();
    const { conn } = makeDeps({
      users: [{ slackUserId: 'U2', email: 'bob@gantri.com', role: 'user' }],
      callerRole: 'admin',
      actorUid: 'U_ADMIN',
      slackClient,
    });
    const tool = getTool(conn, 'bot.broadcast_notification');
    const args = tool.schema.parse({ message: 'important update', dryRun: false });
    const res: any = await tool.execute(args);
    expect(res.delivered).toHaveLength(1);
    const sentText: string = slackClient.chat.postMessage.mock.calls[0][0].text;
    expect(sentText).toContain('📣');
    expect(sentText).toContain('important update');
  });
});

// ---------------------------------------------------------------------------
// add_user tests
// ---------------------------------------------------------------------------

describe('BroadcastConnector → bot.add_user', () => {
  it('non-admin → FORBIDDEN', async () => {
    const { conn } = makeDeps({ users: [], callerRole: 'user' });
    const tool = getTool(conn, 'bot.add_user');
    const args = tool.schema.parse({ email: 'new@gantri.com' });
    const res: any = await tool.execute(args);
    expect(res.error.code).toBe('FORBIDDEN');
  });

  it('email provided → lookupByEmail called, user upserted with resolved slackUserId, intro DM sent', async () => {
    const slackClient = makeSlackClient();
    slackClient.users.lookupByEmail.mockResolvedValue({ ok: true, user: { id: 'U999' } });

    const { conn, usersRepo } = makeDeps({ users: [], callerRole: 'admin', slackClient });
    const tool = getTool(conn, 'bot.add_user');
    const args = tool.schema.parse({ email: 'lana@gantri.com', sendIntro: true });
    const res: any = await tool.execute(args);

    expect(slackClient.users.lookupByEmail).toHaveBeenCalledWith({ email: 'lana@gantri.com' });
    expect(usersRepo.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ slackUserId: 'U999', email: 'lana@gantri.com', role: 'user' }),
    );
    expect(res.introSent).toBe(true);
    expect(slackClient.chat.postMessage).toHaveBeenCalled();
  });

  it('user already in authorized_users → introSent=false, alreadyEnabled=true', async () => {
    const existingUsers: User[] = [{ slackUserId: 'U999', email: 'lana@gantri.com', role: 'user' }];
    const slackClient = makeSlackClient();
    slackClient.users.lookupByEmail.mockResolvedValue({ ok: true, user: { id: 'U999' } });

    const { conn } = makeDeps({ users: existingUsers, callerRole: 'admin', slackClient });
    const tool = getTool(conn, 'bot.add_user');
    const args = tool.schema.parse({ email: 'lana@gantri.com', sendIntro: true });
    const res: any = await tool.execute(args);

    expect(res.alreadyEnabled).toBe(true);
    expect(res.introSent).toBe(false);
    expect(slackClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('slackUserId provided directly (no email lookup)', async () => {
    const slackClient = makeSlackClient();
    slackClient.users.info.mockResolvedValue({ ok: true, user: { profile: { email: 'direct@gantri.com' } } });

    const { conn, usersRepo } = makeDeps({ users: [], callerRole: 'admin', slackClient });
    const tool = getTool(conn, 'bot.add_user');
    const args = tool.schema.parse({ slackUserId: 'U_DIRECT' });
    const res: any = await tool.execute(args);

    expect(slackClient.users.lookupByEmail).not.toHaveBeenCalled();
    expect(usersRepo.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ slackUserId: 'U_DIRECT' }),
    );
    expect(res.introSent).toBe(true);
  });

  it('email lookup fails (ok:false) → EMAIL_NOT_FOUND error', async () => {
    const slackClient = makeSlackClient();
    slackClient.users.lookupByEmail.mockResolvedValue({ ok: false, error: 'users_not_found' });

    const { conn } = makeDeps({ users: [], callerRole: 'admin', slackClient });
    const tool = getTool(conn, 'bot.add_user');
    const args = tool.schema.parse({ email: 'ghost@nowhere.com' });
    const res: any = await tool.execute(args);

    expect(res.error.code).toBe('EMAIL_NOT_FOUND');
  });

  it('sendIntro:false → postMessage not called', async () => {
    const slackClient = makeSlackClient();
    slackClient.users.lookupByEmail.mockResolvedValue({ ok: true, user: { id: 'U777' } });

    const { conn } = makeDeps({ users: [], callerRole: 'admin', slackClient });
    const tool = getTool(conn, 'bot.add_user');
    const args = tool.schema.parse({ email: 'quiet@gantri.com', sendIntro: false });
    const res: any = await tool.execute(args);

    expect(res.introSent).toBe(false);
    expect(slackClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('role:admin is persisted via upsertUser', async () => {
    const slackClient = makeSlackClient();
    slackClient.users.lookupByEmail.mockResolvedValue({ ok: true, user: { id: 'U888' } });

    const { conn, usersRepo } = makeDeps({ users: [], callerRole: 'admin', slackClient });
    const tool = getTool(conn, 'bot.add_user');
    const args = tool.schema.parse({ email: 'boss@gantri.com', role: 'admin', sendIntro: false });
    await tool.execute(args);

    expect(usersRepo.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
    );
  });

  it('admin caller can pass role=marketing through to upsertUser', async () => {
    const slackClient = makeSlackClient();
    slackClient.users.lookupByEmail.mockResolvedValue({ ok: true, user: { id: 'U_MKT' } });

    const { conn, usersRepo } = makeDeps({ users: [], callerRole: 'admin', slackClient });
    const tool = getTool(conn, 'bot.add_user');
    // The Zod schema must accept 'marketing' for this parse to succeed.
    const args = tool.schema.parse({ email: 'lana@gantri.com', role: 'marketing', sendIntro: false });
    const res: any = await tool.execute(args);

    expect(res.error).toBeUndefined();
    expect(usersRepo.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'marketing' }),
    );
  });

  it('always calls users.info and forwards profile.display_name as name (even when email path is used)', async () => {
    const slackClient = makeSlackClient();
    slackClient.users.lookupByEmail.mockResolvedValue({ ok: true, user: { id: 'U_BROOK' } });
    // Mirrors the brooklyn@gantri.com case from the live workspace: display_name
    // diverges from real_name. We want display_name.
    slackClient.users.info.mockResolvedValue({
      ok: true,
      user: {
        real_name: 'Brooklyn S.',
        profile: {
          display_name: 'Zuzanna (Brooklyn S.)',
          real_name: 'Brooklyn S.',
          email: 'brooklyn@gantri.com',
        },
      },
    });

    const { conn, usersRepo } = makeDeps({ users: [], callerRole: 'admin', slackClient });
    const tool = getTool(conn, 'bot.add_user');
    const args = tool.schema.parse({ email: 'brooklyn@gantri.com', sendIntro: false });
    await tool.execute(args);

    expect(slackClient.users.info).toHaveBeenCalledWith({ user: 'U_BROOK' });
    expect(usersRepo.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ slackUserId: 'U_BROOK', name: 'Zuzanna (Brooklyn S.)' }),
    );
  });

  it('falls back to profile.real_name when display_name is empty', async () => {
    const slackClient = makeSlackClient();
    slackClient.users.info.mockResolvedValue({
      ok: true,
      user: {
        real_name: 'Top Level Name',
        profile: { display_name: '', real_name: 'Profile Real Name', email: 'x@gantri.com' },
      },
    });

    const { conn, usersRepo } = makeDeps({ users: [], callerRole: 'admin', slackClient });
    const tool = getTool(conn, 'bot.add_user');
    const args = tool.schema.parse({ slackUserId: 'U_FALLBACK', sendIntro: false });
    await tool.execute(args);

    expect(usersRepo.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ slackUserId: 'U_FALLBACK', name: 'Profile Real Name' }),
    );
  });

  it('falls back to top-level real_name when both profile fields are empty', async () => {
    const slackClient = makeSlackClient();
    slackClient.users.info.mockResolvedValue({
      ok: true,
      user: {
        real_name: 'Top Level Name',
        profile: { display_name: '', real_name: '', email: null },
      },
    });

    const { conn, usersRepo } = makeDeps({ users: [], callerRole: 'admin', slackClient });
    const tool = getTool(conn, 'bot.add_user');
    const args = tool.schema.parse({ slackUserId: 'U_TOP', sendIntro: false });
    await tool.execute(args);

    expect(usersRepo.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ slackUserId: 'U_TOP', name: 'Top Level Name' }),
    );
  });

  it('users.info failure does not break add_user — name is just omitted', async () => {
    const slackClient = makeSlackClient();
    slackClient.users.lookupByEmail.mockResolvedValue({ ok: true, user: { id: 'U_OOPS' } });
    slackClient.users.info.mockRejectedValue(new Error('slack down'));

    const { conn, usersRepo } = makeDeps({ users: [], callerRole: 'admin', slackClient });
    const tool = getTool(conn, 'bot.add_user');
    const args = tool.schema.parse({ email: 'foo@gantri.com', sendIntro: false });
    const res: any = await tool.execute(args);

    expect(res.error).toBeUndefined();
    const callArgs = usersRepo.upsertUser.mock.calls[0][0];
    expect(callArgs.slackUserId).toBe('U_OOPS');
    expect(callArgs.name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// update_user_role tests
// ---------------------------------------------------------------------------

describe('BroadcastConnector → bot.update_user_role', () => {
  it('admin can promote user → marketing', async () => {
    const targetUsers: User[] = [
      { slackUserId: 'U_target', email: 'lana@gantri.com', role: 'user' },
    ];
    const { conn, usersRepo } = makeDeps({ users: targetUsers, callerRole: 'admin', actorUid: 'U_admin' });
    const tool = getTool(conn, 'bot.update_user_role');
    const args = tool.schema.parse({ slack_user_id: 'U_target', role: 'marketing' });
    const res: any = await tool.execute(args);

    expect(res.ok).toBe(true);
    expect(res.previous_role).toBe('user');
    expect(res.new_role).toBe('marketing');
    expect(usersRepo.updateRole).toHaveBeenCalledWith('U_target', 'marketing');
  });

  it('FORBIDDEN for non-admin caller', async () => {
    const { conn, usersRepo } = makeDeps({ users: [], callerRole: 'marketing', actorUid: 'U_caller' });
    const tool = getTool(conn, 'bot.update_user_role');
    const args = tool.schema.parse({ slack_user_id: 'U_target', role: 'admin' });
    const res: any = await tool.execute(args);

    expect(res.error.code).toBe('FORBIDDEN');
    expect(usersRepo.updateRole).not.toHaveBeenCalled();
  });

  it('USER_NOT_FOUND when target does not exist', async () => {
    // No users in repo → updateRole mock returns null.
    const { conn } = makeDeps({ users: [], callerRole: 'admin', actorUid: 'U_admin' });
    const tool = getTool(conn, 'bot.update_user_role');
    const args = tool.schema.parse({ slack_user_id: 'U_missing', role: 'marketing' });
    const res: any = await tool.execute(args);

    expect(res.error.code).toBe('USER_NOT_FOUND');
  });

  it('NO_ACTOR when no actor in context', async () => {
    const usersRepo = makeUsersRepo([], 'admin');
    const conn = new BroadcastConnector({
      slackClient: makeSlackClient() as any,
      usersRepo: usersRepo as any,
      getActor: () => undefined,
    });
    const tool = getTool(conn, 'bot.update_user_role');
    const args = tool.schema.parse({ slack_user_id: 'U_target', role: 'marketing' });
    const res: any = await tool.execute(args);

    expect(res.error.code).toBe('NO_ACTOR');
    expect(usersRepo.updateRole).not.toHaveBeenCalled();
  });

  it('rejects unknown role values at the schema layer', () => {
    const { conn } = makeDeps({ users: [], callerRole: 'admin' });
    const tool = getTool(conn, 'bot.update_user_role');
    expect(() => tool.schema.parse({ slack_user_id: 'U_target', role: 'wizard' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// list_users tests
// ---------------------------------------------------------------------------

describe('BroadcastConnector → bot.list_users', () => {
  const fiveUsers: User[] = [
    { slackUserId: 'U_DANNY', email: 'danny@gantri.com', role: 'admin', createdAt: '2026-01-01T00:00:00.000Z' },
    { slackUserId: 'U_LANA', email: 'lana@gantri.com', role: 'user', createdAt: '2026-01-02T00:00:00.000Z' },
    { slackUserId: 'U_JEN', email: 'jen@gantri.com', role: 'marketing', createdAt: '2026-01-03T00:00:00.000Z' },
    { slackUserId: 'U_STEPH', email: 'steph@gantri.com', role: 'marketing', createdAt: '2026-01-04T00:00:00.000Z' },
    { slackUserId: 'U_LEGACY', email: null, role: 'user', createdAt: null },
  ];

  it('admin caller → returns all users with role + email + createdAt', async () => {
    const { conn } = makeDeps({ users: fiveUsers, callerRole: 'admin' });
    const tool = getTool(conn, 'bot.list_users');
    const res: any = await tool.execute({});
    expect(res.count).toBe(5);
    expect(res.users).toEqual([
      { slackUserId: 'U_DANNY', email: 'danny@gantri.com', role: 'admin', createdAt: '2026-01-01T00:00:00.000Z' },
      { slackUserId: 'U_LANA', email: 'lana@gantri.com', role: 'user', createdAt: '2026-01-02T00:00:00.000Z' },
      { slackUserId: 'U_JEN', email: 'jen@gantri.com', role: 'marketing', createdAt: '2026-01-03T00:00:00.000Z' },
      { slackUserId: 'U_STEPH', email: 'steph@gantri.com', role: 'marketing', createdAt: '2026-01-04T00:00:00.000Z' },
      { slackUserId: 'U_LEGACY', email: null, role: 'user', createdAt: null },
    ]);
  });

  it('role filter narrows the result set', async () => {
    const { conn } = makeDeps({ users: fiveUsers, callerRole: 'admin' });
    const tool = getTool(conn, 'bot.list_users');
    const res: any = await tool.execute({ role: 'marketing' });
    expect(res.count).toBe(2);
    expect(res.users.map((u: any) => u.slackUserId)).toEqual(['U_JEN', 'U_STEPH']);
  });

  it('non-admin caller → FORBIDDEN, no DB read for the list', async () => {
    const { conn, usersRepo } = makeDeps({ users: fiveUsers, callerRole: 'user' });
    const tool = getTool(conn, 'bot.list_users');
    const res: any = await tool.execute({});
    expect(res.error?.code).toBe('FORBIDDEN');
    expect(usersRepo.listAll).not.toHaveBeenCalled();
  });

  it('NO_ACTOR when no actor in context', async () => {
    const { conn } = makeDeps({ users: fiveUsers, callerRole: 'admin' });
    // override the actor getter to return undefined
    (conn as any).deps.getActor = () => undefined;
    const tool = getTool(conn, 'bot.list_users');
    const res: any = await tool.execute({});
    expect(res.error?.code).toBe('NO_ACTOR');
  });

  it('rejects unknown role filter at the schema layer', () => {
    const { conn } = makeDeps({ users: fiveUsers, callerRole: 'admin' });
    const tool = getTool(conn, 'bot.list_users');
    expect(() => tool.schema.parse({ role: 'wizard' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// usage_summary tests
// ---------------------------------------------------------------------------

describe('BroadcastConnector → bot.usage_summary', () => {
  const sampleRows = [
    { slackUserId: 'U_DANNY', question: 'orders last week', toolCalls: [{ name: 'gantri.orders_query', ok: true }], model: 'sonnet', tokensInput: 100, tokensOutput: 50, durationMs: 1500, hadError: false, createdAt: '2026-05-14T15:00:00Z' },
    { slackUserId: 'U_DANNY', question: 'how many active customers', toolCalls: [{ name: 'gantri.order_stats', ok: true }], model: 'sonnet', tokensInput: 120, tokensOutput: 60, durationMs: 1800, hadError: false, createdAt: '2026-05-14T16:00:00Z' },
    { slackUserId: 'U_BROOK', question: 'modify email on order 43785', toolCalls: [{ name: 'gantri.update_customer_email', ok: true }], model: 'sonnet', tokensInput: 200, tokensOutput: 80, durationMs: 2500, hadError: false, createdAt: '2026-05-13T10:00:00Z' },
    { slackUserId: 'U_BROOK', question: 'broken query', toolCalls: null, model: 'sonnet', tokensInput: 80, tokensOutput: 20, durationMs: 500, hadError: true, createdAt: '2026-05-12T09:00:00Z' },
  ];

  it('non-maintainer caller is forbidden (even when role=admin)', async () => {
    const { conn } = makeDeps({
      users: [{ slackUserId: 'U_OTHER_ADMIN', email: 'admin@gantri.com', role: 'admin', createdAt: 't' }],
      callerRole: 'admin',
      actorUid: 'U_OTHER_ADMIN',
      maintainerSlackUserId: 'U_DANNY',
      conversationRows: sampleRows,
    });
    const tool = getTool(conn, 'bot.usage_summary');
    const result: any = await tool.execute({ groupBy: 'user', limit: 50, includeQuestions: false });
    expect(result.error?.code).toBe('FORBIDDEN');
  });

  it('returns MAINTAINER_NOT_CONFIGURED when env var is unset', async () => {
    const { conn } = makeDeps({
      users: [],
      callerRole: 'admin',
      actorUid: 'U_DANNY',
      maintainerSlackUserId: undefined,
      conversationRows: sampleRows,
    });
    const tool = getTool(conn, 'bot.usage_summary');
    const result: any = await tool.execute({ groupBy: 'user', limit: 50, includeQuestions: false });
    expect(result.error?.code).toBe('MAINTAINER_NOT_CONFIGURED');
  });

  it('maintainer can call and gets a per-user aggregate sorted by message count', async () => {
    const { conn, conversationsRepo } = makeDeps({
      users: [
        { slackUserId: 'U_DANNY', email: 'danny@gantri.com', role: 'admin', createdAt: 't' },
        { slackUserId: 'U_BROOK', email: 'brooklyn@gantri.com', role: 'cx', createdAt: 't' },
      ],
      callerRole: 'admin',
      actorUid: 'U_DANNY',
      maintainerSlackUserId: 'U_DANNY',
      conversationRows: sampleRows,
    });
    const tool = getTool(conn, 'bot.usage_summary');
    const result: any = await tool.execute({ groupBy: 'user', limit: 50, includeQuestions: false });
    expect(result.error).toBeUndefined();
    expect(result.totalMessages).toBe(4);
    expect(result.uniqueUsers).toBe(2);
    expect(result.rows).toHaveLength(2);
    // Both users have 2 messages each — order ties; just assert content correctness.
    const danny = result.rows.find((r: any) => r.slackUserId === 'U_DANNY');
    expect(danny.email).toBe('danny@gantri.com');
    expect(danny.messages).toBe(2);
    expect(danny.errors).toBe(0);
    expect(danny.topTools.map((t: any) => t.name).sort()).toEqual(['gantri.order_stats', 'gantri.orders_query']);
    const brook = result.rows.find((r: any) => r.slackUserId === 'U_BROOK');
    expect(brook.errors).toBe(1);
    expect(conversationsRepo.loadInRange).toHaveBeenCalledOnce();
  });

  it('groupBy=tool returns calls per tool name', async () => {
    const { conn } = makeDeps({
      users: [],
      callerRole: 'admin',
      actorUid: 'U_DANNY',
      maintainerSlackUserId: 'U_DANNY',
      conversationRows: sampleRows,
    });
    const tool = getTool(conn, 'bot.usage_summary');
    const result: any = await tool.execute({ groupBy: 'tool', limit: 50, includeQuestions: false });
    expect(result.error).toBeUndefined();
    expect(result.rows.map((r: any) => r.name).sort()).toEqual(['gantri.order_stats', 'gantri.orders_query', 'gantri.update_customer_email']);
    const ucEmail = result.rows.find((r: any) => r.name === 'gantri.update_customer_email');
    expect(ucEmail.calls).toBe(1);
    expect(ucEmail.uniqueUsers).toBe(1);
  });

  it('groupBy=day buckets by YYYY-MM-DD and sorts newest first', async () => {
    const { conn } = makeDeps({
      users: [],
      callerRole: 'admin',
      actorUid: 'U_DANNY',
      maintainerSlackUserId: 'U_DANNY',
      conversationRows: sampleRows,
    });
    const tool = getTool(conn, 'bot.usage_summary');
    const result: any = await tool.execute({ groupBy: 'day', limit: 50, includeQuestions: false });
    expect(result.error).toBeUndefined();
    expect(result.rows.map((r: any) => r.day)).toEqual(['2026-05-14', '2026-05-13', '2026-05-12']);
    expect(result.rows[0].messages).toBe(2);
  });

  it('includeQuestions=true returns truncated question snippets', async () => {
    const longQ = 'a'.repeat(200);
    const { conn } = makeDeps({
      users: [],
      callerRole: 'admin',
      actorUid: 'U_DANNY',
      maintainerSlackUserId: 'U_DANNY',
      conversationRows: [
        { slackUserId: 'U_DANNY', question: longQ, toolCalls: null, model: 'sonnet', tokensInput: 0, tokensOutput: 0, durationMs: 0, hadError: false, createdAt: '2026-05-14T15:00:00Z' },
      ],
    });
    const tool = getTool(conn, 'bot.usage_summary');
    const result: any = await tool.execute({ groupBy: 'user', limit: 50, includeQuestions: true });
    expect(result.rows[0].recentQuestions[0].question).toMatch(/\.\.\.$/);
    expect(result.rows[0].recentQuestions[0].question.length).toBe(120);
  });
});
