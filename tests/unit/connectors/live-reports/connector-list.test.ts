import { describe, it, expect, vi } from 'vitest';
import { LiveReportsConnector } from '../../../../src/connectors/live-reports/connector.js';

function makeConn(reports: any[]) {
  return new LiveReportsConnector({
    repo: { listByOwner: vi.fn(async () => reports), listAll: vi.fn(), getBySlug: vi.fn(), create: vi.fn(), archive: vi.fn(), replaceSpec: vi.fn(), listHistory: vi.fn(), recordVisit: vi.fn(), searchByKeywords: vi.fn() } as never,
    claude: { messages: { create: vi.fn() } } as never,
    model: 'claude-sonnet-4-6',
    registry: { execute: vi.fn() } as never,
    getToolCatalog: () => '',
    publicBaseUrl: 'https://x',
    getActor: () => ({ slackUserId: 'UA' }),
    getRoleForActor: async () => 'user',
  });
}

describe('reports.list_my_reports', () => {
  it('returns reports owned by the actor with URLs', async () => {
    const conn = makeConn([
      { slug: 's1', title: 'T1', ownerSlackId: 'UA', accessToken: 'tok1', createdAt: '2026-04-01', updatedAt: '2026-04-01', visitCount: 4, lastVisitedAt: null },
      { slug: 's2', title: 'T2', ownerSlackId: 'UA', accessToken: 'tok2', createdAt: '2026-04-02', updatedAt: '2026-04-02', visitCount: 0, lastVisitedAt: null },
    ]);
    const tool = conn.tools.find((t) => t.name === 'reports.list_my_reports')!;
    const out = await tool.execute({}) as any;
    expect(out.reports).toHaveLength(2);
    expect(out.reports[0].url).toMatch(/\/r\/s1\?t=tok1/);
  });
});
