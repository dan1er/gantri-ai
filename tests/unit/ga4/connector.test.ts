import { describe, it, expect, vi } from 'vitest';
import { Ga4Connector } from '../../../src/connectors/ga4/connector.js';
import type { Ga4Client } from '../../../src/connectors/ga4/client.js';

function fakeClient(report: unknown): Ga4Client {
  return {
    runReport: vi.fn(async () => report),
    runRealtimeReport: vi.fn(),
  } as unknown as Ga4Client;
}

describe('Ga4Connector.ga4.run_report', () => {
  it('exposes the tool and validates args via Zod', async () => {
    const conn = new Ga4Connector({ client: fakeClient({}) });
    const tool = conn.tools.find((t) => t.name === 'ga4.run_report');
    expect(tool).toBeDefined();
    // missing required `metrics` should fail validation when called via the registry,
    // but here we exercise the schema directly:
    expect(tool!.schema.safeParse({}).success).toBe(false);
    expect(tool!.schema.safeParse({ metrics: ['sessions'] }).success).toBe(true);
  });

  it('reshapes the GA4 response into a flat rows array', async () => {
    const client = fakeClient({
      dimensionHeaders: [{ name: 'sessionDefaultChannelGroup' }],
      metricHeaders: [{ name: 'sessions', type: 'TYPE_INTEGER' }, { name: 'totalUsers', type: 'TYPE_INTEGER' }],
      rows: [
        { dimensionValues: [{ value: 'Direct' }], metricValues: [{ value: '120' }, { value: '95' }] },
        { dimensionValues: [{ value: 'Organic Search' }], metricValues: [{ value: '60' }, { value: '40' }] },
      ],
      rowCount: 2,
    });
    const conn = new Ga4Connector({ client });
    const tool = conn.tools.find((t) => t.name === 'ga4.run_report')!;
    const out = await tool.execute({
      dateRange: 'last_7_days',
      dimensions: ['sessionDefaultChannelGroup'],
      metrics: ['sessions', 'totalUsers'],
    }) as { rows: Array<Record<string, unknown>>; rowCount: number };
    expect(out.rowCount).toBe(2);
    expect(out.rows).toEqual([
      { sessionDefaultChannelGroup: 'Direct', sessions: 120, totalUsers: 95 },
      { sessionDefaultChannelGroup: 'Organic Search', sessions: 60, totalUsers: 40 },
    ]);
  });

  it('translates preset dateRange to GA4 relative-date strings', async () => {
    const client = { runReport: vi.fn(async () => ({ rows: [], rowCount: 0, dimensionHeaders: [], metricHeaders: [] })) } as unknown as Ga4Client;
    const conn = new Ga4Connector({ client });
    const tool = conn.tools.find((t) => t.name === 'ga4.run_report')!;
    await tool.execute({ dateRange: 'last_30_days', metrics: ['sessions'] });
    expect((client.runReport as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      metrics: [{ name: 'sessions' }],
    });
  });
});

