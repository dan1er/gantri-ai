import { describe, it, expect, vi } from 'vitest';
import { PipedriveConnector } from '../../../../src/connectors/pipedrive/connector.js';
import type { PipedriveApiClient, DealField } from '../../../../src/connectors/pipedrive/client.js';
import { unstringifyJsonObjects } from '../../../../src/connectors/base/registry.js';

function makeStub(over: Partial<Record<keyof PipedriveApiClient, unknown>> = {}): PipedriveApiClient {
  return {
    listPipelines: vi.fn().mockResolvedValue([]),
    listStages: vi.fn().mockResolvedValue([]),
    listUsers: vi.fn().mockResolvedValue([]),
    listDealFields: vi.fn().mockResolvedValue([]),
    dealsTimeline: vi.fn().mockResolvedValue([]),
    dealsSummary: vi.fn().mockResolvedValue({ count: 0, total_value_usd: 0, weighted_value_usd: 0 }),
    listDeals: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    listOrganizations: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    listPersons: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    listActivities: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    getDeal: vi.fn(),
    getOrganization: vi.fn(),
    itemSearch: vi.fn().mockResolvedValue([]),
    ...over,
  } as unknown as PipedriveApiClient;
}

describe('PipedriveConnector — skeleton', () => {
  it('exposes name "pipedrive" and tools array', () => {
    const conn = new PipedriveConnector({ client: makeStub() });
    expect(conn.name).toBe('pipedrive');
    expect(Array.isArray(conn.tools)).toBe(true);
  });

  it('resolveCustomFieldName maps a hash to the human name from listDealFields', async () => {
    const fields: DealField[] = [
      { key: '9539ba1ce1e5a79d39a30359e5c3e5b7a95ac082', name: 'Specifier', field_type: 'enum', options: [] },
      { key: '1f25ac373967eb662bc1128e1312a6cde5543fe2', name: 'Purchaser', field_type: 'enum', options: [] },
      { key: 'f21bb44b8b693a780b3e881a258257db8897b6d0', name: 'Source', field_type: 'enum', options: [{ id: 161, label: 'ICFF' }, { id: 162, label: 'Design Miami' }] },
    ];
    const stub = makeStub({ listDealFields: vi.fn().mockResolvedValue(fields) });
    const conn = new PipedriveConnector({ client: stub });
    const map = await conn.resolveCustomFieldNames();
    expect(map.get('9539ba1ce1e5a79d39a30359e5c3e5b7a95ac082')).toBe('Specifier');
    expect(map.get('f21bb44b8b693a780b3e881a258257db8897b6d0')).toBe('Source');
  });

  it('healthCheck pings listPipelines and reports ok with count', async () => {
    const stub = makeStub({ listPipelines: vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]) });
    const conn = new PipedriveConnector({ client: stub });
    const h = await conn.healthCheck();
    expect(h.ok).toBe(true);
    expect(h.detail).toMatch(/2 pipelines/);
  });
});

