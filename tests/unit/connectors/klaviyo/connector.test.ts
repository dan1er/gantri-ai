import { describe, it, expect, vi } from 'vitest';
import { KlaviyoConnector } from '../../../../src/connectors/klaviyo/connector.js';
import type {
  KlaviyoApiClient, KlaviyoResource, KlaviyoCampaignAttrs, KlaviyoSegmentAttrs,
  KlaviyoMetricAttrs, KlaviyoFlowAttrs, ValuesReportRow,
} from '../../../../src/connectors/klaviyo/client.js';

/**
 * Klaviyo connector tests use a hand-stubbed KlaviyoApiClient. Same pattern
 * as the Impact connector — keeps the unit isolated from HTTP and lets us
 * pin the server-side aggregation logic precisely.
 */

const PLACED_ORDER: KlaviyoResource<KlaviyoMetricAttrs> = {
  type: 'metric', id: 'Rewj5W', attributes: { name: 'Placed Order' },
};

const campaign = (overrides: Partial<KlaviyoResource<KlaviyoCampaignAttrs>> = {}): KlaviyoResource<KlaviyoCampaignAttrs> => ({
  type: 'campaign',
  id: overrides.id ?? '01KMJV10DFFA44PRQ2DM6706K5',
  attributes: {
    name: 'Spring Launch',
    status: 'Sent',
    archived: false,
    channel: 'email',
    scheduled_at: '2026-04-15T17:00:00+00:00',
    send_time: '2026-04-15T17:00:14+00:00',
    created_at: '2026-04-14T11:23:00+00:00',
    ...overrides.attributes,
  },
});

const segment = (id: string, name: string, count: number, extra: Partial<KlaviyoSegmentAttrs> = {}): KlaviyoResource<KlaviyoSegmentAttrs> => ({
  type: 'segment', id,
  attributes: { name, profile_count: count, is_active: true, is_processing: false, ...extra },
});

const reportRow = (overrides: Partial<ValuesReportRow> = {}): ValuesReportRow => ({
  groupings: { send_channel: 'email', campaign_id: '01CAMP', campaign_message_id: '01CAMP', ...overrides.groupings },
  statistics: { recipients: 1000, open_rate: 0.5, click_rate: 0.05, conversion_uniques: 5, conversion_value: 1000, unsubscribes: 10, ...overrides.statistics },
});

function makeStub(opts: {
  metrics?: KlaviyoResource<KlaviyoMetricAttrs>[];
  campaigns?: KlaviyoResource<KlaviyoCampaignAttrs>[];
  flows?: KlaviyoResource<KlaviyoFlowAttrs>[];
  segments?: KlaviyoResource<KlaviyoSegmentAttrs>[];
  campaignReportRows?: ValuesReportRow[];
  flowReportRows?: ValuesReportRow[];
  segmentReportRows?: ValuesReportRow[];
} = {}) {
  return {
    listMetrics: vi.fn(async () => opts.metrics ?? [PLACED_ORDER]),
    findMetricIdByName: vi.fn(async (name: string) => (opts.metrics ?? [PLACED_ORDER]).find((m) => m.attributes.name === name)?.id ?? null),
    listCampaigns: vi.fn(async () => opts.campaigns ?? []),
    listFlows: vi.fn(async () => opts.flows ?? []),
    listSegments: vi.fn(async () => opts.segments ?? []),
    campaignValuesReport: vi.fn(async () => opts.campaignReportRows ?? []),
    flowValuesReport: vi.fn(async () => opts.flowReportRows ?? []),
    segmentValuesReport: vi.fn(async () => opts.segmentReportRows ?? []),
  } as unknown as KlaviyoApiClient;
}

/** Stub signup-rollup repo for the existing tests that don't exercise it.
 *  Returns empty rows on getRange so tools that don't touch signup data are
 *  unaffected. */
function stubSignupRepo() {
  return {
    getRange: vi.fn(async () => []),
    upsertManyDays: vi.fn(),
    latestDay: vi.fn(),
    count: vi.fn(),
  } as any;
}

