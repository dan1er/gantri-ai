/**
 * Unit tests for the marketing-analysis connector.
 *
 * Strategy: mock `nb.runExport` and `nb.listBreakdowns` directly on a fake
 * NorthbeamApiClient so no HTTP calls are made. Fixtures use the exact CSV
 * column names from METRIC_TO_COL in the source:
 *
 *   rev, spend, transactions, cac, cac_1st_time, aov_1st_time,
 *   ltv_aov_1st_time, roas_1st_time, ltv_roas_1st_time, rev_1st_time,
 *   rev_returning, transactions_1st_time, transactions_returning
 *
 * The breakdown column for `Platform (Northbeam)` is
 * `breakdown_platform_northbeam`.
 *
 * Important: `ToolDef.execute` receives already-validated (Zod-parsed) args in
 * production. In tests we must supply all fields including defaults explicitly,
 * or parse args through the Zod schema to trigger `.default()` transforms
 * before calling execute.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarketingAnalysisConnector } from '../../../../src/connectors/marketing-analysis/connector.js';
import type { NorthbeamApiClient } from '../../../../src/connectors/northbeam-api/client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParsedCsv(headers: string[], rows: Array<Record<string, string>>) {
  return {
    headers,
    rows,
    raw: [headers.join(','), ...rows.map((r) => headers.map((h) => r[h] ?? '').join(','))].join('\n'),
  };
}

/** Build a minimal fake NB client with vitest mocks. */
function makeClient() {
  return {
    runExport: vi.fn(),
    listBreakdowns: vi.fn().mockResolvedValue([
      {
        key: 'Platform (Northbeam)',
        values: ['Facebook Ads', 'Google Ads', 'Email', 'Direct'],
      },
      {
        key: 'Forecast',
        values: ['Paid Social', 'Paid Search', 'Email'],
      },
      {
        key: 'Category (Northbeam)',
        values: ['Prospecting', 'Retargeting'],
      },
    ]),
  } as unknown as NorthbeamApiClient;
}

const DATE_RANGE = { startDate: '2026-01-01', endDate: '2026-01-31' };

// ---------------------------------------------------------------------------
// attribution_compare_models
// ---------------------------------------------------------------------------

