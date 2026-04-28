import { describe, it, expect, vi } from 'vitest';
import { SearchConsoleConnector } from '../../../../src/connectors/gsc/connector.js';
import type {
  SearchConsoleApiClient, SearchAnalyticsRow, SiteInfo, InspectionResultRaw,
} from '../../../../src/connectors/gsc/client.js';

/**
 * Connector tests use a hand-stubbed SearchConsoleApiClient. Same pattern as
 * the other connectors — keeps the unit isolated from HTTP and pins the
 * server-side aggregation/normalization logic.
 */

const row = (overrides: Partial<SearchAnalyticsRow> = {}): SearchAnalyticsRow => ({
  keys: ['gantri'], clicks: 100, impressions: 200, ctr: 0.5, position: 1.5,
  ...overrides,
});

function makeStub(opts: {
  sites?: SiteInfo[];
  searchRows?: SearchAnalyticsRow[];
  inspection?: InspectionResultRaw;
  searchAnalyticsImpl?: SearchConsoleApiClient['searchAnalyticsQuery'];
} = {}) {
  return {
    listSites: vi.fn(async () => opts.sites ?? [{ siteUrl: 'sc-domain:gantri.com', permissionLevel: 'siteOwner' }]),
    searchAnalyticsQuery: opts.searchAnalyticsImpl
      ? vi.fn(opts.searchAnalyticsImpl)
      : vi.fn(async () => ({ rows: opts.searchRows ?? [] })),
    inspectUrl: vi.fn(async () => opts.inspection ?? { inspectionResult: {} }),
  } as unknown as SearchConsoleApiClient;
}

describe('gsc.list_sites', () => {
  it('returns the site list with permissionLevel', async () => {
    const c = new SearchConsoleConnector(makeStub({
      sites: [
        { siteUrl: 'sc-domain:gantri.com', permissionLevel: 'siteOwner' },
        { siteUrl: 'sc-domain:made.gantri.com', permissionLevel: 'siteFullUser' },
      ],
    }));
    const tool = c.tools.find((t) => t.name === 'gsc.list_sites')!;
    const r = await tool.execute({}) as any;
    expect(r.ok).toBe(true);
    expect(r.data.count).toBe(2);
    expect(r.data.sites[0].siteUrl).toBe('sc-domain:gantri.com');
  });
});