describe('klaviyo.list_campaigns', () => {
  it('returns campaigns with totalAcrossAccount + filter by search', async () => {
    const c = new KlaviyoConnector({
      client: makeStub({
        campaigns: [campaign({ id: 'A', attributes: { name: 'Spring Launch' } as any }), campaign({ id: 'B', attributes: { name: 'Black Friday' } as any })],
      }),
      signupRepo: stubSignupRepo(),
    });
    const tool = c.tools.find((t) => t.name === 'klaviyo.list_campaigns')!;
    const r = await tool.execute({ channel: 'email', archived: false, limit: 100, search: 'spring' }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.totalAcrossAccount).toBe(2);
    expect(r.data.count).toBe(1);
    expect(r.data.campaigns[0].name).toBe('Spring Launch');
  });
});

describe('klaviyo.list_segments', () => {
  const segReport = (id: string, total: number, added = 0, removed = 0): ValuesReportRow => ({
    groupings: { segment_id: id } as any,
    statistics: { total_members: total, members_added: added, members_removed: removed },
  });

  it('joins directory + segment-values-report, sorts by total_members, applies minProfileCount', async () => {
    const c = new KlaviyoConnector({
      client: makeStub({
        segments: [segment('s1', 'Tiny test', 0), segment('s2', 'Engaged 90d', 0), segment('s3', 'All Subs', 0)],
        segmentReportRows: [segReport('s1', 5), segReport('s2', 41210, 100, 80), segReport('s3', 124530, 200, 50)],
      }),
      signupRepo: stubSignupRepo(),
    });
    const tool = c.tools.find((t) => t.name === 'klaviyo.list_segments')!;
    const r = await tool.execute({ limit: 100, minProfileCount: 100 }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.count).toBe(2);
    expect(r.data.segments.map((s: any) => s.name)).toEqual(['All Subs', 'Engaged 90d']);
    expect(r.data.segments[0].profile_count).toBe(124530);
    expect(r.data.segments[0].members_added_30d).toBe(200);
  });

  it('returns segments with null counts if segment-values-report fails (degrades gracefully)', async () => {
    const stub = makeStub({ segments: [segment('s1', 'Foo', 0)] });
    (stub.segmentValuesReport as any).mockRejectedValueOnce(new Error('rate limited'));
    const c = new KlaviyoConnector({ client: stub, signupRepo: stubSignupRepo() });
    const tool = c.tools.find((t) => t.name === 'klaviyo.list_segments')!;
    const r = await tool.execute({ limit: 100 }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.count).toBe(1);
    expect(r.data.segments[0].profile_count).toBeNull();
  });
});

