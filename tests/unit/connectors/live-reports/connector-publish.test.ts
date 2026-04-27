import { describe, it, expect, vi } from 'vitest';
import { LiveReportsConnector } from '../../../../src/connectors/live-reports/connector.js';

const validSpec = {
  version: 1,
  title: 'Weekly Sales',
  data: [{ id: 'a', tool: 'gantri.order_stats', args: {} }],
  ui: [{ type: 'kpi', label: 'Orders', value: 'a.totalOrders', format: 'number' }],
};

function fakeClaude(text: string) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text }],
        usage: { input_tokens: 10, output_tokens: 20 },
      })),
    },
  };
}
function fakeRegistry(map: Record<string, unknown>) {
  return { execute: vi.fn(async (n: string) => (map[n] ? { ok: true, data: map[n] } : { ok: false, error: { code: 'X', message: 'no' } })) };
}
function fakeRepo() {
  const reports: any[] = [];
  return {
    listAll: vi.fn(async () => reports),
    getBySlug: vi.fn(async (slug: string) => reports.find((r) => r.slug === slug && !r.archivedAt) ?? null),
    create: vi.fn(async (input: any) => { const row = { id: 'r1', archivedAt: null, ...input, accessToken: input.accessToken, intentKeywords: input.intentKeywords }; reports.push(row); return row; }),
    archive: vi.fn(),
    listByOwner: vi.fn(async () => reports),
    replaceSpec: vi.fn(),
    listHistory: vi.fn(),
    recordVisit: vi.fn(),
    searchByKeywords: vi.fn(),
  };
}

function makeConnector(opts: { intentJson: string; runOk?: boolean; isAdmin?: boolean; existing?: any[] }) {
  const repo = fakeRepo();
  if (opts.existing) (repo.listAll as any).mockResolvedValue(opts.existing);
  const claude = fakeClaude(opts.intentJson);
  const registry = fakeRegistry(opts.runOk === false ? {} : { 'gantri.order_stats': { totalOrders: 87 } });
  return {
    repo,
    conn: new LiveReportsConnector({
      repo: repo as never,
      claude: claude as never,
      model: 'claude-sonnet-4-6',
      registry: registry as never,
      getToolCatalog: () => 'cat',
      publicBaseUrl: 'https://gantri-ai-bot.fly.dev',
      getActor: () => ({ slackUserId: 'UDANNY' }),
      getRoleForActor: async () => (opts.isAdmin ? 'admin' : 'user'),
    }),
  };
}

describe('reports.publish_live_report', () => {
  it('rejects without forceCreate when a high-overlap existing report exists', async () => {
    const { conn } = makeConnector({
      intentJson: JSON.stringify(validSpec),
      existing: [{ slug: 'weekly-sales', title: 'Weekly Sales', ownerSlackId: 'UA', intentKeywords: ['weekly', 'sales', 'revenue'] }],
    });
    const tool = conn.tools.find((t) => t.name === 'reports.publish_live_report')!;
    const out = await tool.execute({ intent: 'weekly sales revenue', forceCreate: false }) as any;
    expect(out.status).toBe('existing_match');
    expect(out.matches.length).toBeGreaterThan(0);
  });

  it('compiles + smoke-runs + persists with slug derived from title', async () => {
    const { conn, repo } = makeConnector({ intentJson: JSON.stringify(validSpec) });
    const tool = conn.tools.find((t) => t.name === 'reports.publish_live_report')!;
    const out = await tool.execute({ intent: 'weekly sales by channel', forceCreate: false }) as any;
    expect(out.status).toBe('created');
    expect(out.slug).toBe('weekly-sales');
    expect(out.url).toMatch(/\/r\/weekly-sales\?t=/);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('aborts if smoke-execute errors on every step', async () => {
    const { conn } = makeConnector({ intentJson: JSON.stringify(validSpec), runOk: false });
    const tool = conn.tools.find((t) => t.name === 'reports.publish_live_report')!;
    const out = await tool.execute({ intent: 'sales', forceCreate: false }) as any;
    expect(out.status).toBe('smoke_failed');
    expect(out.errors.length).toBeGreaterThan(0);
  });
});