describe('pipedrive.list_directory', () => {
  it('kind="pipelines" returns id/name/active rows', async () => {
    const stub = makeStub({ listPipelines: vi.fn().mockResolvedValue([
      { id: 1, name: 'Collection Trade & Wholesale', active: true },
      { id: 3, name: 'Wholesale (physical)', active: true },
    ]) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.list_directory')!;
    const r = await tool.execute({ kind: 'pipelines' }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.rows).toEqual([
      { id: 1, name: 'Collection Trade & Wholesale', active: true },
      { id: 3, name: 'Wholesale (physical)', active: true },
    ]);
  });

  it('kind="stages" decorates each stage with pipeline_name', async () => {
    const stub = makeStub({
      listPipelines: vi.fn().mockResolvedValue([{ id: 3, name: 'Wholesale (physical)', active: true }]),
      listStages: vi.fn().mockResolvedValue([
        { id: 11, name: 'Discovery', pipeline_id: 3, order_nr: 1 },
        { id: 12, name: 'Sample', pipeline_id: 3, order_nr: 2 },
      ]),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.list_directory')!;
    const r = await tool.execute({ kind: 'stages' }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.rows[0]).toMatchObject({ id: 11, pipeline_id: 3, pipeline_name: 'Wholesale (physical)', name: 'Discovery', order_nr: 1 });
  });

  it('kind="users" returns only active users by default', async () => {
    const stub = makeStub({ listUsers: vi.fn().mockResolvedValue([
      { id: 1, name: 'Lana', email: 'lana@gantri.com', active_flag: true, is_admin: 1 },
      { id: 2, name: 'OldRep', email: 'old@gantri.com', active_flag: false },
    ]) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.list_directory')!;
    const r = await tool.execute({ kind: 'users' }) as any;
    expect(r.data.rows.length).toBe(1);
    expect(r.data.rows[0].name).toBe('Lana');
  });

  it('kind="deal_fields" returns only user-visible custom fields', async () => {
    const stub = makeStub({ listDealFields: vi.fn().mockResolvedValue([
      { key: 'value', name: 'Value', field_type: 'monetary' }, // standard, excluded
      { key: '9539ba1ce1e5a79d39a30359e5c3e5b7a95ac082', name: 'Specifier', field_type: 'enum' },
    ]) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.list_directory')!;
    const r = await tool.execute({ kind: 'deal_fields' }) as any;
    expect(r.data.rows.length).toBe(1);
    expect(r.data.rows[0].name).toBe('Specifier');
  });

  it('kind="source_options" dereferences the Source enum', async () => {
    const stub = makeStub({ listDealFields: vi.fn().mockResolvedValue([
      { key: 'f21bb44b8b693a780b3e881a258257db8897b6d0', name: 'Source', field_type: 'enum', options: [{ id: 161, label: 'ICFF' }, { id: 162, label: 'Design Miami' }] },
    ]) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.list_directory')!;
    const r = await tool.execute({ kind: 'source_options' }) as any;
    expect(r.data.rows).toEqual([{ id: 161, label: 'ICFF' }, { id: 162, label: 'Design Miami' }]);
  });
});

describe('pipedrive.search', () => {
  it('passes query + entity filter to itemSearch', async () => {
    const stub = makeStub({ itemSearch: vi.fn().mockResolvedValue([
      { type: 'deal', id: 816, title: 'KBM-Hogue', summary: 'value=24500', score: 0.92 },
    ]) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.search')!;
    const r = await tool.execute({ query: 'KBM', entity: 'deals', limit: 10 }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.rows[0]).toMatchObject({ type: 'deal', id: 816, name: 'KBM-Hogue' });
    expect((stub.itemSearch as any)).toHaveBeenCalledWith(expect.objectContaining({ term: 'KBM', itemTypes: ['deal'], limit: 10 }));
  });

  it('entity="all" passes itemTypes=undefined (search across all types)', async () => {
    const stub = makeStub({ itemSearch: vi.fn().mockResolvedValue([]) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.search')!;
    await tool.execute({ query: 'foo', entity: 'all', limit: 10 });
    const callArgs = (stub.itemSearch as any).mock.calls[0][0];
    expect(callArgs.itemTypes).toBeUndefined();
  });
});

describe('pipedrive.deal_timeseries', () => {
  it('returns rows with key/count/totalValueUsd/wonValueUsd/openValueUsd/weighted', async () => {
    const stub = makeStub({
      dealsTimeline: vi.fn().mockResolvedValue([
        { period_start: '2026-01-01', period_end: '2026-01-31', count: 12, total_value_usd: 60000, weighted_value_usd: 30000, open_count: 4, open_value_usd: 20000, won_count: 7, won_value_usd: 35000 },
        { period_start: '2026-02-01', period_end: '2026-02-28', count: 9, total_value_usd: 45000, weighted_value_usd: 22000, open_count: 3, open_value_usd: 15000, won_count: 5, won_value_usd: 25000 },
      ]),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.deal_timeseries')!;
    const r = await tool.execute({ dateRange: { startDate: '2026-01-01', endDate: '2026-02-28' }, granularity: 'month', dateField: 'won_time' }) as any;
    expect(r.period).toEqual({ startDate: '2026-01-01', endDate: '2026-02-28' });
    expect(r.granularity).toBe('month');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ key: '2026-01-01', count: 12, totalValueUsd: 60000, wonCount: 7, wonValueUsd: 35000, openCount: 4, openValueUsd: 20000, weightedValueUsd: 30000 });
  });

  it('accepts dateRange as a preset string', async () => {
    const stub = makeStub({ dealsTimeline: vi.fn().mockResolvedValue([]) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.deal_timeseries')!;
    const out = await tool.execute({ dateRange: 'last_30_days', granularity: 'month', dateField: 'won_time' }) as any;
    expect(out.rows).toEqual([]);
    expect(out.period.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('accepts JSON-stringified-object dateRange (defense-in-depth — registry preprocess)', async () => {
    const stub = makeStub({ dealsTimeline: vi.fn().mockResolvedValue([]) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.deal_timeseries')!;
    // The registry's preprocess handles this for execute() in real code; the
    // tool itself should at least accept the post-parse object form. Mimic
    // the real pipeline by running the args through unstringifyJsonObjects
    // first, exactly as ConnectorRegistry.execute() does before Zod parse.
    const rawArgs = { dateRange: JSON.stringify({ startDate: '2026-01-01', endDate: '2026-01-31' }), granularity: 'month', dateField: 'won_time' };
    const preprocessed = unstringifyJsonObjects(rawArgs) as Record<string, unknown>;
    await expect(tool.execute(preprocessed)).resolves.toBeDefined();
  });

  it('emits a note when sourceOptionId is set (server-side filter not honored)', async () => {
    const stub = makeStub({ dealsTimeline: vi.fn().mockResolvedValue([]) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.deal_timeseries')!;
    const r = await tool.execute({ dateRange: 'last_30_days', granularity: 'month', dateField: 'won_time', sourceOptionId: 161 }) as any;
    expect(r.note).toMatch(/sourceOptionId|list_deals/i);
  });
});

describe('pipedrive.pipeline_snapshot', () => {
  it('groups paginated /v2/deals client-side by stage_id with names from listStages', async () => {
    const stub = makeStub({
      listStages: vi.fn().mockResolvedValue([
        { id: 11, name: 'Discovery', pipeline_id: 3, order_nr: 1 },
        { id: 12, name: 'Sample', pipeline_id: 3, order_nr: 2 },
      ]),
      listPipelines: vi.fn().mockResolvedValue([{ id: 3, name: 'Wholesale (physical)', active: true }]),
      listDeals: vi.fn().mockResolvedValue({ items: [
        { id: 1, title: 'A', value: 1000, currency: 'USD', status: 'open', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null },
        { id: 2, title: 'B', value: 2500, currency: 'USD', status: 'open', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null },
        { id: 3, title: 'C', value: 5000, currency: 'USD', status: 'open', stage_id: 12, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null },
      ], hasMore: false }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.pipeline_snapshot')!;
    const r = await tool.execute({ pipelineId: 3, status: 'open' }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.rows).toEqual([
      { stageId: 11, stageName: 'Discovery', pipelineId: 3, pipelineName: 'Wholesale (physical)', count: 2, totalValueUsd: 3500 },
      { stageId: 12, stageName: 'Sample', pipelineId: 3, pipelineName: 'Wholesale (physical)', count: 1, totalValueUsd: 5000 },
    ]);
    expect(r.data.truncated).toBe(false);
  });

  it('flags truncated:true when listDeals.hasMore=true', async () => {
    const stub = makeStub({
      listStages: vi.fn().mockResolvedValue([{ id: 11, name: 'Discovery', pipeline_id: 3, order_nr: 1 }]),
      listPipelines: vi.fn().mockResolvedValue([{ id: 3, name: 'X', active: true }]),
      listDeals: vi.fn().mockResolvedValue({ items: [{ id: 1, title: 'A', value: 100, currency: 'USD', status: 'open', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null }], hasMore: true }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.pipeline_snapshot')!;
    const r = await tool.execute({ pipelineId: 3, status: 'open' }) as any;
    expect(r.data.truncated).toBe(true);
    expect(r.data.note).toMatch(/truncated|partial|cap/i);
  });
});