describe('Ga4Connector.ga4.list_events', () => {
  it('tool exists with correct name and dateRange has a Zod default (not required)', () => {
    const conn = new Ga4Connector({ client: fakeClient({ rows: [], rowCount: 0, dimensionHeaders: [], metricHeaders: [] }) });
    const tool = conn.tools.find((t) => t.name === 'ga4.list_events');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('ga4.list_events');
    // dateRange has a default — omitting it must still parse successfully
    const parsed = tool!.schema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.dateRange).toBe('last_30_days');
    }
  });

  it('calls client.runReport with eventName dimension, eventCount + totalUsers metrics, ordered by eventCount desc', async () => {
    const client = fakeClient({ rows: [], rowCount: 0, dimensionHeaders: [], metricHeaders: [] });
    const conn = new Ga4Connector({ client });
    const tool = conn.tools.find((t) => t.name === 'ga4.list_events')!;
    const args = tool.schema.parse({ dateRange: 'last_7_days' });
    await tool.execute(args);
    const call = (client.runReport as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.dimensions).toEqual([{ name: 'eventName' }]);
    expect(call.metrics).toEqual([{ name: 'eventCount' }, { name: 'totalUsers' }]);
    expect(call.orderBys).toEqual([{ metric: { metricName: 'eventCount' }, desc: true }]);
  });

  it('returns flattened response with period, rowCount, dimensions, metrics, and typed rows', async () => {
    const client = fakeClient({
      dimensionHeaders: [{ name: 'eventName' }],
      metricHeaders: [{ name: 'eventCount', type: 'TYPE_INTEGER' }, { name: 'totalUsers', type: 'TYPE_INTEGER' }],
      rows: [
        { dimensionValues: [{ value: 'page_view' }], metricValues: [{ value: '15000' }, { value: '8000' }] },
        { dimensionValues: [{ value: 'scroll' }], metricValues: [{ value: '9000' }, { value: '5000' }] },
        { dimensionValues: [{ value: 'add_to_cart' }], metricValues: [{ value: '1200' }, { value: '900' }] },
      ],
      rowCount: 3,
    });
    const conn = new Ga4Connector({ client });
    const tool = conn.tools.find((t) => t.name === 'ga4.list_events')!;
    const args = tool.schema.parse({ dateRange: 'last_7_days' });
    const out = await tool.execute(args) as {
      period: unknown;
      rowCount: number;
      dimensions: string[];
      metrics: string[];
      rows: Array<{ eventName: string; eventCount: number; totalUsers: number }>;
    };
    expect(out.period).toBe('last_7_days');
    expect(out.rowCount).toBe(3);
    expect(out.dimensions).toEqual(['eventName']);
    expect(out.metrics).toEqual(['eventCount', 'totalUsers']);
    expect(out.rows).toEqual([
      { eventName: 'page_view', eventCount: 15000, totalUsers: 8000 },
      { eventName: 'scroll', eventCount: 9000, totalUsers: 5000 },
      { eventName: 'add_to_cart', eventCount: 1200, totalUsers: 900 },
    ]);
  });
});

