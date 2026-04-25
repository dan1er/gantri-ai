import { describe, it, expect, vi } from 'vitest';
import { FeedbackConnector } from '../../../../src/connectors/feedback/feedback-connector.js';

function fakeDeps(actorUidGetter: () => string, maintainer = 'M_ID') {
  const rows: any[] = [];
  const repo = {
    insert: vi.fn(async (input: any) => {
      const row = {
        id: `id-${rows.length + 1}`,
        ...input,
        status: 'open',
        resolution: null,
        resolved_at: null,
        created_at: 'now',
        updated_at: 'now',
      };
      rows.push(row);
      return row;
    }),
    getById: vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
    update: vi.fn(async (id: string, fields: any) => {
      const row = rows.find((r) => r.id === id);
      Object.assign(row, fields, { updated_at: 'now' });
      return row;
    }),
    listOpen: vi.fn(async () => rows.filter((r) => r.status === 'open' || r.status === 'investigating')),
  };
  const conversationsRepo = {
    loadRecentByThread: vi.fn(async () => [{ question: 'hello', response: 'hi' }]),
  };
  const postedMessages: any[] = [];
  const slackClient = {
    conversations: { open: vi.fn(async () => ({ ok: true, channel: { id: 'D_FAKE' } })) },
    chat: {
      postMessage: vi.fn(async (msg: any) => {
        postedMessages.push(msg);
        return { ok: true };
      }),
      getPermalink: vi.fn(async () => ({ ok: true, permalink: 'https://slack/perma' })),
    },
  };
  const conn = new FeedbackConnector({
    repo: repo as any,
    conversationsRepo: conversationsRepo as any,
    slackClient: slackClient as any,
    maintainerSlackUserId: maintainer,
    getActor: () => ({ slackUserId: actorUidGetter() }),
    getThread: () => ({ channelId: 'C1', threadTs: '1234.5678' }),
  });
  return { conn, repo, slackClient, postedMessages };
}

describe('FeedbackConnector', () => {
  it('flag_response inserts a row, attributes to caller, and DMs the maintainer', async () => {
    const { conn, repo, postedMessages } = fakeDeps(() => 'U_REPORTER');
    const tool = conn.tools.find((t) => t.name === 'feedback.flag_response')!;
    const res: any = await tool.execute({ reason: 'totals do not match' });
    expect(res.feedback.id).toMatch(/^id-/);
    expect(repo.insert.mock.calls[0][0].reporter_slack_user_id).toBe('U_REPORTER');
    expect(repo.insert.mock.calls[0][0].reason).toBe('totals do not match');
    // Wait for async DM to fire.
    await new Promise((r) => setTimeout(r, 5));
    expect(postedMessages.length).toBeGreaterThanOrEqual(1);
    expect(postedMessages[0].text).toMatch(/U_REPORTER/);
  });

  it('resolve rejects non-maintainer callers', async () => {
    const { conn } = fakeDeps(() => 'U_NOT_MAINTAINER');
    const flagTool = conn.tools.find((t) => t.name === 'feedback.flag_response')!;
    const flagged: any = await flagTool.execute({ reason: 'x' });
    const resolveTool = conn.tools.find((t) => t.name === 'feedback.resolve')!;
    const res: any = await resolveTool.execute({ id: flagged.feedback.id, resolution: 'fixed' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('FORBIDDEN');
  });

  it('resolve as maintainer closes the report and DMs the reporter', async () => {
    let actor = 'U_REPORTER';
    const { conn, postedMessages } = fakeDeps(() => actor, 'M_ID');
    // 1. Reporter flags.
    actor = 'U_REPORTER';
    const flagTool = conn.tools.find((t) => t.name === 'feedback.flag_response')!;
    const flagged: any = await flagTool.execute({ reason: 'x' });
    // 2. Maintainer resolves.
    actor = 'M_ID';
    const resolveTool = conn.tools.find((t) => t.name === 'feedback.resolve')!;
    const res: any = await resolveTool.execute({ id: flagged.feedback.id, resolution: 'fixed by switching tools' });
    expect(res.feedback.status).toBe('resolved');
    expect(res.feedback.resolution).toBe('fixed by switching tools');
    await new Promise((r) => setTimeout(r, 5));
    // The maintainer was DM'd on flag, AND the reporter was DM'd on close.
    const reporterDM = postedMessages.find((m: any) => /resolved|won/i.test(m.text));
    expect(reporterDM).toBeTruthy();
    expect(reporterDM.text).toMatch(/fixed by switching tools/);
  });

  it('list_open is maintainer-only', async () => {
    const { conn } = fakeDeps(() => 'U_NOT_MAINTAINER');
    const tool = conn.tools.find((t) => t.name === 'feedback.list_open')!;
    const res: any = await tool.execute({ limit: 50 });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('FORBIDDEN');
  });
});
