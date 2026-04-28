import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import { logger } from '../../logger.js';
import {
  KlaviyoApiClient,
  KlaviyoApiError,
  type KlaviyoApiConfig,
  type KlaviyoTimeframe,
} from './client.js';

/**
 * Klaviyo email/SMS analytics connector — read-only. Mirrors the surface
 * shape we used for Impact: a few opinionated tools that wrap server-side
 * aggregation, plus directory lookups so the LLM can resolve names → ids.
 *
 *   - klaviyo.list_campaigns        — directory of sent campaigns (email | sms)
 *   - klaviyo.list_segments         — segments + member counts
 *   - klaviyo.campaign_performance  — per-campaign opens/clicks/revenue/etc
 *   - klaviyo.flow_performance      — per-flow same shape
 *
 * Klaviyo's `*-values-reports` endpoints are rate-limited HARD (1/s burst,
 * 2/min steady, 225/day). Don't disable the cache layer — every "answer"
 * built from these tools should be served from `tool_result_cache` in
 * steady state.
 */

/** Date-range shapes accepted by all aggregation tools. Mirrors Impact's
 *  union (preset string | { start, end } | { startDate, endDate }) so a
 *  Live-Reports spec can pass `$REPORT_RANGE` and the runner's substitutions
 *  always hit one of the accepted shapes. Normalized to canonical
 *  `{ startDate, endDate }` (UTC dates, end-of-day inclusive) before any
 *  request is made. */
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

const Channel = z.enum(['email', 'sms', 'mobile_push']).default('email')
  .describe('Klaviyo send channel. Defaults to email — most callers want email-specific stats.');

const ListCampaignsArgs = z.object({
  channel: Channel,
  search: z.string().optional().describe('Optional case-insensitive substring filter on the campaign name.'),
  archived: z.boolean().default(false).describe('Include archived campaigns. Default false (active campaigns only).'),
  limit: z.number().int().min(1).max(500).default(100).describe('Max campaigns to return after filtering. Default 100.'),
});
type ListCampaignsArgs = z.infer<typeof ListCampaignsArgs>;

const ListSegmentsArgs = z.object({
  search: z.string().optional().describe('Optional case-insensitive substring filter on the segment name.'),
  minProfileCount: z.number().int().min(0).optional().describe('Drop segments with fewer than N members. Useful for "show me real segments, not test ones".'),
  limit: z.number().int().min(1).max(500).default(100),
});
type ListSegmentsArgs = z.infer<typeof ListSegmentsArgs>;

/** The full Klaviyo statistics surface for `*-values-reports`. We expose the
 *  ones marketers care about; the LLM picks via `metrics`. */
const StatsList = z.array(z.enum([
  'recipients', 'delivered', 'delivery_rate',
  'opens', 'opens_unique', 'open_rate',
  'clicks', 'clicks_unique', 'click_rate', 'click_to_open_rate',
  'unsubscribes', 'unsubscribe_rate',
  'spam_complaints', 'spam_complaint_rate',
  'bounced', 'bounced_or_failed', 'bounce_rate', 'failed', 'failed_rate',
  'conversions', 'conversion_uniques', 'conversion_value', 'conversion_rate', 'revenue_per_recipient',
])).min(1).max(15);

const CampaignPerformanceArgs = z.object({
  dateRange: DateRange,
  channel: Channel,
  metrics: StatsList.default(['recipients', 'open_rate', 'click_rate', 'conversion_uniques', 'conversion_value', 'unsubscribes']),
  sortBy: z.enum(['conversion_value', 'recipients', 'open_rate', 'click_rate', 'conversion_rate']).default('conversion_value').describe('Field to sort campaigns by, descending. Default conversion_value (= attributed revenue).'),
  limit: z.number().int().min(1).max(200).default(50),
});
type CampaignPerformanceArgs = z.infer<typeof CampaignPerformanceArgs>;

const FlowPerformanceArgs = z.object({
  dateRange: DateRange,
  channel: z.enum(['email', 'sms', 'mobile_push', 'all']).default('email').describe('Filter rows by send_channel. "all" returns every channel a flow uses.'),
  metrics: StatsList.default(['recipients', 'open_rate', 'click_rate', 'conversion_uniques', 'conversion_value']),
  sortBy: z.enum(['conversion_value', 'recipients', 'open_rate', 'click_rate', 'conversion_rate']).default('conversion_value'),
  limit: z.number().int().min(1).max(200).default(50),
});
type FlowPerformanceArgs = z.infer<typeof FlowPerformanceArgs>;

