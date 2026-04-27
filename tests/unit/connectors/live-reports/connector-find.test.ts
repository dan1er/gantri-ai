import { describe, it, expect, vi } from 'vitest';
import { LiveReportsConnector } from '../../../../src/connectors/live-reports/connector.js';
import type { PublishedReport } from '../../../../src/storage/repositories/published-reports.js';

function makeRepo(reports: Partial<PublishedReport>[]) {
  return {
    listAll: vi.fn(async () => reports as PublishedReport[]),
    getBySlug: vi.fn(),
    create: vi.fn(),
    archive: vi.fn(),
    listByOwner: vi.fn(),
    replaceSpec: vi.fn(),
    listHistory: vi.fn(),
    recordVisit: vi.fn(),
    searchByKeywords: vi.fn(),
  };
}

function makeConnector(opts: { repo: any; getActor?: () => { slackUserId: string }; isAdmin?: () => Promise<string | null> }) {
  return new LiveReportsConnector({
    repo: opts.repo,
    claude: { messages: { create: vi.fn() } } as never,
    model: 'claude-sonnet-4-6',
    registry: { execute: vi.fn() } as never,
    getToolCatalog: () => 'fake catalog',
    publicBaseUrl: 'https://gantri-ai-bot.fly.dev',
    getActor: opts.getActor ?? (() => ({ slackUserId: 'UDANNY' })),
    getRoleForActor: opts.isAdmin ?? (async () => 'user'),
  });
}

describe('LiveReportsConnector.reports.find_similar_reports', () => {
  it('returns existing reports with ≥3 keyword overlap, sorted by score desc, with owner', async () => {
    const repo = makeRepo([
      { slug: 'weekly-sales', title: 'Weekly Sales', ownerSlackId: 'UDANNY', intentKeywords: ['weekly', 'sales', 'revenue', 'channel'] },
      { slug: 'monthly-sales', title: 'Monthly Sales', ownerSlackId: 'UIAN', intentKeywords: ['monthly', 'sales', 'revenue'] },
      { slug: 'unrelated', title: 'Unrelated', ownerSlackId: 'UIAN', intentKeywords: ['orders', 'inventory'] },
    ]);
    const conn = makeConnector({ repo });
    const tool = conn.tools.find((t) => t.name === 'reports.find_similar_reports')!;
    const out = await tool.execute({ intent: 'I want a weekly sales report by channel for revenue' }) as { matches: any[] };
    expect(out.matches.length).toBeGreaterThan(0);
    expect(out.matches[0].slug).toBe('weekly-sales');
    expect(out.matches[0].owner_slack_id).toBe('UDANNY');
    expect(out.matches[0].score).toBeGreaterThanOrEqual(3);
  });

  it('returns empty matches when nothing overlaps', async () => {
    const repo = makeRepo([
      { slug: 's1', title: 'X', ownerSlackId: 'UA', intentKeywords: ['orders', 'inventory'] },
    ]);
    const conn = makeConnector({ repo });
    const tool = conn.tools.find((t) => t.name === 'reports.find_similar_reports')!;
    const out = await tool.execute({ intent: 'channel revenue marketing attribution' }) as { matches: any[] };
    expect(out.matches).toEqual([]);
  });
});
