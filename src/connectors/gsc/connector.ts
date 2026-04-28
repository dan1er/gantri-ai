import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import { logger } from '../../logger.js';
import {
  SearchConsoleApiClient,
  SearchConsoleApiError,
  type SearchConsoleApiConfig,
  type SearchAnalyticsRow,
  type GscDimension,
} from './client.js';

/**
 * Google Search Console connector — read-only SEO visibility for gantri.com
 * and made.gantri.com. Three tools: list_sites, search_performance,
 * inspect_url. Auth is OAuth2 with a long-lived refresh token (Danny's
 * verified-owner account).
 *
 * GSC reporting data has a 2-3 day lag; the connector emits a `note` field
 * whenever the requested range ends inside the last 3 days so the LLM can
 * pass that to the user.
 */

const PT_PRESETS = [
  'yesterday', 'last_7_days', 'last_14_days', 'last_30_days', 'last_90_days',
  'last_180_days', 'last_365_days', 'this_month', 'last_month',
  'month_to_date', 'quarter_to_date', 'year_to_date',
] as const;

const DateRange = z.union([
  z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  }),
  z.object({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  }),
  z.enum(PT_PRESETS),
]);
type DateRangeArg = z.infer<typeof DateRange>;

/** Default property — gantri.com (Domain property: `sc-domain:gantri.com`). The
 *  LLM passes `siteUrl` to switch to `sc-domain:made.gantri.com` when needed. */
const DEFAULT_SITE_URL = 'sc-domain:gantri.com';

const FilterShape = z.object({
  operator: z.enum(['contains', 'equals', 'notContains', 'notEquals']),
  expression: z.string().min(1).max(500),
});

const ListSitesArgs = z.object({});
type ListSitesArgs = z.infer<typeof ListSitesArgs>;

const SearchPerformanceArgs = z.object({
  dateRange: DateRange,
  dimensions: z.array(z.enum(['date', 'query', 'page', 'country', 'device', 'searchAppearance']))
    .min(1).max(3)
    .describe('1-3 dimensions to group results by. Common: ["query"], ["page"], ["query","page"], ["date"].'),
  pageFilter: FilterShape.optional().describe('Filter rows by page URL. Use `contains` "/products/" to scope to product pages.'),
  queryFilter: FilterShape.optional().describe('Filter rows by search query.'),
  countryFilter: z.object({
    operator: z.enum(['equals', 'notEquals']),
    expression: z.string().regex(/^[a-z]{3}$/, 'ISO 3166-1 alpha-3 lowercase, e.g. "usa"'),
  }).optional(),
  deviceFilter: z.object({
    operator: z.enum(['equals', 'notEquals']),
    expression: z.enum(['DESKTOP', 'MOBILE', 'TABLET']),
  }).optional(),
  sortBy: z.enum(['clicks', 'impressions', 'ctr', 'position']).default('clicks'),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
  limit: z.number().int().min(1).max(1000).default(100),
  siteUrl: z.string().optional().describe(`Optional siteUrl override. Defaults to gantri.com (\`${DEFAULT_SITE_URL}\`). Pass \`sc-domain:made.gantri.com\` for the made-to-order subdomain.`),
});
type SearchPerformanceArgs = z.infer<typeof SearchPerformanceArgs>;

const InspectUrlArgs = z.object({
  pageUrl: z.string().url('must be a full URL'),
  siteUrl: z.string().optional(),
  languageCode: z.string().default('en-US'),
});
type InspectUrlArgs = z.infer<typeof InspectUrlArgs>;

export class SearchConsoleConnector implements Connector {
  readonly name = 'gsc';
  readonly tools: readonly ToolDef[];

  constructor(private readonly client: SearchConsoleApiClient) {
    this.tools = this.buildTools();
  }

