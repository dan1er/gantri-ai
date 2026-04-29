import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import { DateRangeArg, normalizeDateRange } from '../base/date-range.js';
import { logger } from '../../logger.js';
import {
  KlaviyoApiClient,
  KlaviyoApiError,
  type KlaviyoApiConfig,
  type KlaviyoTimeframe,
} from './client.js';
import type { KlaviyoSignupRollupRepo } from '../../storage/repositories/klaviyo-signup-rollup.js';

/**
 * Klaviyo email/SMS analytics connector — read-only. Mirrors the surface
 * shape we used for Impact: a few opinionated tools that wrap server-side
 * aggregation, plus directory lookups so the LLM can resolve names → ids.
 *
 *   - klaviyo.list_campaigns        — directory of sent campaigns (email | sms)
 *   - klaviyo.list_segments         — segments + member counts
 *   - klaviyo.campaign_performance  — per-campaign opens/clicks/revenue/etc
 *   - klaviyo.flow_performance      — per-flow same shape
 *   - klaviyo.consented_signups     — daily/weekly/monthly counts of profiles
 *                                     created in window AND consented to email,
 *                                     served from the nightly rollup table
 *
 * Klaviyo's `*-values-reports` endpoints are rate-limited HARD (1/s burst,
 * 2/min steady, 225/day). Don't disable the cache layer — every "answer"
 * built from these tools should be served from `tool_result_cache` in
 * steady state.
 */

export interface KlaviyoConnectorDeps {
  client: KlaviyoApiClient;
  signupRepo: KlaviyoSignupRollupRepo;
}

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
  dateRange: DateRangeArg,
  channel: Channel,
  metrics: StatsList.default(['recipients', 'open_rate', 'click_rate', 'conversion_uniques', 'conversion_value', 'unsubscribes']),
  sortBy: z.enum(['conversion_value', 'recipients', 'open_rate', 'click_rate', 'conversion_rate']).default('conversion_value').describe('Field to sort campaigns by, descending. Default conversion_value (= attributed revenue).'),
  limit: z.number().int().min(1).max(200).default(50),
});
type CampaignPerformanceArgs = z.infer<typeof CampaignPerformanceArgs>;

const FlowPerformanceArgs = z.object({
  dateRange: DateRangeArg,
  channel: z.enum(['email', 'sms', 'mobile_push', 'all']).default('email').describe('Filter rows by send_channel. "all" returns every channel a flow uses.'),
  metrics: StatsList.default(['recipients', 'open_rate', 'click_rate', 'conversion_uniques', 'conversion_value']),
  sortBy: z.enum(['conversion_value', 'recipients', 'open_rate', 'click_rate', 'conversion_rate']).default('conversion_value'),
  limit: z.number().int().min(1).max(200).default(50),
});
type FlowPerformanceArgs = z.infer<typeof FlowPerformanceArgs>;

const ConsentedSignupsArgs = z.object({
  dateRange: DateRangeArg.describe('Date window over which to count signups (by profile.created in PT).'),
  granularity: z.enum(['daily', 'weekly', 'monthly']).default('monthly')
    .describe("Aggregation bucket. 'monthly' is most common."),
});
type ConsentedSignupsArgs = z.infer<typeof ConsentedSignupsArgs>;

export class KlaviyoConnector implements Connector {
  readonly name = 'klaviyo';
  readonly tools: readonly ToolDef[];
  private readonly client: KlaviyoApiClient;
  private readonly signupRepo: KlaviyoSignupRollupRepo;
  private placedOrderMetricId: string | null = null;
  private metricDiscoveryAttempted = false;

