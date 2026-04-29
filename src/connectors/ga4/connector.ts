import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import { DateRangeArg, normalizeDateRange } from '../base/date-range.js';
import type { Ga4Client, Ga4ReportRequest, Ga4ReportResponse } from './client.js';
import { Ga4ApiError } from './client.js';

export interface Ga4ConnectorDeps {
  client: Ga4Client;
}

// Use the shared DateRangeArg union — accepts {startDate,endDate}, {start,end},
// or any preset string. GA4 buckets in the property's reporting time zone, but
// the preset list is the same canonical PT-anchored set used by every tool.
const DateRange = DateRangeArg;

const RunReportArgs = z.object({
  dateRange: DateRange.default('last_7_days'),
  metrics: z.array(z.string()).min(1).describe('GA4 metric names. Common: `sessions`, `totalUsers`, `newUsers`, `screenPageViews`, `conversions`, `userEngagementDuration`, `bounceRate`, `engagementRate`, `eventCount`, `purchaseRevenue`, `transactions`, `addToCarts`, `checkouts`.'),
  dimensions: z.array(z.string()).optional().describe('Optional GA4 dimension names. Common: `sessionDefaultChannelGroup`, `sessionSourceMedium`, `country`, `deviceCategory`, `pagePath`, `pageTitle`, `landingPage`, `eventName`, `date`, `hour`. Omit for a single roll-up row.'),
  limit: z.number().int().min(1).max(100_000).default(1000).describe('Row cap. GA4 max is 100 000 per request.'),
  orderBy: z.object({
    metric: z.string().optional(),
    dimension: z.string().optional(),
    desc: z.boolean().default(true),
  }).optional().describe('Sort. Pass either `metric` or `dimension` (not both).'),
  dimensionFilter: z.record(z.unknown()).optional().describe('GA4 FilterExpression that restricts dimension values server-side. Use to keep response size small on high-cardinality breakdowns (e.g. `pagePath × eventName` returns thousands of rows). In-list filter: `{filter:{fieldName:"eventName",inListFilter:{values:["page_view","scroll"]}}}`. Single value: `{filter:{fieldName:"pagePath",stringFilter:{value:"/products/",matchType:"BEGINS_WITH"}}}`. Combine with `{andGroup:{expressions:[...]}}` or `{orGroup:{expressions:[...]}}`.'),
});
type RunReportArgs = z.infer<typeof RunReportArgs>;

const RealtimeArgs = z.object({
  metrics: z.array(z.string()).min(1).default(['activeUsers']).describe('Realtime metrics. Most useful: `activeUsers`, `screenPageViews`, `eventCount`, `keyEvents`. Note: realtime is a separate endpoint with a smaller catalog than the standard report.'),
  dimensions: z.array(z.string()).optional().describe('Realtime dimensions. Common: `country`, `deviceCategory`, `unifiedScreenName`, `eventName`. Omit for a single number.'),
  limit: z.number().int().min(1).max(10_000).default(100),
});
type RealtimeArgs = z.infer<typeof RealtimeArgs>;

const ListEventsArgs = z.object({
  dateRange: DateRange.default('last_30_days').describe('Window over which to enumerate the events that fired.'),
  limit: z.number().int().min(1).max(1000).default(200).describe('Max number of distinct event names to return. GA4 properties typically have 50–250 distinct events.'),
});
type ListEventsArgs = z.infer<typeof ListEventsArgs>;

const PageEngagementArgs = z.object({
  dateRange: DateRange.default('last_30_days'),
  minPageViews: z.number().int().min(0).default(500).describe('Drop pages with fewer page_views than this from rankings (avoids noise from low-traffic URLs).'),
  topN: z.number().int().min(1).max(100).default(20).describe('How many pages to include in each ranking (top by traffic, top by scroll rate, bottom by scroll rate).'),
});
type PageEngagementArgs = z.infer<typeof PageEngagementArgs>;

export class Ga4Connector implements Connector {
  readonly name = 'ga4';
  readonly tools: readonly ToolDef[];