  async healthCheck() {
    try {
      const sites = await this.client.listSites();
      return sites.length > 0
        ? { ok: true, detail: `${sites.length} verified sites` }
        : { ok: false, detail: 'no sites accessible to this OAuth identity' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private buildTools(): readonly ToolDef[] {
    return [
      {
        name: 'gsc.list_sites',
        description: [
          'Lists Google Search Console properties this OAuth identity has access to. { count, sites: [{ siteUrl, permissionLevel }] }.',
          'Mostly for discovery / health-check. For Gantri the canonical properties are `sc-domain:gantri.com` (default) and `sc-domain:made.gantri.com`.',
        ].join(' '),
        schema: ListSitesArgs as z.ZodType<z.infer<typeof ListSitesArgs>>,
        jsonSchema: zodToJsonSchema(ListSitesArgs),
        execute: async () => {
          try {
            const sites = await this.client.listSites();
            return {
              ok: true,
              data: {
                count: sites.length,
                sites: sites.map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel ?? null })),
              },
            };
          } catch (err) { return errorResult(err); }
        },
      },
      {
        name: 'gsc.search_performance',
        description: [
          "Per-row search performance from Google Search Console — clicks, impressions, ctr, and average position grouped by 1-3 of [date, query, page, country, device, searchAppearance] over a date range.",
          'Use for "top queries by clicks", "ranking trend for product pages", "low-CTR opportunities", "404 URLs Google indexed (filter page contains \'/404\' or pageFilter on a stale path)", "search traffic by country/device".',
          'GSC data has a 2-3 day reporting lag — recent days will be partial. Connector emits a `note` field if the range ends within the last 3 days.',
          'CTR is decimal (0.034 = 3.4%); position is the WEIGHTED average by impressions (already correct, do NOT recompute). For clicks/impressions the totals are simple sums.',
          'For Gantri: defaults to `sc-domain:gantri.com`. Pass `siteUrl: "sc-domain:made.gantri.com"` if the user names the made-to-order subdomain.',
        ].join(' '),
        schema: SearchPerformanceArgs as z.ZodType<z.infer<typeof SearchPerformanceArgs>>,
        jsonSchema: zodToJsonSchema(SearchPerformanceArgs),
        execute: async (rawArgs) => { const args = rawArgs as SearchPerformanceArgs;
          try {
            const { startDate, endDate } = normalizeDateRange(args.dateRange);
            const siteUrl = args.siteUrl ?? DEFAULT_SITE_URL;
            const dimensionFilterGroups = buildDimensionFilters(args);
            const resp = await this.client.searchAnalyticsQuery(siteUrl, {
              startDate,
              endDate,
              dimensions: args.dimensions as GscDimension[],
              ...(dimensionFilterGroups ? { dimensionFilterGroups } : {}),
              rowLimit: args.limit,
              dataState: 'final',
            });
            const rawRows = resp.rows ?? [];
            const sorted = sortRows(rawRows, args.sortBy, args.sortDirection);
            const totals = computeTotals(rawRows);
            const lagNote = makeLagNote(endDate);
            return {
              ok: true,
              data: {
                siteUrl,
                dateRange: { startDate, endDate },
                dimensions: args.dimensions,
                rowCount: sorted.length,
                totals,
                rows: sorted,
                ...(lagNote ? { note: lagNote } : {}),
              },
            };
          } catch (err) { return errorResult(err); }
        },
      },
      {
        name: 'gsc.inspect_url',
        description: [
          'Single-URL deep dive via the URL Inspection API — index status, last crawl, canonical, mobile usability, AMP, rich-results verdicts.',
          'Use for "is X indexed", "why isn\'t X indexed", "what does Google see as the canonical for X", "mobile usability check on Y".',
          'Returns a flat shape: { url, indexStatusVerdict, coverageState, robotsTxtState, indexingState, lastCrawlTime, googleCanonical, userCanonical, mobileUsabilityVerdict, mobileUsabilityIssues, ampVerdict, richResultsVerdict, richResultsItems, sitemap }.',
          'Daily quota: 2,000 inspections per property. Cached aggressively; avoid bulk loops.',
        ].join(' '),
        schema: InspectUrlArgs as z.ZodType<z.infer<typeof InspectUrlArgs>>,
        jsonSchema: zodToJsonSchema(InspectUrlArgs),
        execute: async (rawArgs) => { const args = rawArgs as InspectUrlArgs;
          try {
            const siteUrl = args.siteUrl ?? DEFAULT_SITE_URL;
            const raw = await this.client.inspectUrl({
              siteUrl,
              pageUrl: args.pageUrl,
              languageCode: args.languageCode,
            });
            return { ok: true, data: flattenInspectionResult(args.pageUrl, raw) };
          } catch (err) { return errorResult(err); }
        },
      },
    ];
  }
}