describe('Ga4Connector.ga4.page_engagement_summary', () => {
  it('schema accepts an empty object and applies all defaults', () => {
    const conn = new Ga4Connector({ client: fakeClient({ rows: [], rowCount: 0, dimensionHeaders: [], metricHeaders: [] }) });
    const tool = conn.tools.find((t) => t.name === 'ga4.page_engagement_summary');
    expect(tool).toBeDefined();
    const parsed = tool!.schema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.dateRange).toBe('last_30_days');
      expect(parsed.data.minPageViews).toBe(500);
      expect(parsed.data.topN).toBe(20);
    }
  });

  it('computes scrollRate per page, filters low-traffic pages, returns correct rankings and totals', async () => {
    // 5 pages: A high traffic + good scroll, B medium traffic + excellent scroll,
    // C medium traffic + low scroll, D below minPageViews (noise), E flagged (scroll > page_view)
    // All well above 500 pageviews except D and E (E is above but has rate > 1)
    const makeRows = (pages: Array<{ path: string; pageViews: number; scrolls: number }>) =>
      pages.flatMap(({ path, pageViews, scrolls }) => [
        {
          dimensionValues: [{ value: path }, { value: 'page_view' }],
          metricValues: [{ value: String(pageViews) }, { value: String(Math.floor(pageViews * 0.8)) }],
        },
        {
          dimensionValues: [{ value: path }, { value: 'scroll' }],
          metricValues: [{ value: String(scrolls) }, { value: String(Math.floor(scrolls * 0.7)) }],
        },
      ]);

    const pages = [
      { path: '/products/', pageViews: 5000, scrolls: 3500 },  // scrollRate 0.7, eligible
      { path: '/collections/', pageViews: 2000, scrolls: 1800 }, // scrollRate 0.9, eligible
      { path: '/about/', pageViews: 800, scrolls: 200 },        // scrollRate 0.25, eligible (just above 500)
      { path: '/tiny/', pageViews: 100, scrolls: 80 },          // filtered out: < 500 pageViews
      { path: '/', pageViews: 1000, scrolls: 1500 },            // flagged: scrollRate 1.5 > 1.0
    ];

    const client = fakeClient({
      dimensionHeaders: [{ name: 'pagePath' }, { name: 'eventName' }],
      metricHeaders: [{ name: 'eventCount', type: 'TYPE_INTEGER' }, { name: 'totalUsers', type: 'TYPE_INTEGER' }],
      rows: makeRows(pages),
      rowCount: pages.length * 2,
    });

    const conn = new Ga4Connector({ client });
    const tool = conn.tools.find((t) => t.name === 'ga4.page_engagement_summary')!;
    const args = tool.schema.parse({ dateRange: 'last_30_days', minPageViews: 500, topN: 20 });
    const out = await tool.execute(args) as {
      totals: { pageViews: number; scrollEvents: number; siteScrollRate: number; uniquePagesObserved: number; eligiblePages: number };
      topByTraffic: Array<{ pagePath: string; pageViews: number; scrollRate: number }>;
      highestScrollRate: Array<{ pagePath: string; scrollRate: number }>;
      lowestScrollRate: Array<{ pagePath: string; scrollRate: number }>;
      flaggedPages: Array<{ pagePath: string; scrollRate: number }>;
      notes: string;
    };

    // scrollRate per eligible non-flagged page
    // /products/: 3500/5000 = 0.7
    // /collections/: 1800/2000 = 0.9
    // /about/: 200/800 = 0.25
    // /tiny/ excluded (< 500 pageViews)
    // /: flagged (rate 1.5 > 1)
    expect(out.totals.siteScrollRate).toBe(
      Math.round((3500 + 1800 + 200 + 80 + 1500) / (5000 + 2000 + 800 + 100 + 1000) * 1000) / 1000,
    );

    // topByTraffic sorted by pageViews desc (flagged / below-threshold excluded from ranking)
    expect(out.topByTraffic.map((r) => r.pagePath)).toEqual(['/products/', '/collections/', '/about/']);
    // highestScrollRate desc
    expect(out.highestScrollRate[0].pagePath).toBe('/collections/');
    expect(out.highestScrollRate[0].scrollRate).toBe(0.9);
    // lowestScrollRate asc
    expect(out.lowestScrollRate[0].pagePath).toBe('/about/');
    expect(out.lowestScrollRate[0].scrollRate).toBe(0.25);
    // flaggedPages
    expect(out.flaggedPages).toHaveLength(1);
    expect(out.flaggedPages[0].pagePath).toBe('/');
    expect(out.flaggedPages[0].scrollRate).toBeGreaterThan(1.0);
    // notes field present
    expect(typeof out.notes).toBe('string');
    expect(out.notes.length).toBeGreaterThan(0);
  });

  it('a page with scroll > page_view (rate > 100%) lands in flaggedPages and is excluded from all rankings', async () => {
    const client = fakeClient({
      dimensionHeaders: [{ name: 'pagePath' }, { name: 'eventName' }],
      metricHeaders: [{ name: 'eventCount', type: 'TYPE_INTEGER' }, { name: 'totalUsers', type: 'TYPE_INTEGER' }],
      rows: [
        // Normal page
        { dimensionValues: [{ value: '/blog/' }, { value: 'page_view' }], metricValues: [{ value: '2000' }, { value: '1500' }] },
        { dimensionValues: [{ value: '/blog/' }, { value: 'scroll' }], metricValues: [{ value: '1400' }, { value: '1000' }] },
        // Anomalous page: scrolls > page_views (home page with repeated scroll events)
        { dimensionValues: [{ value: '/' }, { value: 'page_view' }], metricValues: [{ value: '3000' }, { value: '2500' }] },
        { dimensionValues: [{ value: '/' }, { value: 'scroll' }], metricValues: [{ value: '6000' }, { value: '2000' }] },
      ],
      rowCount: 4,
    });

    const conn = new Ga4Connector({ client });
    const tool = conn.tools.find((t) => t.name === 'ga4.page_engagement_summary')!;
    const args = tool.schema.parse({ minPageViews: 100 });
    const out = await tool.execute(args) as {
      topByTraffic: Array<{ pagePath: string }>;
      highestScrollRate: Array<{ pagePath: string }>;
      lowestScrollRate: Array<{ pagePath: string }>;
      flaggedPages: Array<{ pagePath: string; scrollRate: number }>;
    };

    // '/' has scrollRate = 6000/3000 = 2.0 — must be in flaggedPages
    const flagged = out.flaggedPages.find((r) => r.pagePath === '/');
    expect(flagged).toBeDefined();
    expect(flagged!.scrollRate).toBeGreaterThan(1.0);

    // '/' must NOT appear in any ranking
    const allRanked = [...out.topByTraffic, ...out.highestScrollRate, ...out.lowestScrollRate];
    expect(allRanked.some((r) => r.pagePath === '/')).toBe(false);

    // '/blog/' should appear in rankings with scrollRate 0.7
    expect(out.topByTraffic.some((r) => r.pagePath === '/blog/')).toBe(true);
  });
});