  constructor(private readonly deps: Ga4ConnectorDeps) {
    this.tools = [this.runReportTool(), this.realtimeTool(), this.listEventsTool(), this.pageEngagementTool()];
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.deps.client.runReport({
        dateRanges: [{ startDate: 'today', endDate: 'today' }],
        metrics: [{ name: 'sessions' }],
        limit: 1,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private runReportTool(): ToolDef<RunReportArgs> {
    return {
      name: 'ga4.run_report',
      description: [
        'Run a Google Analytics 4 report over a date range with optional dimensions. Use ONLY when the user explicitly asks for GA4, Google Analytics, sessions, page views, funnel/drop-off, bounce rate, engagement, behavior, events, or any metric Northbeam does not track. For revenue/spend/ROAS/CAC/attribution, use Northbeam.',
        'Common dimensions: `sessionDefaultChannelGroup`, `sessionSourceMedium`, `country`, `deviceCategory`, `pagePath`, `pageTitle`, `landingPage`, `eventName`, `date`. Common metrics: `sessions`, `totalUsers`, `newUsers`, `screenPageViews`, `conversions`, `bounceRate`, `engagementRate`, `eventCount`, `purchaseRevenue`, `transactions`, `addToCarts`, `checkouts`.',
        'Examples: "Sessions last 7 days by channel" → `metrics:["sessions"], dimensions:["sessionDefaultChannelGroup"], dateRange:"last_7_days"`. "Add-to-cart rate by device this month" → `metrics:["addToCarts","sessions"], dimensions:["deviceCategory"], dateRange:"this_month"`, then divide client-side. "Top 20 landing pages last 30d" → `metrics:["sessions","engagementRate"], dimensions:["landingPage"], dateRange:"last_30_days", orderBy:{metric:"sessions"}, limit:20`.',
      ].join(' '),
      schema: RunReportArgs as z.ZodType<RunReportArgs>,
      jsonSchema: zodToJsonSchema(RunReportArgs),
      execute: (args) => this.runReport(args),
    };
  }

  private realtimeTool(): ToolDef<RealtimeArgs> {
    return {
      name: 'ga4.realtime',
      description: [
        'Active GA4 users in the last 30 minutes. Use for "how many users are on the site right now", "realtime traffic", "live activity" type questions.',
        'Optionally break down by `country`, `deviceCategory`, `unifiedScreenName`, or `eventName`. Returns one row per breakdown value with the requested metrics (defaults to `activeUsers`).',
      ].join(' '),
      schema: RealtimeArgs as z.ZodType<RealtimeArgs>,
      jsonSchema: zodToJsonSchema(RealtimeArgs),
      execute: (args) => this.realtime(args),
    };
  }

  private listEventsTool(): ToolDef<ListEventsArgs> {
    return {
      name: 'ga4.list_events',
      description: [
        'List the GA4 event names that fired in a date range, sorted by count desc. Returns `{eventName, eventCount, totalUsers}` per event.',
        'Use this BEFORE constructing any `ga4.run_report` query that filters by `eventName`, so you can pick the right events for the question. Event names are CUSTOM per property — names like `add_to_cart`, `product_gallery_view_next`, `product_color_changed`, `search_products_searched`, `topnavigation_*` exist only because Gantri tracks them; you cannot guess. ALWAYS call this tool first when the user asks about a behavior that maps to an event (gallery interaction, search behavior, customization usage, navigation clicks, etc.).',
        'Cheap call — single GA4 request, ~50–250 rows.',
      ].join(' '),
      schema: ListEventsArgs as z.ZodType<ListEventsArgs>,
      jsonSchema: zodToJsonSchema(ListEventsArgs),
      execute: (args) => this.listEvents(args),
    };
  }

  private pageEngagementTool(): ToolDef<PageEngagementArgs> {
    return {
      name: 'ga4.page_engagement_summary',
      description: [
        'PAGE COMPLETION analysis. Use this for "qué páginas ven completas / which pages do users read all the way / scroll depth / page completion rate" questions.',
        'Computes scroll-to-bottom rate (`scroll_event / page_view_event` per URL) server-side and returns three rankings — top pages by traffic, highest scroll rate, lowest scroll rate — plus site totals and a list of "anomalous" pages where the scroll listener fires multiple times per page_view (home, sign-up, checkout etc.). Output is bounded to ~`topN`*3 rows so it stays small in the LLM context.',
        'Args: `dateRange` (default `last_30_days`), `minPageViews` (default 500 — pages with fewer views are dropped to remove noise), `topN` (default 20 — size of each ranking).',
        'PREFER this over composing `ga4.list_events` + `ga4.run_report` manually for these questions; the manual path can return 1000+ rows and risks rate-limiting the LLM.',
      ].join(' '),
      schema: PageEngagementArgs as z.ZodType<PageEngagementArgs>,
      jsonSchema: zodToJsonSchema(PageEngagementArgs),
      execute: (args) => this.pageEngagement(args),
    };
  }

  private async runReport(args: RunReportArgs) {
    const req: Ga4ReportRequest = {
      dateRanges: [resolveDateRange(args.dateRange)],
      metrics: args.metrics.map((name) => ({ name })),
      ...(args.dimensions && args.dimensions.length ? { dimensions: args.dimensions.map((name) => ({ name })) } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
      ...(args.dimensionFilter ? { dimensionFilter: args.dimensionFilter } : {}),
      ...(args.orderBy
        ? {
            orderBys: [{
              ...(args.orderBy.metric ? { metric: { metricName: args.orderBy.metric } } : {}),
              ...(args.orderBy.dimension ? { dimension: { dimensionName: args.orderBy.dimension } } : {}),
              desc: args.orderBy.desc,
            }],
          }
        : {}),
    };
    try {
      const res = await this.deps.client.runReport(req);
      return { period: args.dateRange, ...flattenReport(res) };
    } catch (err) {
      if (err instanceof Ga4ApiError) {
        return { error: { code: 'GA4_API_ERROR', status: err.status, message: err.message, body: err.body } };
      }
      throw err;
    }
  }

  private async pageEngagement(args: PageEngagementArgs) {
    try {
      const res = await this.deps.client.runReport({
        dateRanges: [resolveDateRange(args.dateRange)],
        dimensions: [{ name: 'pagePath' }, { name: 'eventName' }],
        metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
        dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['page_view', 'scroll'] } } },
        limit: 100_000,
      });
      const flat = flattenReport(res);
      const byPage = new Map<string, { pageViews: number; scrolls: number; pageViewUsers: number; scrollUsers: number }>();
      for (const r of flat.rows as Array<Record<string, unknown>>) {
        const path = String(r.pagePath ?? '');
        if (!path) continue;
        const evName = String(r.eventName ?? '');
        const count = Number(r.eventCount ?? 0);
        const users = Number(r.totalUsers ?? 0);
        const bucket = byPage.get(path) ?? { pageViews: 0, scrolls: 0, pageViewUsers: 0, scrollUsers: 0 };
        if (evName === 'page_view') { bucket.pageViews += count; bucket.pageViewUsers += users; }
        else if (evName === 'scroll') { bucket.scrolls += count; bucket.scrollUsers += users; }
        byPage.set(path, bucket);
      }
      const all = [...byPage.entries()].map(([pagePath, b]) => ({
        pagePath,
        pageViews: b.pageViews,
        scrolls: b.scrolls,
        scrollRate: b.pageViews > 0 ? b.scrolls / b.pageViews : 0,
        users: b.pageViewUsers,
      }));
      const totals = all.reduce(
        (s, r) => ({ pageViews: s.pageViews + r.pageViews, scrolls: s.scrolls + r.scrolls }),
        { pageViews: 0, scrolls: 0 },
      );
      const eligible = all.filter((r) => r.pageViews >= args.minPageViews);
      // Pages where the scroll listener fires repeatedly (rate > 100%) — flag, exclude from ranking.
      const flagged = eligible.filter((r) => r.scrollRate > 1.0)
        .sort((a, b) => b.pageViews - a.pageViews)
        .map((r) => ({ pagePath: r.pagePath, pageViews: r.pageViews, scrolls: r.scrolls, scrollRate: round(r.scrollRate, 3) }));
      const ranked = eligible.filter((r) => r.scrollRate <= 1.0);
      const fmt = (rows: typeof ranked) =>
        rows.slice(0, args.topN).map((r) => ({
          pagePath: r.pagePath,
          pageViews: r.pageViews,
          scrolls: r.scrolls,
          scrollRate: round(r.scrollRate, 3),
          users: r.users,
        }));
      return {
        period: args.dateRange,
        minPageViews: args.minPageViews,
        topN: args.topN,
        totals: {
          pageViews: totals.pageViews,
          scrollEvents: totals.scrolls,
          siteScrollRate: totals.pageViews > 0 ? round(totals.scrolls / totals.pageViews, 3) : 0,
          uniquePagesObserved: all.length,
          eligiblePages: eligible.length,
        },
        topByTraffic: fmt([...ranked].sort((a, b) => b.pageViews - a.pageViews)),
        highestScrollRate: fmt([...ranked].sort((a, b) => b.scrollRate - a.scrollRate)),
        lowestScrollRate: fmt([...ranked].sort((a, b) => a.scrollRate - b.scrollRate)),
        flaggedPages: flagged.slice(0, 20),
        notes: 'scrollRate is `scroll / page_view` per URL. Pages in `flaggedPages` (rate > 100%) have a scroll listener that fires multiple times per page view (commonly home, sign-up, checkout) — use them only as engagement signals, not as completion rates.',
      };
    } catch (err) {
      if (err instanceof Ga4ApiError) {
        return { error: { code: 'GA4_API_ERROR', status: err.status, message: err.message, body: err.body } };
      }
      throw err;
    }
  }

  private async listEvents(args: ListEventsArgs) {
    try {
      const res = await this.deps.client.runReport({
        dateRanges: [resolveDateRange(args.dateRange)],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
        limit: args.limit,
        orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      });
      return { period: args.dateRange, ...flattenReport(res) };
    } catch (err) {
      if (err instanceof Ga4ApiError) {
        return { error: { code: 'GA4_API_ERROR', status: err.status, message: err.message, body: err.body } };
      }
      throw err;
    }
  }

  private async realtime(args: RealtimeArgs) {
    try {
      const res = await this.deps.client.runRealtimeReport({
        metrics: args.metrics.map((name) => ({ name })),
        ...(args.dimensions && args.dimensions.length ? { dimensions: args.dimensions.map((name) => ({ name })) } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
      });
      return flattenReport(res);
    } catch (err) {
      if (err instanceof Ga4ApiError) {
        return { error: { code: 'GA4_API_ERROR', status: err.status, message: err.message, body: err.body } };
      }
      throw err;
    }
  }
}

function resolveDateRange(input: RunReportArgs['dateRange']): { startDate: string; endDate: string } {
  if (typeof input === 'string') {
    // Fast path: GA4-native relative tokens for the common rolling windows.
    // GA4 accepts strings like `7daysAgo`, `today`, `yesterday` directly.
    switch (input) {
      case 'yesterday': return { startDate: 'yesterday', endDate: 'yesterday' };
      case 'today': return { startDate: 'today', endDate: 'today' };
      case 'last_7_days': return { startDate: '7daysAgo', endDate: 'today' };
      case 'last_14_days': return { startDate: '14daysAgo', endDate: 'today' };
      case 'last_30_days': return { startDate: '30daysAgo', endDate: 'today' };
      case 'last_60_days': return { startDate: '60daysAgo', endDate: 'today' };
      case 'last_90_days': return { startDate: '90daysAgo', endDate: 'today' };
      case 'last_180_days': return { startDate: '180daysAgo', endDate: 'today' };
      case 'last_365_days': return { startDate: '365daysAgo', endDate: 'today' };
    }
    // Slow path: calendar-relative presets (this_month, year_to_date, etc.) —
    // GA4 has no native token, so resolve via the shared PT-anchored helper
    // and pass YYYY-MM-DD literals (GA4 accepts those too).
    const normalized = normalizeDateRange(input);
    return { startDate: normalized.startDate, endDate: normalized.endDate };
  }
  if ('startDate' in input && 'endDate' in input) {
    return { startDate: input.startDate, endDate: input.endDate };
  }
  return { startDate: input.start, endDate: input.end };
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function flattenReport(res: Ga4ReportResponse) {
  const dims = (res.dimensionHeaders ?? []).map((h) => h.name);
  const mets = (res.metricHeaders ?? []).map((h) => h.name);
  const rows = (res.rows ?? []).map((r) => {
    const o: Record<string, unknown> = {};
    dims.forEach((d, i) => { o[d] = r.dimensionValues[i]?.value ?? null; });
    mets.forEach((m, i) => {
      const v = r.metricValues[i]?.value;
      const n = v == null ? null : Number(v);
      o[m] = n != null && Number.isFinite(n) ? n : v;
    });
    return o;
  });
  return { rowCount: res.rowCount ?? rows.length, dimensions: dims, metrics: mets, rows };
}