describe('klaviyo.campaign_performance', () => {
  it('returns rows with campaign_name resolved + totals over summable metrics', async () => {
    const c = new KlaviyoConnector({
      client: makeStub({
        campaigns: [campaign({ id: 'A', attributes: { name: 'Big Send' } as any }), campaign({ id: 'B', attributes: { name: 'Small Send' } as any })],
        campaignReportRows: [
          reportRow({ groupings: { campaign_id: 'A', send_channel: 'email' } as any, statistics: { recipients: 10000, open_rate: 0.6, click_rate: 0.05, conversion_uniques: 20, conversion_value: 5000, unsubscribes: 30 } }),
          reportRow({ groupings: { campaign_id: 'B', send_channel: 'email' } as any, statistics: { recipients: 1000, open_rate: 0.5, click_rate: 0.04, conversion_uniques: 2, conversion_value: 200, unsubscribes: 5 } }),
        ],
      }),
      signupRepo: stubSignupRepo(),
    });
    const tool = c.tools.find((t) => t.name === 'klaviyo.campaign_performance')!;
    const r = await tool.execute({
      dateRange: { startDate: '2026-04-01', endDate: '2026-04-27' },
      channel: 'email',
      metrics: ['recipients', 'open_rate', 'conversion_uniques', 'conversion_value', 'unsubscribes'],
      sortBy: 'conversion_value', limit: 50,
    }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.campaignCount).toBe(2);
    expect(r.data.campaigns[0].campaign_name).toBe('Big Send');
    expect(r.data.campaigns[0].conversion_value).toBe(5000);
    // totals sum the summable metrics, NOT rate metrics
    expect(r.data.totals).toEqual({ recipients: 11000, conversion_uniques: 22, conversion_value: 5200, unsubscribes: 35 });
    expect(r.data.totals.open_rate).toBeUndefined();
  });

  it('returns ok:false when Placed Order metric is not in account', async () => {
    const c = new KlaviyoConnector({ client: makeStub({ metrics: [] }), signupRepo: stubSignupRepo() });
    const tool = c.tools.find((t) => t.name === 'klaviyo.campaign_performance')!;
    const r = await tool.execute({
      dateRange: 'last_7_days', channel: 'email',
      metrics: ['recipients', 'open_rate'], sortBy: 'conversion_value', limit: 50,
    }) as any;
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('KLAVIYO_NO_PLACED_ORDER_METRIC');
  });

  it('accepts $REPORT_RANGE preset string (live-reports path)', async () => {
    const c = new KlaviyoConnector({
      client: makeStub({
        campaignReportRows: [reportRow({ groupings: { campaign_id: 'A' } as any, statistics: { recipients: 100, conversion_value: 50 } })],
      }),
      signupRepo: stubSignupRepo(),
    });
    const tool = c.tools.find((t) => t.name === 'klaviyo.campaign_performance')!;
    const r = await tool.execute({
      dateRange: 'last_30_days', channel: 'email',
      metrics: ['recipients', 'conversion_value'], sortBy: 'conversion_value', limit: 50,
    }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.dateRange.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('klaviyo.flow_performance', () => {
  it('aggregates rows by flow with name resolution', async () => {
    const c = new KlaviyoConnector({
      client: makeStub({
        flows: [{ type: 'flow', id: 'PJh', attributes: { name: 'Welcome Series', status: 'live', archived: false } as any }],
        flowReportRows: [
          reportRow({ groupings: { flow_id: 'PJh', flow_message_id: 'PJh-1', send_channel: 'email' } as any, statistics: { recipients: 8210, open_rate: 0.71, click_rate: 0.085, conversion_uniques: 67, conversion_value: 11200.45 } }),
        ],
      }),
      signupRepo: stubSignupRepo(),
    });
    const tool = c.tools.find((t) => t.name === 'klaviyo.flow_performance')!;
    const r = await tool.execute({
      dateRange: { startDate: '2026-04-01', endDate: '2026-04-27' },
      channel: 'email',
      metrics: ['recipients', 'open_rate', 'click_rate', 'conversion_uniques', 'conversion_value'],
      sortBy: 'conversion_value', limit: 50,
    }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.flowCount).toBe(1);
    expect(r.data.flows[0].flow_name).toBe('Welcome Series');
    expect(r.data.flows[0].conversion_value).toBe(11200.45);
  });

  it('omits send_channel filter when channel=all', async () => {
    const stub = makeStub({ flowReportRows: [] });
    const c = new KlaviyoConnector({ client: stub, signupRepo: stubSignupRepo() });
    const tool = c.tools.find((t) => t.name === 'klaviyo.flow_performance')!;
    await tool.execute({
      dateRange: 'last_7_days', channel: 'all',
      metrics: ['recipients'], sortBy: 'recipients', limit: 50,
    });
    const callArgs = (stub.flowValuesReport as any).mock.calls[0][0];
    expect(callArgs.filter).toBeUndefined();
  });
});

describe('klaviyo.consented_signups', () => {
  function makeConnector(rows: Array<{ day: string; signupsTotal: number; signupsConsentedEmail: number; computedAt: string }>) {
    const signupRepo = {
      getRange: vi.fn().mockResolvedValue(rows),
      upsertManyDays: vi.fn(),
      latestDay: vi.fn(),
      count: vi.fn(),
    } as any;
    const client = {} as any;
    const conn = new KlaviyoConnector({ client, signupRepo });
    const tool = conn.tools.find((t) => t.name === 'klaviyo.consented_signups')!;
    return { tool, signupRepo };
  }

  it('aggregates daily rows to monthly buckets', async () => {
    const { tool } = makeConnector([
      { day: '2026-01-01', signupsTotal: 10, signupsConsentedEmail: 7, computedAt: '2026-04-29T10:00:00.000Z' },
      { day: '2026-01-15', signupsTotal: 5, signupsConsentedEmail: 3, computedAt: '2026-04-29T10:00:00.000Z' },
      { day: '2026-02-01', signupsTotal: 8, signupsConsentedEmail: 5, computedAt: '2026-04-29T10:00:00.000Z' },
    ]);
    const out = await tool.execute({ dateRange: { startDate: '2026-01-01', endDate: '2026-02-28' }, granularity: 'monthly' }) as any;
    expect(out.rows).toEqual([
      { key: '2026-01', signupsTotal: 15, signupsConsentedEmail: 10 },
      { key: '2026-02', signupsTotal: 8, signupsConsentedEmail: 5 },
    ]);
  });

  it('passes through daily rows unchanged for granularity=daily', async () => {
    const { tool } = makeConnector([
      { day: '2026-01-01', signupsTotal: 1, signupsConsentedEmail: 1, computedAt: '2026-04-29T10:00:00.000Z' },
    ]);
    const out = await tool.execute({ dateRange: { startDate: '2026-01-01', endDate: '2026-01-01' }, granularity: 'daily' }) as any;
    expect(out.rows).toEqual([{ key: '2026-01-01', signupsTotal: 1, signupsConsentedEmail: 1 }]);
  });

  it('accepts a preset string for dateRange', async () => {
    const { tool } = makeConnector([]);
    await expect(tool.execute({ dateRange: 'last_30_days', granularity: 'monthly' })).resolves.toBeDefined();
  });

  it('returns empty rows + null rollupFreshness when no data exists', async () => {
    const { tool } = makeConnector([]);
    const out = await tool.execute({ dateRange: { startDate: '2030-01-01', endDate: '2030-12-31' }, granularity: 'monthly' }) as any;
    expect(out.rows).toEqual([]);
    expect(out.rollupFreshness).toEqual({ latestComputedDay: null, computedAt: null });
  });

  it('reports the latest computed day in rollupFreshness', async () => {
    const { tool } = makeConnector([
      { day: '2026-01-01', signupsTotal: 1, signupsConsentedEmail: 1, computedAt: '2026-04-29T10:00:00.000Z' },
      { day: '2026-01-02', signupsTotal: 1, signupsConsentedEmail: 1, computedAt: '2026-04-29T10:00:00.000Z' },
    ]);
    const out = await tool.execute({ dateRange: { startDate: '2026-01-01', endDate: '2026-01-31' }, granularity: 'daily' }) as any;
    expect(out.rollupFreshness.latestComputedDay).toBe('2026-01-02');
    expect(out.rollupFreshness.computedAt).toBe('2026-04-29T10:00:00.000Z');
  });

  it('aggregates weekly into ISO week buckets keyed by Monday', async () => {
    const { tool } = makeConnector([
      // 2026-01-01 is a Thursday — its ISO week starts Monday 2025-12-29.
      { day: '2026-01-01', signupsTotal: 4, signupsConsentedEmail: 2, computedAt: '2026-04-29T10:00:00.000Z' },
      { day: '2026-01-04', signupsTotal: 1, signupsConsentedEmail: 0, computedAt: '2026-04-29T10:00:00.000Z' },
      // 2026-01-05 is the Monday of the next ISO week.
      { day: '2026-01-05', signupsTotal: 6, signupsConsentedEmail: 4, computedAt: '2026-04-29T10:00:00.000Z' },
    ]);
    const out = await tool.execute({ dateRange: { startDate: '2026-01-01', endDate: '2026-01-31' }, granularity: 'weekly' }) as any;
    expect(out.rows).toEqual([
      { key: '2025-12-29', signupsTotal: 5, signupsConsentedEmail: 2 },
      { key: '2026-01-05', signupsTotal: 6, signupsConsentedEmail: 4 },
    ]);
  });
});
