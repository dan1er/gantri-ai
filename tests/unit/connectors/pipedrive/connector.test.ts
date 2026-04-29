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

describe('pipedrive.list_deals', () => {
  it('returns rows with custom-field hashes resolved (Source label)', async () => {
    const stub = makeStub({
      listDealFields: vi.fn().mockResolvedValue([
        { key: 'f21bb44b8b693a780b3e881a258257db8897b6d0', name: 'Source', field_type: 'enum', options: [{ id: 161, label: 'ICFF' }] },
        { key: '9539ba1ce1e5a79d39a30359e5c3e5b7a95ac082', name: 'Specifier', field_type: 'varchar' },
      ]),
      listDeals: vi.fn().mockResolvedValue({ items: [
        { id: 816, title: 'KBM-Hogue', value: 24500, currency: 'USD', status: 'open', stage_id: 11, pipeline_id: 3, owner_id: { id: 7, name: 'Lana' }, person_id: { value: 12, name: 'Tasha' }, org_id: { value: 5, name: 'KBM-Hogue' }, add_time: '2026-04-01', won_time: null, lost_time: null, lost_reason: null, expected_close_date: '2026-05-15', custom_fields: { 'f21bb44b8b693a780b3e881a258257db8897b6d0': 161, '9539ba1ce1e5a79d39a30359e5c3e5b7a95ac082': 'AcmeArch' } },
      ], hasMore: false }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.list_deals')!;
    const r = await tool.execute({ dateRange: 'last_30_days', limit: 50 }) as any;
    expect(r.data.rows[0]).toMatchObject({
      id: 816, title: 'KBM-Hogue', valueUsd: 24500, ownerId: 7, ownerName: 'Lana',
      orgId: 5, orgName: 'KBM-Hogue', personId: 12, personName: 'Tasha',
      sourceLabel: 'ICFF', specifierOrgName: 'AcmeArch',
    });
  });

  it('passes status, pipelineId, sourceOptionId filters through to client + filters client-side for source', async () => {
    const stub = makeStub({
      listDealFields: vi.fn().mockResolvedValue([
        { key: 'f21bb44b8b693a780b3e881a258257db8897b6d0', name: 'Source', field_type: 'enum', options: [{ id: 161, label: 'ICFF' }, { id: 162, label: 'Design Miami' }] },
      ]),
      listDeals: vi.fn().mockResolvedValue({ items: [
        { id: 1, title: 'A', value: 100, currency: 'USD', status: 'won', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null, custom_fields: { 'f21bb44b8b693a780b3e881a258257db8897b6d0': 161 } },
        { id: 2, title: 'B', value: 200, currency: 'USD', status: 'won', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null, custom_fields: { 'f21bb44b8b693a780b3e881a258257db8897b6d0': 162 } },
      ], hasMore: false }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.list_deals')!;
    const r = await tool.execute({ status: 'won', pipelineId: 3, sourceOptionId: 161, limit: 50 }) as any;
    expect((stub.listDeals as any)).toHaveBeenCalledWith(expect.objectContaining({ status: 'won', pipelineId: 3 }));
    // Client-side filter on sourceOptionId keeps only deal 1.
    expect(r.data.rows.map((d: any) => d.id)).toEqual([1]);
  });

  it('accepts dateRange as a preset string', async () => {
    const stub = makeStub({
      listDealFields: vi.fn().mockResolvedValue([]),
      listDeals: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.list_deals')!;
    const r = await tool.execute({ dateRange: 'last_30_days', limit: 50 }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.dateRange?.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('accepts dateRange as object', async () => {
    const stub = makeStub({
      listDealFields: vi.fn().mockResolvedValue([]),
      listDeals: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.list_deals')!;
    const r = await tool.execute({ dateRange: { startDate: '2026-01-01', endDate: '2026-01-31' }, limit: 50 }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.dateRange).toEqual({ startDate: '2026-01-01', endDate: '2026-01-31' });
  });

  it('accepts JSON-stringified-object dateRange (registry preprocess)', async () => {
    const stub = makeStub({
      listDealFields: vi.fn().mockResolvedValue([]),
      listDeals: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.list_deals')!;
    const rawArgs = { dateRange: JSON.stringify({ startDate: '2026-01-01', endDate: '2026-01-31' }), limit: 50 };
    const preprocessed = unstringifyJsonObjects(rawArgs) as Record<string, unknown>;
    await expect(tool.execute(preprocessed)).resolves.toBeDefined();
  });
});

describe('pipedrive.deal_detail', () => {
  it('joins person + org + activity + product details with resolved custom fields', async () => {
    const stub = makeStub({
      getDeal: vi.fn().mockResolvedValue({ id: 816, title: 'KBM-Hogue', value: 24500, currency: 'USD', status: 'open', stage_id: 11, pipeline_id: 3, owner_id: { id: 7, name: 'Lana' }, person_id: { value: 12, name: 'Tasha' }, org_id: { value: 5, name: 'KBM-Hogue' }, custom_fields: { 'f21bb44b8b693a780b3e881a258257db8897b6d0': 161 } }),
      listDealFields: vi.fn().mockResolvedValue([
        { key: 'f21bb44b8b693a780b3e881a258257db8897b6d0', name: 'Source', field_type: 'enum', options: [{ id: 161, label: 'ICFF' }] },
      ]),
      getOrganization: vi.fn().mockResolvedValue({ id: 5, name: 'KBM-Hogue', address: '1 Main St', web: 'kbm.com' }),
      listActivities: vi.fn().mockResolvedValue({ items: [
        { id: 100, type: 'call', subject: 'Discovery call', user_id: 7, done: 1, due_date: '2026-04-15', deal_id: 816 },
      ], hasMore: false }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.deal_detail')!;
    const r = await tool.execute({ dealId: 816 }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.id).toBe(816);
    expect(r.data.orgDetail).toMatchObject({ id: 5, name: 'KBM-Hogue', address: '1 Main St', web: 'kbm.com' });
    expect(r.data.lastActivity).toMatchObject({ type: 'call', subject: 'Discovery call', done: true });
    expect(r.data.customFields).toMatchObject({ Source: 'ICFF' });
  });
});

describe('pipedrive.organization_performance', () => {
  it('groups won/open deals by org_id with names + lastDealTime', async () => {
    const stub = makeStub({
      listDeals: vi.fn().mockResolvedValue({ items: [
        { id: 1, title: 'A', value: 1000, currency: 'USD', status: 'won', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: { value: 5, name: 'KBM-Hogue' }, won_time: '2026-04-10', add_time: '2026-04-01' },
        { id: 2, title: 'B', value: 2000, currency: 'USD', status: 'won', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: { value: 5, name: 'KBM-Hogue' }, won_time: '2026-04-15', add_time: '2026-04-02' },
        { id: 3, title: 'C', value: 5000, currency: 'USD', status: 'open', stage_id: 12, pipeline_id: 3, owner_id: 7, person_id: null, org_id: { value: 6, name: 'Bilotti' }, add_time: '2026-04-05' },
      ], hasMore: false }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.organization_performance')!;
    const r = await tool.execute({ dateRange: 'last_30_days', topN: 25, metric: 'won_value' }) as any;
    expect(r.data.rows[0]).toMatchObject({ orgId: 5, orgName: 'KBM-Hogue', wonCount: 2, wonValueUsd: 3000 });
    expect(r.data.rows[1]).toMatchObject({ orgId: 6, orgName: 'Bilotti', openCount: 1, openValueUsd: 5000 });
  });

  it('flags truncated when listDeals.hasMore is true', async () => {
    const stub = makeStub({ listDeals: vi.fn().mockResolvedValue({ items: [], hasMore: true }) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.organization_performance')!;
    const r = await tool.execute({ dateRange: 'last_30_days', topN: 25, metric: 'won_value' }) as any;
    expect(r.data.truncated).toBe(true);
  });
});

describe('pipedrive.organization_detail', () => {
  it('returns org + deals + persons (activities omitted by default)', async () => {
    const stub = makeStub({
      getOrganization: vi.fn().mockResolvedValue({ id: 5, name: 'KBM-Hogue', address: '1 Main St', web: 'kbm.com' }),
      listDeals: vi.fn().mockResolvedValue({ items: [
        { id: 1, title: 'A', value: 1000, currency: 'USD', status: 'open', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: { value: 5, name: 'KBM-Hogue' } },
      ], hasMore: false }),
      listPersons: vi.fn().mockResolvedValue({ items: [
        { id: 12, name: 'Tasha', emails: [{ value: 't@kbm.com', primary: true }], phones: [], org_id: { value: 5, name: 'KBM-Hogue' } },
      ], hasMore: false }),
      listDealFields: vi.fn().mockResolvedValue([]),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.organization_detail')!;
    const r = await tool.execute({ orgId: 5 }) as any;
    expect(r.data.org.name).toBe('KBM-Hogue');
    expect(r.data.deals).toHaveLength(1);
    expect(r.data.persons).toHaveLength(1);
    expect(r.data.activities).toBeUndefined();
  });
});

describe('pipedrive.lost_reasons_breakdown', () => {
  it('groups lost deals by reason with percentOfTotal', async () => {
    const stub = makeStub({
      listDeals: vi.fn().mockResolvedValue({ items: [
        { id: 1, title: 'A', value: 1000, currency: 'USD', status: 'lost', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null, lost_reason: 'Budget', lost_time: '2026-04-10' },
        { id: 2, title: 'B', value: 2000, currency: 'USD', status: 'lost', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null, lost_reason: 'Budget', lost_time: '2026-04-15' },
        { id: 3, title: 'C', value: 5000, currency: 'USD', status: 'lost', stage_id: 12, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null, lost_reason: 'Timing', lost_time: '2026-04-20' },
      ], hasMore: false }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.lost_reasons_breakdown')!;
    const r = await tool.execute({ dateRange: 'last_30_days', groupBy: 'reason', topN: 25 }) as any;
    expect(r.data.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'Budget', count: 2, totalValueUsd: 3000 }),
      expect.objectContaining({ reason: 'Timing', count: 1, totalValueUsd: 5000 }),
    ]));
    const total = r.data.rows.reduce((s: number, r: any) => s + r.percentOfTotal, 0);
    expect(total).toBeCloseTo(100, 0);
  });
});

describe('pipedrive.activity_summary', () => {
  it('aggregates activities by month with byType + byUser breakdowns', async () => {
    const stub = makeStub({
      listActivities: vi.fn().mockResolvedValue({ items: [
        { id: 1, type: 'call', subject: 'a', user_id: 7, done: 1, due_date: '2026-04-05', marked_as_done_time: '2026-04-05 10:00:00' },
        { id: 2, type: 'meeting', subject: 'b', user_id: 7, done: 1, due_date: '2026-04-10', marked_as_done_time: '2026-04-10 10:00:00' },
        { id: 3, type: 'call', subject: 'c', user_id: 8, done: 1, due_date: '2026-04-12', marked_as_done_time: '2026-04-12 10:00:00' },
      ], hasMore: false }),
      listUsers: vi.fn().mockResolvedValue([{ id: 7, name: 'Lana', email: 'l@g.com', active_flag: true }, { id: 8, name: 'Max', email: 'm@g.com', active_flag: true }]),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.activity_summary')!;
    const r = await tool.execute({ dateRange: { startDate: '2026-04-01', endDate: '2026-04-30' }, granularity: 'month', status: 'done' }) as any;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].count).toBe(3);
    expect(r.rows[0].byType).toMatchObject({ call: 2, meeting: 1 });
    expect(r.rows[0].byUser.find((u: any) => u.userName === 'Lana').count).toBe(2);
  });
});

describe('pipedrive.user_performance', () => {
  it('returns per-user won_value with rank sorted desc', async () => {
    const stub = makeStub({
      listUsers: vi.fn().mockResolvedValue([
        { id: 7, name: 'Lana', email: 'l@g.com', active_flag: true },
        { id: 8, name: 'Max', email: 'm@g.com', active_flag: true },
      ]),
      dealsTimeline: vi.fn().mockImplementation(async (opts: any) => {
        if (opts.userId === 7) return [{ period_start: '2026-04-01', period_end: '2026-04-30', count: 3, total_value_usd: 9000, weighted_value_usd: 4500, open_count: 0, open_value_usd: 0, won_count: 3, won_value_usd: 9000 }];
        if (opts.userId === 8) return [{ period_start: '2026-04-01', period_end: '2026-04-30', count: 1, total_value_usd: 1500, weighted_value_usd: 1000, open_count: 0, open_value_usd: 0, won_count: 1, won_value_usd: 1500 }];
        return [];
      }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.user_performance')!;
    const r = await tool.execute({ dateRange: 'last_30_days', metric: 'won_value', topN: 10 }) as any;
    expect(r.data.rows).toEqual([
      { userId: 7, userName: 'Lana', value: 9000, rank: 1 },
      { userId: 8, userName: 'Max', value: 1500, rank: 2 },
    ]);
  });
});
