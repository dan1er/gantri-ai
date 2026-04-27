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

  const conn = new BroadcastConnector({
    slackClient: slackClient as any,
    usersRepo: usersRepo as any,
    getActor: () => ({ slackUserId: actorUid }),
  });
  return { conn, slackClient, usersRepo };
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
});