  constructor(deps: KlaviyoConnectorDeps) {
    this.client = deps.client;
    this.signupRepo = deps.signupRepo;
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
          'Klaviyo segments with current member counts and 30-day churn. Each row: id, name, profile_count (current size), members_added_30d, members_removed_30d, is_active, is_processing, created, updated.',
          'Use for "how many subscribers in segment X", "size of our segments", "which segments are growing", or to find segment ids before referencing them elsewhere.',
          'profile_count comes from POST /segment-values-reports — if that aggregation is briefly unavailable, the field is null but the segment still appears.',
        ].join(' '),
        schema: ListSegmentsArgs as z.ZodType<z.infer<typeof ListSegmentsArgs>>,
        jsonSchema: zodToJsonSchema(ListSegmentsArgs),
        execute: async (rawArgs) => { const args = rawArgs as ListSegmentsArgs;
          try {
            // Klaviyo's /segments endpoint stopped exposing member counts in
            // current revisions. The only reliable source today is the
            // segment-values-reports endpoint with `total_members`. Fetch
            // both in parallel and join — the values-report doesn't return
            // segment names, the directory doesn't return counts.
            const [directory, valuesRows] = await Promise.all([
              this.client.listSegments(),
              this.client.segmentValuesReport({
                statistics: ['total_members', 'members_added', 'members_removed'],
                timeframe: { key: 'last_30_days' },
              }).catch((err) => {
                logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'klaviyo segment-values-report failed; counts will be null');
                return [];
              }),
            ]);
            const countsById = new Map<string, { total_members?: number; members_added?: number; members_removed?: number }>();
            for (const row of valuesRows) {
              const id = row.groupings.segment_id;
              if (id) countsById.set(id, row.statistics);
            }
            let filtered = args.search
              ? directory.filter((s) => s.attributes.name?.toLowerCase().includes(args.search!.toLowerCase()))
              : directory.slice();
            if (args.minProfileCount !== undefined) {
              filtered = filtered.filter((s) => (countsById.get(s.id)?.total_members ?? 0) >= args.minProfileCount!);
            }
            // Sort by total_members desc so the largest segments surface first.
            filtered.sort((a, b) => (countsById.get(b.id)?.total_members ?? 0) - (countsById.get(a.id)?.total_members ?? 0));
            const trimmed = filtered.slice(0, args.limit);
            return {
              ok: true,
              data: {
                totalAcrossAccount: directory.length,
                count: trimmed.length,
                segments: trimmed.map((s) => {
                  const stats = countsById.get(s.id);
                  return {
                    id: s.id,
                    name: s.attributes.name,
                    profile_count: stats?.total_members ?? null,
                    members_added_30d: stats?.members_added ?? null,
                    members_removed_30d: stats?.members_removed ?? null,
                    is_active: s.attributes.is_active,
                    is_processing: s.attributes.is_processing,
                    created: s.attributes.created ?? null,
                    updated: s.attributes.updated ?? null,
                  };
                }),
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
            const { startDate, endDate } = normalizeDateRange(args.dateRange);
            const timeframe = toKlaviyoTimeframe(startDate, endDate);
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
                dateRange: { startDate, endDate },
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
            const { startDate, endDate } = normalizeDateRange(args.dateRange);
            const timeframe = toKlaviyoTimeframe(startDate, endDate);
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
                dateRange: { startDate, endDate },
                flowCount: rows.length,
                totals,
                flows: trimmed,
              },
            };
          } catch (err) { return errorResult(err); }
        },
      },
      {
        name: 'klaviyo.consented_signups',
        description:
          'Count of profiles created in the window AND currently subscribed to email marketing in Klaviyo. Use for questions like "how many email signups did we get in March?" or "monthly consented signups in 2026". Reads from the nightly rollup table — fast (millis), refreshed once/day at 03:00 PT.',
        schema: ConsentedSignupsArgs as z.ZodType<ConsentedSignupsArgs>,
        jsonSchema: zodToJsonSchema(ConsentedSignupsArgs),
        execute: async (rawArgs) => {
          const args = rawArgs as ConsentedSignupsArgs;
          const { startDate, endDate } = normalizeDateRange(args.dateRange);
          const days = await this.signupRepo.getRange(startDate, endDate);

          const rows = aggregateSignups(days, args.granularity);

          let latestComputedDay: string | null = null;
          let computedAt: string | null = null;
          for (const d of days) {
            if (latestComputedDay === null || d.day > latestComputedDay) latestComputedDay = d.day;
            if (computedAt === null || d.computedAt > computedAt) computedAt = d.computedAt;
          }

          return {
            period: { startDate, endDate },
            granularity: args.granularity,
            rows,
            rollupFreshness: { latestComputedDay, computedAt },
            note: 'Consent reflects current state. Counts may decrease over time as profiles unsubscribe.',
          };
        },
      },
    ];
  }
}

/** Convert a normalized `{ startDate, endDate }` window into the shape
 *  Klaviyo's `*-values-reports` accept. We always emit `{ start, end }` with
 *  full-day UTC bounds for parity across our connectors. */
function toKlaviyoTimeframe(startDate: string, endDate: string): KlaviyoTimeframe {
  return {
    start: `${startDate}T00:00:00+00:00`,
    end: `${endDate}T23:59:59+00:00`,
  };
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

/** Bucket daily signup rows into the requested granularity. `monthly` keys are
 *  `YYYY-MM`; `weekly` keys are the Monday (ISO 8601) of the week, formatted
 *  `YYYY-MM-DD`; `daily` is a pass-through. Rows are sorted ascending by key. */
function aggregateSignups(
  days: Array<{ day: string; signupsTotal: number; signupsConsentedEmail: number }>,
  granularity: 'daily' | 'weekly' | 'monthly',
): Array<{ key: string; signupsTotal: number; signupsConsentedEmail: number }> {
  if (granularity === 'daily') {
    return days.map((d) => ({ key: d.day, signupsTotal: d.signupsTotal, signupsConsentedEmail: d.signupsConsentedEmail }));
  }
  const buckets = new Map<string, { signupsTotal: number; signupsConsentedEmail: number }>();
  for (const d of days) {
    const key = granularity === 'monthly' ? d.day.slice(0, 7) : isoWeekStart(d.day);
    const cur = buckets.get(key) ?? { signupsTotal: 0, signupsConsentedEmail: 0 };
    cur.signupsTotal += d.signupsTotal;
    cur.signupsConsentedEmail += d.signupsConsentedEmail;
    buckets.set(key, cur);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => ({ key, ...v }));
}

function isoWeekStart(ymd: string): string {
  // Returns the Monday (ISO 8601 week start) of the week containing ymd, formatted YYYY-MM-DD.
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = (dt.getUTCDay() + 6) % 7; // Mon=0, Sun=6
  dt.setUTCDate(dt.getUTCDate() - dayOfWeek);
  return dt.toISOString().slice(0, 10);
}

/** Factory used by index.ts so the wiring stays consistent with other connectors. */
export function buildKlaviyoConnector(cfg: KlaviyoApiConfig, signupRepo: KlaviyoSignupRollupRepo): KlaviyoConnector {
  return new KlaviyoConnector({ client: new KlaviyoApiClient(cfg), signupRepo });
}
