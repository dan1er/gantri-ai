import { describe, it, expect, vi } from 'vitest';
import { LiveReportsConnector } from '../../../../src/connectors/live-reports/connector.js';

const okSpec = JSON.stringify({
  version: 1, title: 'Updated Title',
  data: [{ id: 'a', tool: 'gantri.order_stats', args: {} }],
  ui: [{ type: 'kpi', label: 'X', value: 'a.totalOrders' }],
});

function makeConn(opts: {
  ownerOfTarget: string;
  actorSlackId: string;
  isAdmin: boolean;
  intentJson?: string;
  runOk?: boolean;
}) {
  const target = { slug: 's1', title: 'Old', ownerSlackId: opts.ownerOfTarget, accessToken: 't', spec: { version: 1, title: 'Old', data: [], ui: [] }, intent: 'old' };
  const repo = {
    getBySlug: vi.fn(async (slug: string) => slug === 's1' ? target : null),
    archive: vi.fn(async () => undefined),
    replaceSpec: vi.fn(async (input: any) => ({ ...target, ...input, slug: 's1', accessToken: input.newAccessToken ?? target.accessToken })),
    listAll: vi.fn(async () => []),
    listByOwner: vi.fn(async () => []),
    listHistory: vi.fn(),
    recordVisit: vi.fn(),
    searchByKeywords: vi.fn(),
    create: vi.fn(),
  };
  const claude = { messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: opts.intentJson ?? okSpec }], usage: { input_tokens: 1, output_tokens: 1 } })) } };
  const registry = { execute: vi.fn(async () => (opts.runOk === false ? { ok: false, error: { code: 'X', message: 'no' } } : { ok: true, data: { totalOrders: 1 } })) };
  return new LiveReportsConnector({
    repo: repo as never,
    claude: claude as never,
    model: 'claude-sonnet-4-6',
    registry: registry as never,
    getToolCatalog: () => '',
    publicBaseUrl: 'https://x',
    getActor: () => ({ slackUserId: opts.actorSlackId }),
    getRoleForActor: async () => (opts.isAdmin ? 'admin' : 'user'),
    slackClient: { conversations: { open: vi.fn() }, chat: { postMessage: vi.fn() } } as never,
  });
}

describe('reports.recompile_report', () => {
  it('rejects when actor is not owner and not admin', async () => {
    const conn = makeConn({ ownerOfTarget: 'UA', actorSlackId: 'UB', isAdmin: false });
    const tool = conn.tools.find((t) => t.name === 'reports.recompile_report')!;
    const out = await tool.execute({ slug: 's1', newIntent: 'new', regenerateToken: false }) as any;
    expect(out.error?.code).toBe('FORBIDDEN');
  });

  it('allows owner to recompile', async () => {
    const conn = makeConn({ ownerOfTarget: 'UA', actorSlackId: 'UA', isAdmin: false });
    const tool = conn.tools.find((t) => t.name === 'reports.recompile_report')!;
    const out = await tool.execute({ slug: 's1', newIntent: 'new', regenerateToken: false }) as any;
    expect(out.status).toBe('recompiled');
    expect(out.slug).toBe('s1');
  });

  it('admin can recompile any report', async () => {
    const conn = makeConn({ ownerOfTarget: 'UA', actorSlackId: 'UADMIN', isAdmin: true });
    const tool = conn.tools.find((t) => t.name === 'reports.recompile_report')!;
    const out = await tool.execute({ slug: 's1', newIntent: 'new', regenerateToken: true }) as any;
    expect(out.status).toBe('recompiled');
  });
});

describe('reports.archive_report', () => {
  it('rejects non-owner non-admin', async () => {
    const conn = makeConn({ ownerOfTarget: 'UA', actorSlackId: 'UB', isAdmin: false });
    const tool = conn.tools.find((t) => t.name === 'reports.archive_report')!;
    const out = await tool.execute({ slug: 's1' }) as any;
    expect(out.error?.code).toBe('FORBIDDEN');
  });
  it('allows owner', async () => {
    const conn = makeConn({ ownerOfTarget: 'UA', actorSlackId: 'UA', isAdmin: false });
    const tool = conn.tools.find((t) => t.name === 'reports.archive_report')!;
    const out = await tool.execute({ slug: 's1' }) as any;
    expect(out.status).toBe('archived');
  });
});
