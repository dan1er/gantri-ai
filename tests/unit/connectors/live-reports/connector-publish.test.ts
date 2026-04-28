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

function fakeSlackClient() {
  const postMessage = vi.fn(async () => ({ ok: true, ts: '1', channel: 'D1' }));
  const open = vi.fn(async () => ({ ok: true, channel: { id: 'D1' } }));
  return { conversations: { open }, chat: { postMessage }, _postMessage: postMessage, _open: open };
}

function makeConnector(opts: {
  intentJson: string;
  runOk?: boolean;
  isAdmin?: boolean;
  existing?: any[];
  /** Override the visual verifier. Default null (disabled, since unit
   *  tests can't launch real Chromium). Pass a function to assert the
   *  visual-verification hook is wired correctly. */
  visualVerifier?: ((url: string) => Promise<import('../../../../src/connectors/live-reports/visual-verifier.js').VisualVerificationResult>) | null;
}) {
  const repo = fakeRepo();
  if (opts.existing) (repo.listAll as any).mockResolvedValue(opts.existing);
  const claude = fakeClaude(opts.intentJson);
  const registry = fakeRegistry(opts.runOk === false ? {} : { 'gantri.order_stats': { totalOrders: 87 } });
  const slackClient = fakeSlackClient();
  return {
    repo,
    slackClient,
    conn: new LiveReportsConnector({
      repo: repo as never,
      claude: claude as never,
      model: 'claude-sonnet-4-6',
      registry: registry as never,
      getToolCatalog: () => 'cat',
      publicBaseUrl: 'https://gantri-ai-bot.fly.dev',
      getActor: () => ({ slackUserId: 'UDANNY' }),
      getRoleForActor: async () => (opts.isAdmin ? 'admin' : 'user'),
      slackClient: slackClient as never,
      // Default: disable visual verification in unit tests — it would
      // try to launch a real Chromium against a URL that doesn't exist
      // locally. Tests that exercise the visual-verifier hook pass an
      // explicit stub.
      visualVerifier: opts.visualVerifier === undefined ? null : opts.visualVerifier,
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

  it('returns queued immediately, then compiles + smoke-runs + persists + DMs in background', async () => {
    const { conn, repo, slackClient } = makeConnector({ intentJson: JSON.stringify(validSpec) });
    const tool = conn.tools.find((t) => t.name === 'reports.publish_live_report')!;
    const out = await tool.execute({ intent: 'weekly sales by channel', forceCreate: false }) as any;
    expect(out.status).toBe('queued');
    expect(out.requesterSlackUserId).toBe('UDANNY');
    // The compile + persist runs in the background. Await it before asserting.
    await conn._backgroundPublish;
    expect(repo.create).toHaveBeenCalledTimes(1);
    const created = (repo.create as any).mock.calls[0][0];
    expect(created.slug).toBe('weekly-sales');
    expect(slackClient._postMessage).toHaveBeenCalledTimes(1);
    const dmText = (slackClient._postMessage as any).mock.calls[0][0].text as string;
    expect(dmText).toContain('listo');
    expect(dmText).toContain('/r/weekly-sales?t=');
  });

  it('returns queued, but on smoke failure DMs the requester with the error and persists nothing', async () => {
    const { conn, repo, slackClient } = makeConnector({ intentJson: JSON.stringify(validSpec), runOk: false });
    const tool = conn.tools.find((t) => t.name === 'reports.publish_live_report')!;
    const out = await tool.execute({ intent: 'sales', forceCreate: false }) as any;
    expect(out.status).toBe('queued');
    await conn._backgroundPublish;
    expect(repo.create).not.toHaveBeenCalled();
    expect(slackClient._postMessage).toHaveBeenCalledTimes(1);
    const dmText = (slackClient._postMessage as any).mock.calls[0][0].text as string;
    expect(dmText).toContain('smoke_failed');
  });

  it('does NOT publish when hard verification issues remain after retry — DMs failure instead', async () => {
    // Spec where the kpi block references a path that does not exist in tool output.
    const brokenSpec = {
      version: 1,
      title: 'Broken Sales',
      data: [{ id: 'a', tool: 'gantri.order_stats', args: {} }],
      ui: [
        { type: 'kpi', label: 'Revenue', value: 'a.totally_nonexistent_field', format: 'currency' },
      ],
    };
    const { conn, repo, slackClient } = makeConnector({ intentJson: JSON.stringify(brokenSpec) });
    const tool = conn.tools.find((t) => t.name === 'reports.publish_live_report')!;
    await tool.execute({ intent: 'broken sales', forceCreate: false });
    await conn._backgroundPublish;
    expect(repo.create).not.toHaveBeenCalled();
    const dmText = (slackClient._postMessage as any).mock.calls[0][0].text as string;
    expect(dmText).toContain('verification_failed');
    expect(dmText).toContain('ref_undefined');
    expect(dmText).toContain('totally_nonexistent_field');
  });

  it('catches unresolved $DATE macros that leaked into prose / spec fields', async () => {
    const leakySpec = {
      version: 1,
      title: 'Sales for $DATE:this_monday',
      description: 'WTD revenue from $DATE:this_monday to $DATE:today',
      data: [{ id: 'a', tool: 'gantri.order_stats', args: {} }],
      ui: [
        { type: 'text', markdown: 'See `$DATE:today` for context.' },
        { type: 'kpi', label: 'Revenue', value: 'a.totalOrders', format: 'number' },
      ],
    };
    const { conn, slackClient } = makeConnector({ intentJson: JSON.stringify(leakySpec) });
    const tool = conn.tools.find((t) => t.name === 'reports.publish_live_report')!;
    await tool.execute({ intent: 'sales wtd', forceCreate: false });
    await conn._backgroundPublish;
    const dmText = (slackClient._postMessage as any).mock.calls[0][0].text as string;
    expect(dmText).toContain('unresolved_date_macro');
  });

  it('detects when text blocks contain backtick-wrapped data refs (LLM templating anti-pattern)', async () => {
    // Spec where the LLM put a data ref inside a text block instead of using a kpi/table.
    const badSpec = {
      version: 1,
      title: 'Bad Sales',
      data: [{ id: 'this_week', tool: 'gantri.order_stats', args: {} }],
      ui: [
        {
          type: 'text',
          markdown: '| Period | Revenue |\n|---|---|\n| This Week | `this_week.totalOrders` |',
        },
      ],
    };
    const { conn, slackClient } = makeConnector({ intentJson: JSON.stringify(badSpec) });
    const tool = conn.tools.find((t) => t.name === 'reports.publish_live_report')!;
    await tool.execute({ intent: 'bad weekly sales', forceCreate: false });
    await conn._backgroundPublish;
    // The DM should warn about the verification issue.
    const dmText = (slackClient._postMessage as any).mock.calls[0][0].text as string;
    expect(dmText).toContain('text_block_uses_data_refs');
    expect(dmText).toContain('this_week.totalOrders');
  });

  it('archives the report and DMs failure when visual verification fails', async () => {
    const intentJson = JSON.stringify(validSpec);
    const verifierFailure = vi.fn(async () => ({
      ok: false,
      issues: [{ severity: 'error' as const, code: 'table_cell_empty' as const, message: 'Table #0: every first-column cell is "—"' }],
      metrics: { durationMs: 100, finalUrl: 'x', httpStatus: 200, consoleErrorCount: 0, networkFailureCount: 0 },
    }));
    const { conn, repo, slackClient } = makeConnector({ intentJson, visualVerifier: verifierFailure });
    const tool = conn.tools.find((t) => t.name === 'reports.publish_live_report')!;
    await tool.execute({ intent: 'Weekly sales', forceCreate: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(verifierFailure).toHaveBeenCalledTimes(1);
    expect(repo.archive).toHaveBeenCalledTimes(1);
    expect(repo.archive).toHaveBeenCalledWith(expect.any(String), 'UDANNY');
    const dmText = (slackClient._postMessage as any).mock.calls.at(-1)?.[0]?.text ?? '';
    expect(dmText).toContain('visual_verification_failed');
    expect(dmText).toContain('table_cell_empty');
  });

  it('publishes successfully when visual verification passes', async () => {
    const intentJson = JSON.stringify(validSpec);
    const verifierOk = vi.fn(async () => ({
      ok: true,
      issues: [],
      metrics: { durationMs: 100, finalUrl: 'x', httpStatus: 200, consoleErrorCount: 0, networkFailureCount: 0 },
    }));
    const { conn, repo, slackClient } = makeConnector({ intentJson, visualVerifier: verifierOk });
    const tool = conn.tools.find((t) => t.name === 'reports.publish_live_report')!;
    await tool.execute({ intent: 'Weekly sales', forceCreate: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(verifierOk).toHaveBeenCalledTimes(1);
    expect(repo.archive).not.toHaveBeenCalled();
    expect(repo.create).toHaveBeenCalledTimes(1);
    const dmText = (slackClient._postMessage as any).mock.calls.at(-1)?.[0]?.text ?? '';
    expect(dmText).toContain('listo');
  });
});