export class KlaviyoConnector implements Connector {
  readonly name = 'klaviyo';
  readonly tools: readonly ToolDef[];
  private placedOrderMetricId: string | null = null;
  private metricDiscoveryAttempted = false;

  constructor(private readonly client: KlaviyoApiClient) {
    this.tools = this.buildTools();
  }

  async healthCheck() {
    try {
      const id = await this.getPlacedOrderMetricId();
      return id ? { ok: true, detail: `Placed Order metric ${id}` } : { ok: false, detail: 'Placed Order metric not found' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Lazy-discover the Placed Order metric id. The `*-values-reports`
   *  endpoints require this as `conversion_metric_id` for revenue stats.
   *  Cached per-process; if Klaviyo is briefly unavailable we don't crash
   *  the bot, the next call retries. */
  private async getPlacedOrderMetricId(): Promise<string | null> {
    if (this.placedOrderMetricId) return this.placedOrderMetricId;
    if (this.metricDiscoveryAttempted) return null;
    try {
      const id = await this.client.findMetricIdByName('Placed Order');
      if (id) {
        this.placedOrderMetricId = id;
        logger.info({ metricId: id }, 'klaviyo placed-order metric resolved');
      } else {
        logger.warn('klaviyo Placed Order metric not found');
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'klaviyo metric discovery failed; will retry next call');
      return null;
    } finally {
      this.metricDiscoveryAttempted = true;
    }
    return this.placedOrderMetricId;
  }

  private buildTools(): readonly ToolDef[] {
    return [
      {
        name: 'klaviyo.list_campaigns',
        description: [
          'Directory of Klaviyo campaigns. One row per campaign with id, name, status (Draft|Sent|Cancelled), channel (email|sms), scheduled_at, send_time, archived flag.',
          'Use to RESOLVE a name the user mentioned ("Black Friday email") into the campaign_id needed for cross-references, OR to enumerate campaigns sent in a window.',
          'For performance metrics (open rate, revenue, etc.) use `klaviyo.campaign_performance` instead — this tool only returns metadata.',
        ].join(' '),
        schema: ListCampaignsArgs as z.ZodType<z.infer<typeof ListCampaignsArgs>>,
        jsonSchema: zodToJsonSchema(ListCampaignsArgs),
        execute: async (rawArgs) => { const args = rawArgs as ListCampaignsArgs;
          try {
            const all = await this.client.listCampaigns({ channel: args.channel, archived: args.archived });
            let filtered = args.search
              ? all.filter((c) => c.attributes.name?.toLowerCase().includes(args.search!.toLowerCase()))
              : all;
            const trimmed = filtered.slice(0, args.limit);
            return {
              ok: true,
              data: {
                channel: args.channel,
                totalAcrossAccount: all.length,
                count: trimmed.length,
                campaigns: trimmed.map((c) => ({
                  id: c.id,
                  name: c.attributes.name,
                  status: c.attributes.status,
                  channel: c.attributes.channel ?? args.channel,
                  archived: c.attributes.archived,
                  scheduled_at: c.attributes.scheduled_at ?? null,
                  send_time: c.attributes.send_time ?? null,
                  created_at: c.attributes.created_at ?? null,
                })),
              },
            };
          } catch (err) { return errorResult(err); }
        },
      },
      {
        name: 'klaviyo.list_segments',
        description: [
          'Klaviyo segments with member counts. One row per segment with id, name, profile_count, is_active, is_processing.',
          'Use for "how many subscribers in segment X", "list our active segments", or to find segment ids before referencing them elsewhere.',
        ].join(' '),
        schema: ListSegmentsArgs as z.ZodType<z.infer<typeof ListSegmentsArgs>>,
        jsonSchema: zodToJsonSchema(ListSegmentsArgs),
        execute: async (rawArgs) => { const args = rawArgs as ListSegmentsArgs;
          try {
            const all = await this.client.listSegments();
            let filtered = args.search
              ? all.filter((s) => s.attributes.name?.toLowerCase().includes(args.search!.toLowerCase()))
              : all;
            if (args.minProfileCount !== undefined) {
              filtered = filtered.filter((s) => (s.attributes.profile_count ?? 0) >= args.minProfileCount!);
            }
            // Sort by profile_count desc so the largest segments surface first.
            filtered.sort((a, b) => (b.attributes.profile_count ?? 0) - (a.attributes.profile_count ?? 0));
            const trimmed = filtered.slice(0, args.limit);
            return {
              ok: true,
              data: {
                totalAcrossAccount: all.length,
                count: trimmed.length,
                segments: trimmed.map((s) => ({
                  id: s.id,
                  name: s.attributes.name,
                  profile_count: s.attributes.profile_count ?? null,
                  is_active: s.attributes.is_active,
                  is_processing: s.attributes.is_processing,
                  created: s.attributes.created ?? null,
                  updated: s.attributes.updated ?? null,
                })),
              },
            };
          } catch (err) { return errorResult(err); }
        },
      },
      {
        name: 'klaviyo.campaign_performance',
        description: [
          'Per-campaign aggregated stats over a date range, served by Klaviyo\'s campaign-values-reports endpoint. Each row: campaign_id, send_channel, plus the requested statistics (open_rate, click_rate, conversion_uniques, conversion_value=attributed revenue, etc.).',
          'Use for "top campaigns by revenue last month", "open rate of our recent campaigns", "which campaign drove the most conversions in Q1".',
          'Revenue here is Klaviyo-attributed via the Placed Order conversion metric (last-touch within Klaviyo\'s default 5-day attribution window). For overall channel-level email revenue across NB/Porter, use the Northbeam tools instead.',
          'Statistic vocab: `recipients`, `delivered`, `opens`/`opens_unique`/`open_rate`, `clicks`/`clicks_unique`/`click_rate`, `click_to_open_rate`, `unsubscribes`/`unsubscribe_rate`, `bounce_rate`, `conversions`/`conversion_uniques`/`conversion_value`/`conversion_rate`, `revenue_per_recipient`. Pass only the ones you need to keep payload small.',
        ].join(' '),
        schema: CampaignPerformanceArgs as z.ZodType<z.infer<typeof CampaignPerformanceArgs>>,
        jsonSchema: zodToJsonSchema(CampaignPerformanceArgs),
        execute: async (rawArgs) => { const args = rawArgs as CampaignPerformanceArgs;
          try {
            const conversionMetricId = await this.getPlacedOrderMetricId();
            if (!conversionMetricId) return { ok: false, error: { code: 'KLAVIYO_NO_PLACED_ORDER_METRIC', message: 'Placed Order metric not found in account; cannot compute revenue/conversion stats.' } };
            const timeframe = toKlaviyoTimeframe(args.dateRange);
            // Resolve campaign names with one extra call so the LLM can render
            // human-readable rows. List is short for any single account.
            const [reportRows, campaigns] = await Promise.all([
              this.client.campaignValuesReport({
                statistics: args.metrics,
                timeframe,
                conversionMetricId,
                filter: `equals(send_channel,'${args.channel}')`,
              }),
              this.client.listCampaigns({ channel: args.channel, archived: false }).catch(() => []),
            ]);
            const nameById = new Map(campaigns.map((c) => [c.id, c.attributes.name] as const));
            const rows = reportRows.map((r) => ({
              campaign_id: r.groupings.campaign_id,
              campaign_name: nameById.get(r.groupings.campaign_id) ?? null,
              send_channel: r.groupings.send_channel ?? args.channel,
              ...r.statistics,
            }));
            const sorted = sortRows(rows, args.sortBy);
            const trimmed = sorted.slice(0, args.limit);
            const totals = aggregateTotals(rows, args.metrics);
            return {
              ok: true,
              data: {
                channel: args.channel,
                dateRange: normalizeDateRange(args.dateRange),
                campaignCount: rows.length,
                totals,
                campaigns: trimmed,
              },
            };
          } catch (err) { return errorResult(err); }
        },
      },
      {
        name: 'klaviyo.flow_performance',
        description: [
          'Per-flow aggregated stats over a date range, from Klaviyo\'s flow-values-reports. Each row: flow_id, flow_message_id, send_channel + the requested statistics. Same statistic vocabulary as campaign_performance.',
          'Use for "which flows drove the most revenue last quarter", "open rate of the welcome series", "are abandoned-cart flows still healthy".',
          'For ranking the strongest revenue flows: pass `metrics: ["recipients","open_rate","click_rate","conversion_uniques","conversion_value"]` and `sortBy: "conversion_value"`.',
        ].join(' '),
        schema: FlowPerformanceArgs as z.ZodType<z.infer<typeof FlowPerformanceArgs>>,
        jsonSchema: zodToJsonSchema(FlowPerformanceArgs),
        execute: async (rawArgs) => { const args = rawArgs as FlowPerformanceArgs;
          try {
            const conversionMetricId = await this.getPlacedOrderMetricId();
            if (!conversionMetricId) return { ok: false, error: { code: 'KLAVIYO_NO_PLACED_ORDER_METRIC', message: 'Placed Order metric not found in account; cannot compute revenue/conversion stats.' } };
            const timeframe = toKlaviyoTimeframe(args.dateRange);
            const filter = args.channel === 'all' ? undefined : `equals(send_channel,'${args.channel}')`;
            const [reportRows, flows] = await Promise.all([
              this.client.flowValuesReport({
                statistics: args.metrics,
                timeframe,
                conversionMetricId,
                filter,
              }),
              this.client.listFlows({ archived: false }).catch(() => []),
            ]);
            const nameById = new Map(flows.map((f) => [f.id, f.attributes.name] as const));
            const rows = reportRows.map((r) => ({
              flow_id: r.groupings.flow_id,
              flow_message_id: r.groupings.flow_message_id,
              flow_name: nameById.get(r.groupings.flow_id) ?? null,
              send_channel: r.groupings.send_channel ?? null,
              ...r.statistics,
            }));
            const sorted = sortRows(rows, args.sortBy);
            const trimmed = sorted.slice(0, args.limit);
            const totals = aggregateTotals(rows, args.metrics);
            return {
              ok: true,
              data: {
                channel: args.channel,
                dateRange: normalizeDateRange(args.dateRange),
                flowCount: rows.length,
                totals,
                flows: trimmed,
              },
            };
          } catch (err) { return errorResult(err); }
        },
      },
    ];
  }
}

/** Convert a connector-level DateRangeArg into the shape Klaviyo's
 *  `*-values-reports` accept. Klaviyo supports its own preset keys (overlap
 *  with ours but not 1:1 — e.g. they have `last_30_days`, no `last_180_days`)
 *  AND custom `{start, end}` ISO datetime windows. We always emit
 *  `{start, end}` for parity across our connectors. */
function toKlaviyoTimeframe(input: DateRangeArg): KlaviyoTimeframe {
  const { startDate, endDate } = normalizeDateRange(input);
  return {
    start: `${startDate}T00:00:00+00:00`,
    end: `${endDate}T23:59:59+00:00`,
  };
}

/** Collapse the union into canonical `{ startDate, endDate }`. PT presets are
 *  resolved off Pacific-Time today so ranges align with the rest of the bot's
 *  time vocabulary. */
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

/** Sort rows desc by a given field. Stat values may be missing on rows where
 *  the metric doesn't apply — those go to the bottom. */
function sortRows<T extends Record<string, unknown>>(rows: T[], sortBy: string): T[] {
  return [...rows].sort((a, b) => {
    const av = typeof a[sortBy] === 'number' ? (a[sortBy] as number) : -Infinity;
    const bv = typeof b[sortBy] === 'number' ? (b[sortBy] as number) : -Infinity;
    return bv - av;
  });
}

/** Sum each requested metric across all rows. Skips rate-style metrics (which
 *  should NOT be summed — averaging them is also misleading per-row, so we
 *  just sum the raw counts). */
const SUMMABLE_METRICS = new Set([
  'recipients', 'delivered', 'opens', 'opens_unique', 'clicks', 'clicks_unique',
  'unsubscribes', 'spam_complaints', 'bounced', 'bounced_or_failed', 'failed',
  'conversions', 'conversion_uniques', 'conversion_value',
]);
function aggregateTotals(rows: Array<Record<string, unknown>>, metrics: string[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const m of metrics) {
    if (!SUMMABLE_METRICS.has(m)) continue;
    let s = 0;
    for (const r of rows) {
      const v = r[m];
      if (typeof v === 'number') s += v;
    }
    totals[m] = round2(s);
  }
  return totals;
}

function errorResult(err: unknown): { ok: false; error: { code: string; status?: number; message: string; body?: unknown } } {
  if (err instanceof KlaviyoApiError) {
    return { ok: false, error: { code: 'KLAVIYO_API_ERROR', status: err.status, message: err.message, body: err.body } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'KLAVIYO_INTERNAL_ERROR', message } };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

/** Factory used by index.ts so the wiring stays consistent with other connectors. */
export function buildKlaviyoConnector(cfg: KlaviyoApiConfig): KlaviyoConnector {
  return new KlaviyoConnector(new KlaviyoApiClient(cfg));
}