describe('gantri.attribution_compare_models', () => {
  let client: ReturnType<typeof makeClient>;
  let connector: MarketingAnalysisConnector;
  let tool: (typeof connector.tools)[number];

  const PLATFORM_COL = 'breakdown_platform_northbeam';
  const COMPARE_HEADERS = [PLATFORM_COL, 'rev', 'spend', 'transactions'];

  // Fixture factory — one row per channel per model call.
  function makeCompareRows(revFactor = 1) {
    return [
      { [PLATFORM_COL]: 'Facebook Ads', rev: String(10000 * revFactor), spend: '3000', transactions: '50' },
      { [PLATFORM_COL]: 'Google Ads', rev: String(8000 * revFactor), spend: '2500', transactions: '40' },
      { [PLATFORM_COL]: 'Email', rev: String(5000 * revFactor), spend: '500', transactions: '30' },
    ];
  }

  beforeEach(() => {
    client = makeClient();
    connector = new MarketingAnalysisConnector({ nb: client });
    tool = connector.tools.find((t) => t.name === 'gantri.attribution_compare_models')!;
  });

  it('schema validates default args (just dateRange + default metrics)', async () => {
    (client.runExport as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeParsedCsv(COMPARE_HEADERS, makeCompareRows()),
    );
    // Supply defaults explicitly (as Zod.parse would produce them).
    const result = await tool.execute({
      dateRange: DATE_RANGE,
      metrics: ['rev', 'spend', 'txns'],
    } as any);
    expect(result).toBeDefined();
    const r = result as any;
    expect(r.period).toEqual(DATE_RANGE);
    expect(r.models).toHaveLength(7);
  });

  it('makes exactly 7 runExport calls — one per attribution model — in sequence', async () => {
    (client.runExport as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeParsedCsv(COMPARE_HEADERS, makeCompareRows()),
    );

    await tool.execute({
      dateRange: DATE_RANGE,
      metrics: ['rev', 'spend', 'txns'],
    } as any);

    expect(client.runExport).toHaveBeenCalledTimes(7);

    const expectedModels = [
      'northbeam_custom',
      'northbeam_custom__enh',
      'northbeam_custom__va',
      'last_touch',
      'last_touch_non_direct',
      'first_touch',
      'linear',
    ];
    const calledModels = (client.runExport as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: any[]) => call[0].attribution_options.attribution_models[0],
    );
    expect(calledModels).toEqual(expectedModels);
  });

  it('groups rows by model and returns aggregated metrics + derived roas', async () => {
    // Give each model a unique rev multiplier so we can identify them.
    let callCount = 0;
    const multipliers = [1, 1.1, 1.2, 0.9, 0.8, 1.3, 1.15];
    (client.runExport as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      return makeParsedCsv(COMPARE_HEADERS, makeCompareRows(multipliers[callCount++] ?? 1));
    });

    const result = await tool.execute({
      dateRange: DATE_RANGE,
      metrics: ['rev', 'spend', 'txns'],
    } as any) as any;

    // One entry per model (7 total).
    expect(result.models).toHaveLength(7);

    const nbCustom = result.models.find((m: any) => m.model_id === 'northbeam_custom');
    expect(nbCustom).toBeDefined();
    expect(typeof nbCustom.rev).toBe('number');
    expect(typeof nbCustom.spend).toBe('number');
    // roas should be derived when both rev and spend are present.
    expect(nbCustom.roas).toBeCloseTo(nbCustom.rev / nbCustom.spend, 1);

    // Period is echoed back.
    expect(result.period).toEqual(DATE_RANGE);
  });

  it('respects the `models` subset arg — only calls runExport for the requested models', async () => {
    (client.runExport as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeParsedCsv(COMPARE_HEADERS, makeCompareRows()),
    );

    await tool.execute({
      dateRange: DATE_RANGE,
      metrics: ['rev', 'spend'],
      models: ['last_touch', 'first_touch'],
    } as any);

    expect(client.runExport).toHaveBeenCalledTimes(2);
    const calledModels = (client.runExport as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: any[]) => call[0].attribution_options.attribution_models[0],
    );
    expect(calledModels).toEqual(['last_touch', 'first_touch']);
  });

  it('returns an error-bearing entry when a model call throws, others still succeed', async () => {
    (client.runExport as ReturnType<typeof vi.fn>).mockImplementation(async (payload: any) => {
      if (payload.attribution_options.attribution_models[0] === 'last_touch') {
        throw new Error('NB timeout');
      }
      return makeParsedCsv(COMPARE_HEADERS, makeCompareRows());
    });

    const result = await tool.execute({
      dateRange: DATE_RANGE,
      metrics: ['rev', 'spend', 'txns'],
    } as any) as any;

    const failed = result.models.find((m: any) => m.model_id === 'last_touch');
    expect(failed).toBeDefined();
    expect(failed.error).toBe('NB timeout');
    // Six other models should still succeed (no error field).
    expect(result.models.filter((m: any) => !m.error)).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// ltv_cac_by_channel
// ---------------------------------------------------------------------------

describe('gantri.ltv_cac_by_channel', () => {
  let client: ReturnType<typeof makeClient>;
  let connector: MarketingAnalysisConnector;
  let tool: (typeof connector.tools)[number];

  const LTV_HEADERS = [
    'breakdown_platform_northbeam',
    'rev',
    'rev_1st_time',
    'spend',
    'cac_1st_time',
    'aov_1st_time',
    'ltv_aov_1st_time',
    'roas_1st_time',
    'ltv_roas_1st_time',
  ];

  const LTV_ROWS = [
    {
      breakdown_platform_northbeam: 'Facebook Ads',
      rev: '12000',
      rev_1st_time: '8000',
      spend: '3000',
      cac_1st_time: '60',        // ltv_cac_ratio = 240 / 60 = 4.0
      aov_1st_time: '200',
      ltv_aov_1st_time: '240',
      roas_1st_time: '2.67',
      ltv_roas_1st_time: '3.2',
    },
    {
      breakdown_platform_northbeam: 'Google Ads',
      rev: '9000',
      rev_1st_time: '4500',
      spend: '2500',
      cac_1st_time: '100',       // ltv_cac_ratio = 350 / 100 = 3.5
      aov_1st_time: '280',
      ltv_aov_1st_time: '350',
      roas_1st_time: '1.8',
      ltv_roas_1st_time: '2.25',
    },
    {
      breakdown_platform_northbeam: 'Email',
      rev: '5000',
      rev_1st_time: '1000',
      spend: '500',
      cac_1st_time: '25',        // ltv_cac_ratio = 75 / 25 = 3.0
      aov_1st_time: '50',
      ltv_aov_1st_time: '75',
      roas_1st_time: '2.0',
      ltv_roas_1st_time: '3.0',
    },
  ];

  beforeEach(() => {
    client = makeClient();
    connector = new MarketingAnalysisConnector({ nb: client });
    tool = connector.tools.find((t) => t.name === 'gantri.ltv_cac_by_channel')!;
    (client.runExport as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeParsedCsv(LTV_HEADERS, LTV_ROWS),
    );
  });

  it('schema validates: only dateRange is required; breakdownKey defaults to Platform (Northbeam)', async () => {
    // Pass fully-resolved args (breakdownKey with the default value filled in).
    const result = await tool.execute({
      dateRange: DATE_RANGE,
      breakdownKey: 'Platform (Northbeam)',
    } as any) as any;

    expect(result.breakdown).toBe('Platform (Northbeam)');
    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('makes a single runExport call with all LTV metrics and northbeam_custom__va model', async () => {
    await tool.execute({
      dateRange: DATE_RANGE,
      breakdownKey: 'Platform (Northbeam)',
    } as any);

    expect(client.runExport).toHaveBeenCalledTimes(1);

    const call = (client.runExport as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.attribution_options.attribution_models).toEqual(['northbeam_custom__va']);

    const metricIds = call.metrics.map((m: any) => m.id);
    // All LTV_METRICS from the source must be present.
    for (const id of ['cacFt', 'aovFt', 'aovFtLtv', 'roasFt', 'roasFtLtv', 'rev', 'revFt', 'spend']) {
      expect(metricIds).toContain(id);
    }
  });

  it('computes ltv_cac_ratio = aovFtLtv / cacFt per channel', async () => {
    const result = await tool.execute({
      dateRange: DATE_RANGE,
      breakdownKey: 'Platform (Northbeam)',
    } as any) as any;

    const fb = result.rows.find((r: any) => r.channel === 'Facebook Ads');
    const google = result.rows.find((r: any) => r.channel === 'Google Ads');
    const email = result.rows.find((r: any) => r.channel === 'Email');

    expect(fb.ltv_cac_ratio).toBeCloseTo(4.0, 1);   // 240 / 60
    expect(google.ltv_cac_ratio).toBeCloseTo(3.5, 1); // 350 / 100
    expect(email.ltv_cac_ratio).toBeCloseTo(3.0, 1);  // 75  / 25
  });

  it('ranks channels by ltv_cac_ratio descending (highest ratio = best quality customer)', async () => {
    const result = await tool.execute({
      dateRange: DATE_RANGE,
      breakdownKey: 'Platform (Northbeam)',
    } as any) as any;

    const ratios = result.rows.map((r: any) => r.ltv_cac_ratio);
    const sortedDesc = [...ratios].sort((a: any, b: any) => b - a);
    expect(ratios).toEqual(sortedDesc);
    // Facebook Ads has the best ratio (4.0) and must be first.
    expect(result.rows[0].channel).toBe('Facebook Ads');
  });

  it('returns null for ltv_cac_ratio when cacFt is zero', async () => {
    const rows = [
      ...LTV_ROWS,
      {
        breakdown_platform_northbeam: 'Direct',
        rev: '2000',
        rev_1st_time: '500',
        spend: '0',
        cac_1st_time: '0',       // zero → ratio should be null
        aov_1st_time: '100',
        ltv_aov_1st_time: '120',
        roas_1st_time: '',
        ltv_roas_1st_time: '',
      },
    ];
    (client.runExport as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeParsedCsv(LTV_HEADERS, rows),
    );

    const result = await tool.execute({
      dateRange: DATE_RANGE,
      breakdownKey: 'Platform (Northbeam)',
    } as any) as any;

    const direct = result.rows.find((r: any) => r.channel === 'Direct');
    expect(direct).toBeDefined();
    expect(direct.ltv_cac_ratio).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// new_vs_returning_split
// ---------------------------------------------------------------------------

describe('gantri.new_vs_returning_split', () => {
  let client: ReturnType<typeof makeClient>;
  let connector: MarketingAnalysisConnector;
  let tool: (typeof connector.tools)[number];

  const NVR_HEADERS = [
    'breakdown_platform_northbeam',
    'rev',
    'rev_1st_time',
    'rev_returning',
    'transactions',
    'transactions_1st_time',
    'transactions_returning',
    'spend',
    'cac',
    'cac_1st_time',
  ];

  const NVR_ROWS = [
    {
      breakdown_platform_northbeam: 'Facebook Ads',
      rev: '15000',
      rev_1st_time: '9000',
      rev_returning: '6000',
      transactions: '75',
      transactions_1st_time: '45',
      transactions_returning: '30',
      spend: '4000',
      cac: '53.33',
      cac_1st_time: '88.89',
    },
    {
      breakdown_platform_northbeam: 'Google Ads',
      rev: '10000',
      rev_1st_time: '3000',
      rev_returning: '7000',
      transactions: '50',
      transactions_1st_time: '15',
      transactions_returning: '35',
      spend: '2500',
      cac: '50',
      cac_1st_time: '166.67',
    },
    {
      breakdown_platform_northbeam: 'Email',
      rev: '4000',
      rev_1st_time: '400',
      rev_returning: '3600',
      transactions: '20',
      transactions_1st_time: '2',
      transactions_returning: '18',
      spend: '200',
      cac: '10',
      cac_1st_time: '100',
    },
  ];

  beforeEach(() => {
    client = makeClient();
    connector = new MarketingAnalysisConnector({ nb: client });
    tool = connector.tools.find((t) => t.name === 'gantri.new_vs_returning_split')!;
    (client.runExport as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeParsedCsv(NVR_HEADERS, NVR_ROWS),
    );
  });

  it('schema accepts optional level=campaign; defaults to platform', async () => {
    // Default (platform).
    const r1 = await tool.execute({
      dateRange: DATE_RANGE,
      breakdownKey: 'Platform (Northbeam)',
      level: 'platform',
    } as any) as any;
    expect(r1.level).toBe('platform');

    // Explicit campaign.
    (client.runExport as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeParsedCsv(NVR_HEADERS, NVR_ROWS),
    );
    const r2 = await tool.execute({
      dateRange: DATE_RANGE,
      breakdownKey: 'Platform (Northbeam)',
      level: 'campaign',
    } as any) as any;
    expect(r2.level).toBe('campaign');
  });

  it('returns revenue_new, revenue_returning, and pct_new_revenue per channel', async () => {
    const result = await tool.execute({
      dateRange: DATE_RANGE,
      breakdownKey: 'Platform (Northbeam)',
      level: 'platform',
    } as any) as any;

    const fb = result.rows.find((r: any) => r.channel === 'Facebook Ads');
    expect(fb.revenue_new).toBe(9000);
    expect(fb.revenue_returning).toBe(6000);
    expect(fb.revenue_total).toBe(15000);
    // pct = (9000 / 15000) * 100 = 60.0
    expect(fb.pct_new_revenue).toBeCloseTo(60, 1);

    const google = result.rows.find((r: any) => r.channel === 'Google Ads');
    // pct = (3000 / 10000) * 100 = 30.0
    expect(google.pct_new_revenue).toBeCloseTo(30, 1);
  });

  it('handles channels with zero revenue — pct_new_revenue is 0, no NaN', async () => {
    const zeroRow = {
      breakdown_platform_northbeam: 'Direct',
      rev: '0',
      rev_1st_time: '0',
      rev_returning: '0',
      transactions: '0',
      transactions_1st_time: '0',
      transactions_returning: '0',
      spend: '0',
      cac: '0',
      cac_1st_time: '0',
    };
    (client.runExport as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeParsedCsv(NVR_HEADERS, [...NVR_ROWS, zeroRow]),
    );

    const result = await tool.execute({
      dateRange: DATE_RANGE,
      breakdownKey: 'Platform (Northbeam)',
      level: 'platform',
    } as any) as any;

    const direct = result.rows.find((r: any) => r.channel === 'Direct');
    expect(direct).toBeDefined();
    expect(direct.pct_new_revenue).toBe(0);
    expect(Number.isNaN(direct.pct_new_revenue)).toBe(false);
  });

  it('sorts rows descending by revenue_total (highest-revenue channel first)', async () => {
    const result = await tool.execute({
      dateRange: DATE_RANGE,
      breakdownKey: 'Platform (Northbeam)',
      level: 'platform',
    } as any) as any;

    const totals = result.rows.map((r: any) => r.revenue_total);
    for (let i = 0; i < totals.length - 1; i++) {
      expect(totals[i]).toBeGreaterThanOrEqual(totals[i + 1]);
    }
  });

  it('includes campaign field on each row when level=campaign', async () => {
    const campaignHeaders = [...NVR_HEADERS, 'campaign_name'];
    const campaignRows = NVR_ROWS.map((r, i) => ({ ...r, campaign_name: `Campaign ${i + 1}` }));
    (client.runExport as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeParsedCsv(campaignHeaders, campaignRows),
    );

    const result = await tool.execute({
      dateRange: DATE_RANGE,
      breakdownKey: 'Platform (Northbeam)',
      level: 'campaign',
    } as any) as any;

    for (const row of result.rows) {
      expect(row.campaign).toBeDefined();
      expect(typeof row.campaign).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// budget_optimization_report
// ---------------------------------------------------------------------------

describe('gantri.budget_optimization_report', () => {
  let client: ReturnType<typeof makeClient>;
  let connector: MarketingAnalysisConnector;
  let tool: (typeof connector.tools)[number];

  const CURRENT_PERIOD = { startDate: '2026-01-01', endDate: '2026-01-31' };
  const PRIOR_PERIOD = { startDate: '2025-12-01', endDate: '2025-12-31' };

  const BUDGET_HEADERS = [
    'campaign_name',
    'breakdown_platform_northbeam',
    'rev',
    'spend',
    'transactions',
    'accounting_mode',
  ];

  // current period rows: spend=2000/800/1000, prior is 80% of those.
  function makeCurrentRows() {
    return [
      {
        campaign_name: 'Prospecting Broad',
        breakdown_platform_northbeam: 'Facebook Ads',
        rev: '5000',
        spend: '2000',
        transactions: '25',
        accounting_mode: 'Cash snapshot',
      },
      {
        campaign_name: 'Retargeting Dynamic',
        breakdown_platform_northbeam: 'Facebook Ads',
        rev: '3000',
        spend: '800',
        transactions: '15',
        accounting_mode: 'Cash snapshot',
      },
      {
        campaign_name: 'Brand Keywords',
        breakdown_platform_northbeam: 'Google Ads',
        rev: '4000',
        spend: '1000',
        transactions: '20',
        accounting_mode: 'Cash snapshot',
      },
    ];
  }

  function makePriorRows() {
    // 80% of current values — produces positive delta_spend.
    return makeCurrentRows().map((r) => ({
      ...r,
      rev: String(Number(r.rev) * 0.8),
      spend: String(Number(r.spend) * 0.8),
    }));
  }

  beforeEach(() => {
    client = makeClient();
    connector = new MarketingAnalysisConnector({ nb: client });
    tool = connector.tools.find((t) => t.name === 'gantri.budget_optimization_report')!;
  });

  const BASE_ARGS = {
    currentPeriod: CURRENT_PERIOD,
    priorPeriod: PRIOR_PERIOD,
    minSpendDollars: 100,
  };

  function setupDefaultMocks() {
    (client.runExport as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () =>
        makeParsedCsv(BUDGET_HEADERS, makeCurrentRows()),
      )
      .mockImplementationOnce(async () =>
        makeParsedCsv(BUDGET_HEADERS, makePriorRows()),
      );
  }

  it('schema accepts optional platformFilter; returns period echo', async () => {
    setupDefaultMocks();
    const result = await tool.execute({ ...BASE_ARGS } as any) as any;
    expect(result).toBeDefined();
    expect(result.currentPeriod).toEqual(CURRENT_PERIOD);
    expect(result.priorPeriod).toEqual(PRIOR_PERIOD);
  });

  it('makes exactly 2 runExport calls — first for current period, second for prior period', async () => {
    setupDefaultMocks();
    await tool.execute({ ...BASE_ARGS } as any);

    expect(client.runExport).toHaveBeenCalledTimes(2);
    const calls = (client.runExport as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].period_options.period_starting_at).toContain(CURRENT_PERIOD.startDate);
    expect(calls[1][0].period_options.period_starting_at).toContain(PRIOR_PERIOD.startDate);
  });

  it('computes marginal_roas = delta_rev / delta_spend per campaign', async () => {
    setupDefaultMocks();
    const result = await tool.execute({ ...BASE_ARGS } as any) as any;

    const prospecting = result.rows.find((r: any) => r.campaign === 'Prospecting Broad');
    expect(prospecting).toBeDefined();

    // current: rev=5000 spend=2000; prior: rev=4000 spend=1600
    // dRev=1000, dSpend=400 → marginal_roas = 2.5
    expect(prospecting.delta_rev).toBeCloseTo(1000, 0);
    expect(prospecting.delta_spend).toBeCloseTo(400, 0);
    expect(prospecting.marginal_roas).toBeCloseTo(2.5, 1);
  });

  it('when platformFilter is provided, only returns rows from that platform', async () => {
    // Mock returns ALL platforms, but the connector passes a breakdown filter to NB,
    // so the mock rows from the "filtered" export should only include Facebook Ads rows.
    const fbOnlyCurrentRows = makeCurrentRows().filter((r) => r.breakdown_platform_northbeam === 'Facebook Ads');
    const fbOnlyPriorRows = makePriorRows().filter((r) => r.breakdown_platform_northbeam === 'Facebook Ads');

    (client.runExport as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () =>
        makeParsedCsv(BUDGET_HEADERS, fbOnlyCurrentRows),
      )
      .mockImplementationOnce(async () =>
        makeParsedCsv(BUDGET_HEADERS, fbOnlyPriorRows),
      );

    const result = await tool.execute({
      ...BASE_ARGS,
      platformFilter: 'Facebook Ads',
    } as any) as any;

    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.platform).toBe('Facebook Ads');
    }
    expect(result.rows.find((r: any) => r.campaign === 'Brand Keywords')).toBeUndefined();
  });

  it('drops campaigns with current spend below minSpendDollars', async () => {
    const lowSpendCurrentRows = [
      ...makeCurrentRows(),
      {
        campaign_name: 'Micro Test',
        breakdown_platform_northbeam: 'Facebook Ads',
        rev: '50',
        spend: '10',         // below $100 threshold
        transactions: '1',
        accounting_mode: 'Cash snapshot',
      },
    ];

    (client.runExport as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () =>
        makeParsedCsv(BUDGET_HEADERS, lowSpendCurrentRows),
      )
      .mockImplementationOnce(async () =>
        makeParsedCsv(BUDGET_HEADERS, makePriorRows()),
      );

    const result = await tool.execute({ ...BASE_ARGS } as any) as any;
    expect(result.rows.find((r: any) => r.campaign === 'Micro Test')).toBeUndefined();
    // The three "normal" campaigns (all spend ≥ $100) should still appear.
    expect(result.rows.length).toBe(3);
  });

  it('returns null for marginal_roas when delta_spend is near zero', async () => {
    // Same spend in both periods → delta_spend = 0 → marginal_roas = null.
    const stableRows = [
      {
        campaign_name: 'Stable Campaign',
        breakdown_platform_northbeam: 'Google Ads',
        rev: '3000',
        spend: '1000',
        transactions: '15',
        accounting_mode: 'Cash snapshot',
      },
    ];

    (client.runExport as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () =>
        makeParsedCsv(BUDGET_HEADERS, stableRows),
      )
      .mockImplementationOnce(async () =>
        makeParsedCsv(BUDGET_HEADERS, stableRows), // identical prior
      );

    const result = await tool.execute({ ...BASE_ARGS } as any) as any;
    const stable = result.rows.find((r: any) => r.campaign === 'Stable Campaign');
    expect(stable).toBeDefined();
    expect(stable.marginal_roas).toBeNull();
  });

  it('sorts rows by marginal_roas ascending (worst marginal efficiency first)', async () => {
    setupDefaultMocks();
    const result = await tool.execute({ ...BASE_ARGS } as any) as any;

    const sortKey = result.rows.map((r: any) => r.marginal_roas ?? r.current_roas ?? 999);
    for (let i = 0; i < sortKey.length - 1; i++) {
      expect(sortKey[i]).toBeLessThanOrEqual(sortKey[i + 1]);
    }
  });
});
