import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import type { Ga4Client, Ga4ReportRequest, Ga4ReportResponse } from './client.js';
import { Ga4ApiError } from './client.js';

export interface Ga4ConnectorDeps {
  client: Ga4Client;
}

const DateRange = z.union([
  z.enum(['yesterday', 'today', 'last_7_days', 'last_14_days', 'last_30_days', 'last_90_days', 'last_180_days', 'last_365_days', 'this_month', 'last_month'])
    .describe('Preset relative window. GA4 buckets in the property\'s reporting time zone.'),
  z.object({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  }).describe('Fixed date range, both bounds inclusive.'),
]);

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
});
type RunReportArgs = z.infer<typeof RunReportArgs>;

const RealtimeArgs = z.object({
  metrics: z.array(z.string()).min(1).default(['activeUsers']).describe('Realtime metrics. Most useful: `activeUsers`, `screenPageViews`, `eventCount`, `keyEvents`. Note: realtime is a separate endpoint with a smaller catalog than the standard report.'),
  dimensions: z.array(z.string()).optional().describe('Realtime dimensions. Common: `country`, `deviceCategory`, `unifiedScreenName`, `eventName`. Omit for a single number.'),
  limit: z.number().int().min(1).max(10_000).default(100),
});
type RealtimeArgs = z.infer<typeof RealtimeArgs>;

export class Ga4Connector implements Connector {
  readonly name = 'ga4';
  readonly tools: readonly ToolDef[];

  constructor(private readonly deps: Ga4ConnectorDeps) {
    this.tools = [this.runReportTool(), this.realtimeTool()];
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

  private async runReport(args: RunReportArgs) {
    const req: Ga4ReportRequest = {
      dateRanges: [resolveDateRange(args.dateRange)],
      metrics: args.metrics.map((name) => ({ name })),
      ...(args.dimensions && args.dimensions.length ? { dimensions: args.dimensions.map((name) => ({ name })) } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
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
    switch (input) {
      case 'yesterday': return { startDate: 'yesterday', endDate: 'yesterday' };
      case 'today': return { startDate: 'today', endDate: 'today' };
      case 'last_7_days': return { startDate: '7daysAgo', endDate: 'today' };
      case 'last_14_days': return { startDate: '14daysAgo', endDate: 'today' };
      case 'last_30_days': return { startDate: '30daysAgo', endDate: 'today' };
      case 'last_90_days': return { startDate: '90daysAgo', endDate: 'today' };
      case 'last_180_days': return { startDate: '180daysAgo', endDate: 'today' };
      case 'last_365_days': return { startDate: '365daysAgo', endDate: 'today' };
      // GA4 doesn't ship "this_month"/"last_month" relative tokens — translate to fixed strings client-side.
      // Use the property's reporting timezone is fine; we approximate with UTC since GA4 also accepts YYYY-MM-DD literals.
      case 'this_month': {
        const now = new Date();
        const y = now.getUTCFullYear();
        const m = String(now.getUTCMonth() + 1).padStart(2, '0');
        return { startDate: `${y}-${m}-01`, endDate: 'today' };
      }
      case 'last_month': {
        const now = new Date();
        const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        const y = last.getUTCFullYear();
        const m = String(last.getUTCMonth() + 1).padStart(2, '0');
        const endOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
        const eY = endOfMonth.getUTCFullYear();
        const eM = String(endOfMonth.getUTCMonth() + 1).padStart(2, '0');
        const eD = String(endOfMonth.getUTCDate()).padStart(2, '0');
        return { startDate: `${y}-${m}-01`, endDate: `${eY}-${eM}-${eD}` };
      }
    }
    throw new Error(`Unknown dateRange preset: ${input as string}`);
  }
  return { startDate: input.start, endDate: input.end };
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