/** Build the dimensionFilterGroups payload Google expects, from the four
 *  separate optional filter args we expose. We keep the shape simple — one
 *  group with multiple AND-ed filters. */
function buildDimensionFilters(args: SearchPerformanceArgs): NonNullable<Parameters<SearchConsoleApiClient['searchAnalyticsQuery']>[1]['dimensionFilterGroups']> | undefined {
  const filters: Array<{ dimension: GscDimension; operator: 'contains'|'equals'|'notContains'|'notEquals'; expression: string }> = [];
  if (args.pageFilter) filters.push({ dimension: 'page', operator: args.pageFilter.operator, expression: args.pageFilter.expression });
  if (args.queryFilter) filters.push({ dimension: 'query', operator: args.queryFilter.operator, expression: args.queryFilter.expression });
  if (args.countryFilter) filters.push({ dimension: 'country', operator: args.countryFilter.operator, expression: args.countryFilter.expression });
  if (args.deviceFilter) filters.push({ dimension: 'device', operator: args.deviceFilter.operator, expression: args.deviceFilter.expression });
  if (filters.length === 0) return undefined;
  return [{ groupType: 'and', filters }];
}

function sortRows(rows: SearchAnalyticsRow[], sortBy: 'clicks'|'impressions'|'ctr'|'position', direction: 'asc'|'desc'): SearchAnalyticsRow[] {
  const sign = direction === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => sign * ((a[sortBy] as number) - (b[sortBy] as number)));
}

/** Aggregate clicks + impressions as simple sums. Position is the
 *  IMPRESSION-WEIGHTED average — the only correct way to summarize position
 *  across grouped rows. CTR is recomputed from totals (NOT averaged). */
function computeTotals(rows: SearchAnalyticsRow[]): { clicks: number; impressions: number; ctr: number; position: number } {
  if (rows.length === 0) return { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  let clicks = 0;
  let impressions = 0;
  let positionWeighted = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    positionWeighted += r.position * r.impressions;
  }
  const ctr = impressions > 0 ? clicks / impressions : 0;
  const position = impressions > 0 ? positionWeighted / impressions : 0;
  return {
    clicks,
    impressions,
    ctr: round4(ctr),
    position: round2(position),
  };
}

const PT_PRESET_LIST = PT_PRESETS as readonly string[];

function normalizeDateRange(input: DateRangeArg): { startDate: string; endDate: string } {
  if (typeof input === 'string') return presetToRange(input);
  if ('startDate' in input && 'endDate' in input) return { startDate: input.startDate, endDate: input.endDate };
  return { startDate: input.start, endDate: input.end };
}

function ptToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
function addDaysIso(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function presetToRange(preset: string): { startDate: string; endDate: string } {
  if (!PT_PRESET_LIST.includes(preset)) throw new Error(`Unknown PT preset: ${preset}`);
  const today = ptToday();
  switch (preset) {
    case 'yesterday': { const y = addDaysIso(today, -1); return { startDate: y, endDate: y }; }
    case 'last_7_days': return { startDate: addDaysIso(today, -6), endDate: today };
    case 'last_14_days': return { startDate: addDaysIso(today, -13), endDate: today };
    case 'last_30_days': return { startDate: addDaysIso(today, -29), endDate: today };
    case 'last_90_days': return { startDate: addDaysIso(today, -89), endDate: today };
    case 'last_180_days': return { startDate: addDaysIso(today, -179), endDate: today };
    case 'last_365_days': return { startDate: addDaysIso(today, -364), endDate: today };
    case 'this_month':
    case 'month_to_date': {
      const [y, m] = today.split('-');
      return { startDate: `${y}-${m}-01`, endDate: today };
    }
    case 'last_month': {
      const [yStr, mStr] = today.split('-');
      const y = Number(yStr); const m = Number(mStr);
      const lmY = m === 1 ? y - 1 : y;
      const lmM = m === 1 ? 12 : m - 1;
      const startDate = `${lmY}-${String(lmM).padStart(2, '0')}-01`;
      const lastDay = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
      const endDate = `${lmY}-${String(lmM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      return { startDate, endDate };
    }
    case 'quarter_to_date': {
      const [yStr, mStr] = today.split('-');
      const m = Number(mStr);
      const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
      return { startDate: `${yStr}-${String(qStartMonth).padStart(2, '0')}-01`, endDate: today };
    }
    case 'year_to_date': {
      const [y] = today.split('-');
      return { startDate: `${y}-01-01`, endDate: today };
    }
    default: throw new Error(`Unknown PT preset: ${preset}`);
  }
}

/** GSC data has a 2-3 day lag. If the requested range ends within that
 *  window, surface a friendly warning so the LLM can pass it to the user. */
function makeLagNote(endDate: string): string | null {
  const today = ptToday();
  const todayMs = Date.UTC(...ymdParts(today));
  const endMs = Date.UTC(...ymdParts(endDate));
  const daysAgo = Math.floor((todayMs - endMs) / 86400000);
  if (daysAgo < 3) {
    return 'Search Console data has a 2-3 day reporting lag. Days within the last 3 days will be partial; numbers may shift slightly over the next ~48 hours.';
  }
  return null;
}
function ymdParts(ymd: string): [number, number, number] {
  const [y, m, d] = ymd.split('-').map(Number);
  return [y, m - 1, d];
}

/** Reduce the deeply-nested URL Inspection response to the flat fields the
 *  LLM actually needs to answer questions. */
function flattenInspectionResult(url: string, raw: import('./client.js').InspectionResultRaw): Record<string, unknown> {
  const r = raw.inspectionResult;
  const idx = r?.indexStatusResult ?? {};
  const mob = r?.mobileUsabilityResult ?? {};
  const amp = r?.ampResult ?? {};
  const rich = r?.richResultsResult;
  const richItems = (rich?.detectedItems ?? []).flatMap((d) =>
    (d.items ?? []).map((it) => ({
      richResultType: d.richResultType ?? null,
      name: it.name ?? null,
      issues: (it.issues ?? []).map((iss) => ({ severity: iss.severity ?? null, message: iss.issueMessage ?? null })),
    }))
  );
  return {
    url,
    inspectionResultLink: r?.inspectionResultLink ?? null,
    indexStatusVerdict: idx.verdict ?? null,
    coverageState: idx.coverageState ?? null,
    robotsTxtState: idx.robotsTxtState ?? null,
    indexingState: idx.indexingState ?? null,
    pageFetchState: idx.pageFetchState ?? null,
    lastCrawlTime: idx.lastCrawlTime ?? null,
    googleCanonical: idx.googleCanonical ?? null,
    userCanonical: idx.userCanonical ?? null,
    crawledAs: idx.crawledAs ?? null,
    sitemap: idx.sitemap ?? [],
    referringUrls: idx.referringUrls ?? [],
    mobileUsabilityVerdict: mob.verdict ?? null,
    mobileUsabilityIssues: (mob.issues ?? []).map((i) => ({ issueType: i.issueType ?? null, severity: i.severity ?? null, message: i.message ?? null })),
    ampVerdict: amp.verdict ?? null,
    ampIssues: (amp.issues ?? []).map((i) => ({ issueType: i.issueType ?? null, severity: i.severity ?? null, message: i.message ?? null })),
    richResultsVerdict: rich?.verdict ?? null,
    richResultsItems: richItems,
  };
}

function errorResult(err: unknown): { ok: false; error: { code: string; status?: number; message: string; body?: unknown } } {
  if (err instanceof SearchConsoleApiError) {
    return { ok: false, error: { code: 'GSC_API_ERROR', status: err.status, message: err.message, body: err.body } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'GSC_INTERNAL_ERROR', message } };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }

export function buildSearchConsoleConnector(cfg: SearchConsoleApiConfig): SearchConsoleConnector {
  return new SearchConsoleConnector(new SearchConsoleApiClient(cfg));
}
// Silence unused-import warning while still re-exporting useful types for tests.
export type { SearchAnalyticsRow };
// Use logger to keep the connector quiet — fully imported at top.
void logger;
