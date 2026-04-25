import { describe, it, expect, vi } from 'vitest';
import { ScheduledReportsConnector } from '../../../src/reports/reports-connector.js';

function fakeRepo() {
  const rows: any[] = [];
  return {
    rows,
    insert: vi.fn(async (input: any) => {
      const row = { id: `id-${rows.length + 1}`, ...input, enabled: true, fail_count: 0,
        plan_validation_status: 'ok', plan_compiled_at: '2026-04-25T00:00:00Z',
        last_run_at: null, last_run_status: null, last_run_error: null,
        created_at: '2026-04-25T00:00:00Z', updated_at: '2026-04-25T00:00:00Z' };
      rows.push(row);
      return row;
    }),
    getById: vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
    listByUser: vi.fn(async (uid: string) => rows.filter((r) => r.slack_user_id === uid)),
    update: vi.fn(async (id: string, fields: any) => {
      const row = rows.find((r) => r.id === id);
      Object.assign(row, fields);
      return row;
    }),
  };
}

describe('ScheduledReportsConnector — actor scoping', () => {
  it('list_subscriptions returns only the calling actor’s subs', async () => {
    const repo = fakeRepo();
    repo.rows.push({ id: 'a', slack_user_id: 'U1', display_name: 'mine', enabled: true });
    repo.rows.push({ id: 'b', slack_user_id: 'U2', display_name: 'theirs', enabled: true });

    const actor = { slackUserId: 'U1' };
    const conn = new ScheduledReportsConnector({ repo: repo as any, getActor: () => actor, compile: vi.fn(), execute: vi.fn(), nextFireAt: () => new Date() });
    const tool = conn.tools.find((t) => t.name === 'reports.list_subscriptions')!;
    const res: any = await tool.execute({});
    expect(res.subscriptions).toHaveLength(1);
    expect(res.subscriptions[0].id).toBe('a');
  });

  it('unsubscribe rejects another user’s subscription as not-found', async () => {
    const repo = fakeRepo();
    repo.rows.push({ id: 'a', slack_user_id: 'U2', display_name: 'theirs', enabled: true });
    const conn = new ScheduledReportsConnector({
      repo: repo as any,
      getActor: () => ({ slackUserId: 'U1' }),
      compile: vi.fn(),
      execute: vi.fn(),
      nextFireAt: () => new Date(),
    });
    const tool = conn.tools.find((t) => t.name === 'reports.unsubscribe')!;
    const res: any = await tool.execute({ id: 'a' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('NOT_FOUND');
  });
});