describe('gsc.search_performance', () => {
  it('passes the right siteUrl + dateRange + limit to the client and returns rows', async () => {
    const stub = makeStub({
      searchRows: [
        row({ keys: ['gantri'], clicks: 723, impressions: 1186, ctr: 0.61, position: 1.31 }),
        row({ keys: ['gantri lamp'], clicks: 126, impressions: 201, ctr: 0.63, position: 1.24 }),
      ],
    });
    const c = new SearchConsoleConnector(stub);
    const tool = c.tools.find((t) => t.name === 'gsc.search_performance')!;
    const r = await tool.execute({
      dateRange: { startDate: '2026-04-01', endDate: '2026-04-22' },
      dimensions: ['query'],
      sortBy: 'clicks',
      sortDirection: 'desc',
      limit: 100,
    }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.siteUrl).toBe('sc-domain:gantri.com');
    expect(r.data.rowCount).toBe(2);
    expect(r.data.rows[0].keys[0]).toBe('gantri');
    const callArgs = (stub.searchAnalyticsQuery as any).mock.calls[0];
    expect(callArgs[0]).toBe('sc-domain:gantri.com');
    expect(callArgs[1]).toMatchObject({ startDate: '2026-04-01', endDate: '2026-04-22', rowLimit: 100, dataState: 'final' });
    // No lag note for end date 5+ days back.
    expect(r.data.note).toBeUndefined();
  });

  it('honors siteUrl override (made.gantri.com)', async () => {
    const stub = makeStub();
    const c = new SearchConsoleConnector(stub);
    const tool = c.tools.find((t) => t.name === 'gsc.search_performance')!;
    await tool.execute({
      dateRange: { startDate: '2026-04-01', endDate: '2026-04-22' },
      dimensions: ['page'],
      sortBy: 'clicks', sortDirection: 'desc', limit: 50,
      siteUrl: 'sc-domain:made.gantri.com',
    });
    const callArgs = (stub.searchAnalyticsQuery as any).mock.calls[0];
    expect(callArgs[0]).toBe('sc-domain:made.gantri.com');
  });

  it('builds dimensionFilterGroups when filters are provided', async () => {
    const stub = makeStub();
    const c = new SearchConsoleConnector(stub);
    const tool = c.tools.find((t) => t.name === 'gsc.search_performance')!;
    await tool.execute({
      dateRange: { startDate: '2026-04-01', endDate: '2026-04-22' },
      dimensions: ['page'],
      pageFilter: { operator: 'contains', expression: '/products/' },
      countryFilter: { operator: 'equals', expression: 'usa' },
      sortBy: 'impressions', sortDirection: 'desc', limit: 100,
    });
    const body = (stub.searchAnalyticsQuery as any).mock.calls[0][1];
    expect(body.dimensionFilterGroups).toEqual([{
      groupType: 'and',
      filters: [
        { dimension: 'page', operator: 'contains', expression: '/products/' },
        { dimension: 'country', operator: 'equals', expression: 'usa' },
      ],
    }]);
  });

  it('computes impression-weighted position in totals (NOT a simple average)', async () => {
    const stub = makeStub({
      searchRows: [
        // High-impression row at position 2
        row({ keys: ['big'], clicks: 100, impressions: 10000, ctr: 0.01, position: 2 }),
        // Low-impression row at position 50 (would skew a naive avg)
        row({ keys: ['small'], clicks: 1, impressions: 10, ctr: 0.1, position: 50 }),
      ],
    });
    const c = new SearchConsoleConnector(stub);
    const tool = c.tools.find((t) => t.name === 'gsc.search_performance')!;
    const r = await tool.execute({
      dateRange: { startDate: '2026-04-01', endDate: '2026-04-22' },
      dimensions: ['query'],
      sortBy: 'clicks', sortDirection: 'desc', limit: 100,
    }) as any;
    // Weighted: (2*10000 + 50*10) / 10010 ≈ 2.048
    expect(r.data.totals.position).toBeCloseTo(2.05, 1);
    expect(r.data.totals.clicks).toBe(101);
    expect(r.data.totals.impressions).toBe(10010);
  });

  it('emits lag note when range ends within last 3 days', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const c = new SearchConsoleConnector(makeStub({ searchRows: [row()] }));
    const tool = c.tools.find((t) => t.name === 'gsc.search_performance')!;
    const r = await tool.execute({
      dateRange: { startDate: '2026-01-01', endDate: today },
      dimensions: ['query'],
      sortBy: 'clicks', sortDirection: 'desc', limit: 50,
    }) as any;
    expect(r.data.note).toContain('2-3 day reporting lag');
  });

  it('accepts $REPORT_RANGE preset (live-reports path)', async () => {
    const c = new SearchConsoleConnector(makeStub({ searchRows: [row()] }));
    const tool = c.tools.find((t) => t.name === 'gsc.search_performance')!;
    const r = await tool.execute({
      dateRange: 'last_30_days',
      dimensions: ['query'],
      sortBy: 'clicks', sortDirection: 'desc', limit: 50,
    }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.dateRange.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('gsc.inspect_url', () => {
  it('flattens the nested inspectionResult into a friendly shape', async () => {
    const c = new SearchConsoleConnector(makeStub({
      inspection: {
        inspectionResult: {
          inspectionResultLink: 'https://search.google.com/search-console/inspect?...',
          indexStatusResult: {
            verdict: 'PASS',
            coverageState: 'Indexed, not submitted in sitemap',
            robotsTxtState: 'ALLOWED',
            indexingState: 'INDEXING_ALLOWED',
            lastCrawlTime: '2026-04-22T14:32:11Z',
            googleCanonical: 'https://gantri.com/products/atto',
            userCanonical: 'https://gantri.com/products/atto',
            sitemap: ['https://gantri.com/sitemap.xml'],
            crawledAs: 'MOBILE',
          },
          mobileUsabilityResult: { verdict: 'PASS', issues: [] },
          ampResult: { verdict: 'NEUTRAL', issues: [] },
          richResultsResult: {
            verdict: 'PASS',
            detectedItems: [{ richResultType: 'Products', items: [{ name: 'Atto', issues: [] }] }],
          },
        },
      },
    }));
    const tool = c.tools.find((t) => t.name === 'gsc.inspect_url')!;
    const r = await tool.execute({ pageUrl: 'https://gantri.com/products/atto', languageCode: 'en-US' }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.url).toBe('https://gantri.com/products/atto');
    expect(r.data.indexStatusVerdict).toBe('PASS');
    expect(r.data.coverageState).toContain('Indexed');
    expect(r.data.googleCanonical).toBe('https://gantri.com/products/atto');
    expect(r.data.mobileUsabilityVerdict).toBe('PASS');
    expect(r.data.richResultsItems[0].richResultType).toBe('Products');
    expect(r.data.richResultsItems[0].name).toBe('Atto');
  });
});
