import { z } from 'zod';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import type { Connector, ToolDef } from '../base/connector.js';
import { logger } from '../../logger.js';
import { DateRangeArg, normalizeDateRange } from '../base/date-range.js';
import {
  NorthbeamApiClient,
  type NorthbeamApiConfig,
  type DataExportPayload,
  type DataExportBreakdown,
  NorthbeamApiError,
} from './client.js';

/**
 * Northbeam attribution + spend connector backed by the official REST API
 * (https://docs.northbeam.io/reference). Replaces the legacy Playwright-based
 * `NorthbeamConnector` which got blocked by NB's anti-bot detection.
 *
 * Tool surface (kept narrow on purpose — one workhorse + 3 discovery helpers):
 *   - `northbeam.metrics_explorer`  — pull metrics × optional breakdown × date range
 *   - `northbeam.list_metrics`      — catalog of valid metric IDs
 *   - `northbeam.list_breakdowns`   — catalog of valid breakdown keys + values
 *   - `northbeam.list_attribution_models` — catalog of attribution model IDs
 *
 * The LLM composes everything (overview, sales, ROAS, channel rankings, halo
 * correlations) by calling `metrics_explorer` with the right metric IDs and
 * breakdown. Catalog tools are how it discovers valid IDs in the first place.
 *
 * Latency: a typical export takes 2–4s end-to-end (POST → poll → CSV download).
 * Heavy aggregations with breakdowns can take 30–60s; the cache absorbs repeat
 * calls.
 */
export class NorthbeamApiConnector implements Connector {
  readonly name = 'northbeam';
  readonly tools: readonly ToolDef[];
  private readonly client: NorthbeamApiClient;

  constructor(cfg: NorthbeamApiConfig) {
    this.client = new NorthbeamApiClient(cfg);
    this.tools = buildTools(this.client);
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const metrics = await this.client.listMetrics();
      return { ok: true, detail: `metrics catalog has ${metrics.length} entries` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: msg };
    }
  }
}

// ---- tool schemas ----

const DateRange = z.union([
  z
    .enum(['yesterday', 'last_7_days', 'last_14_days', 'last_30_days', 'last_90_days', 'last_180_days', 'last_365_days', 'this_month', 'last_month', 'month_to_date', 'quarter_to_date', 'year_to_date'])
    .describe('Preset relative window. Use this whenever the question is "last week", "last 30 days", "year to date", etc. Calendar-relative presets (month_to_date, quarter_to_date, year_to_date, this_month, last_month) are resolved to exact start/end dates before the API call.'),
  z
    .object({
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    })
    .describe('Fixed date range, both bounds inclusive. Use for specific dates ("on Jan 1", "March 2026").'),
]);

const Breakdown = z
  .object({
    key: z.string().describe('Breakdown key from `northbeam.list_breakdowns` (e.g. "Platform (Northbeam)", "Forecast", "Category (Northbeam)").'),
    values: z.array(z.string()).optional().describe('Restrict to specific breakdown values (e.g. ["Email","Google Ads"]). If omitted all values are returned.'),
  })
  .describe('Optional grouping dimension. One row will be returned per (date × breakdown_value).');

const MetricsExplorerArgs = z.object({
  dateRange: DateRange,
  metrics: z
    .array(z.string())
    .min(1)
    .describe('Array of metric IDs from `northbeam.list_metrics` (e.g. ["rev","spend","txns"]).'),
  breakdown: Breakdown.optional(),
  level: z
    .enum(['platform', 'campaign', 'adset', 'ad'])
    .default('platform')
    .describe('Granularity of the rows returned. Use "campaign" for "top N campaigns by ROAS / revenue" / "best ad campaign" questions; "adset" or "ad" for deeper drill-down. Default "platform" (one row per channel/platform).'),
  attributionModel: z
    .string()
    .default('northbeam_custom__va')
    .describe('Attribution model ID from `northbeam.list_attribution_models`. Default `northbeam_custom__va` ("Clicks + Modeled Views"), the headline metric.'),
  accountingMode: z
    .enum(['cash', 'accrual'])
    .default('cash')
    .describe('Cash = revenue recognized when the order is placed (= "Cash snapshot" in the UI). Accrual = revenue recognized over the LTV horizon. Default cash.'),
  attributionWindow: z.string().default('1').describe('Click attribution window in days. Default "1".'),
  granularity: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']).default('DAILY'),
  aggregateData: z
    .boolean()
    .default(true)
    .describe('When true, NB sums campaigns within each breakdown so you get one row per (date × breakdown_value). Set false at level=campaign/ad to get per-row detail (e.g. for "top campaigns" rankings).'),
  bucketByDate: z
    .boolean()
    .default(false)
    .describe('When TRUE, NB returns one row per (date × breakdown_value) — REQUIRED for any "which day", "daily trend", "weekly evolution", "highest-spend day" question. Each row will include a `date` column you can sort/argmax on. When FALSE (default) NB collapses the entire period into a single aggregate row per breakdown_value with NO date column.'),
});
type MetricsExplorerArgs = z.infer<typeof MetricsExplorerArgs>;

const NoArgs = z.object({}).strict();

const ListOrdersArgs = z.object({
  // Use the shared union schema so $REPORT_RANGE preset strings resolve too.
  dateRange: DateRangeArg,
  includeCancelled: z.boolean().default(false).describe('Include cancelled/deleted orders. Default false — most callers want clean orders only.'),
});
type ListOrdersArgs = z.infer<typeof ListOrdersArgs>;

// ---- tool implementations ----

function buildTools(client: NorthbeamApiClient): ToolDef[] {
  return [
    {
      name: 'northbeam.metrics_explorer',
      description: [
        'Pull marketing attribution metrics from Northbeam (revenue, spend, orders/transactions, ROAS, AOV, touchpoints, first-time vs returning, etc) for a date range, with an optional channel/platform breakdown. This is the workhorse for ANY Northbeam question.',
        'Examples: "spend on ads on Jan 1" → metrics:["spend"], dateRange:{start:"2026-01-01",end:"2026-01-01"}. "Top channel by revenue last month" → metrics:["rev"], breakdown:{key:"Platform (Northbeam)"}, dateRange:"last_30_days". "ROAS by channel last 7d" → metrics:["rev","spend"], breakdown:{key:"Platform (Northbeam)"}, dateRange:"last_7_days". "% first-time customer revenue this week" → metrics:["aovFt","aovRtn","visitorsFt","visitorsRtn"], dateRange:"last_7_days".',
        'If you do not know which metric ID or breakdown key to use, call `northbeam.list_metrics` / `northbeam.list_breakdowns` FIRST.',
      ].join(' '),
      schema: MetricsExplorerArgs as z.ZodType<MetricsExplorerArgs>,
      jsonSchema: zodToJsonSchema(MetricsExplorerArgs),
      async execute(args: MetricsExplorerArgs) {
        // Normalize the dateRange string: LLM has been observed to type
        // "last_7 days" (with a space) instead of "last_7_days". Replace any
        // single space inside `last_N days` with an underscore before forwarding.
        const normalizedDateRange = typeof args.dateRange === 'string'
          ? (args.dateRange.replace(/\s+/g, '_').toLowerCase() as MetricsExplorerArgs['dateRange'])
          : args.dateRange;

        // Defensive metric-id translation. The compiler LLM has been observed
        // to pass `transactions` (the CSV column name) where the metric ID
        // should be `txns`. Translate common aliases before NB rejects them.
        const METRIC_ALIASES: Record<string, string> = {
          transactions: 'txns',
          orders: 'txns',
          revenue: 'rev',
        };
        const translatedMetrics = args.metrics.map((m) => METRIC_ALIASES[m] ?? m);
        const normalized = { ...args, dateRange: normalizedDateRange, metrics: translatedMetrics };
        // The API requires breakdowns[].values to be a non-empty enum array.
        // If the caller didn't pass one, auto-populate from the catalog so the
        // LLM doesn't have to make a discovery call before every breakdown.
        const breakdown = normalized.breakdown && (!normalized.breakdown.values || normalized.breakdown.values.length === 0)
          ? { key: normalized.breakdown.key, values: await fetchBreakdownValues(client, normalized.breakdown.key) }
          : normalized.breakdown;
        const payload = buildExportPayload({ ...normalized, breakdown });
        logger.info({ args, payload: redactPayload(payload) }, 'northbeam.metrics_explorer →');
        try {
          const csv = await client.runExport(payload);
          // Normalize the breakdown column name to the stable alias "breakdown_value"
          // so specs don't need to know the actual NB column name (which varies by
          // breakdown key, e.g. "breakdown_platform_northbeam", "breakdown_forecast").
          // We rename whichever column starts with "breakdown_" and is NOT a metric
          // or a known static column. If there are multiple breakdown columns we
          // rename the first one found.
          const STATIC_COLUMNS = new Set(['date', 'accounting_mode', 'attribution_model', 'attribution_window']);
          const metricCols = new Set(args.metrics.map((m) => {
            const METRIC_COL: Record<string, string> = { txns: 'transactions', rev: 'rev', spend: 'spend' };
            return METRIC_COL[m] ?? m;
          }));
          const breakdownCol = csv.headers.find(
            (h) => h.startsWith('breakdown_') && !STATIC_COLUMNS.has(h) && !metricCols.has(h),
          );
          let rows = csv.rows;
          let headers = csv.headers;
          if (breakdownCol && breakdownCol !== 'breakdown_value') {
            headers = csv.headers.map((h) => (h === breakdownCol ? 'breakdown_value' : h));
            rows = csv.rows.map((r) => {
              const { [breakdownCol]: bv, ...rest } = r as Record<string, unknown>;
              return { breakdown_value: bv, ...rest } as typeof r;
            });
          }
          return {
            attributionModel: args.attributionModel,
            accountingMode: args.accountingMode,
            attributionWindow: args.attributionWindow,
            metrics: args.metrics,
            rowCount: rows.length,
            headers,
            rows,
          };
        } catch (err) {
          if (err instanceof NorthbeamApiError) {
            return { ok: false, error: { code: 'NORTHBEAM_API_ERROR', status: err.status, message: err.message, body: err.body } };
          }
          throw err;
        }
      },
    },
    {
      name: 'northbeam.list_metrics',
      description: 'List every metric ID available to `northbeam.metrics_explorer` along with its display label. Call this to discover which IDs to pass for a given user question (e.g. "Revenue" → id `rev`, "Transactions / Orders" → id `txns`, "Spend" → id `spend`, "AOV (1st time)" → id `aovFt`).',
      schema: NoArgs as z.ZodType<Record<string, never>>,
      jsonSchema: zodToJsonSchema(NoArgs),
      async execute() {
        const metrics = await client.listMetrics();
        return { count: metrics.length, metrics };
      },
    },
    {
      name: 'northbeam.list_breakdowns',
      description: 'List every breakdown key (e.g. "Platform (Northbeam)", "Forecast", "Category (Northbeam)", "Targeting (Northbeam)", "Revenue Source (Northbeam)") along with its valid enum values. Pass one of these into `northbeam.metrics_explorer` to slice results by channel/platform/etc.',
      schema: NoArgs as z.ZodType<Record<string, never>>,
      jsonSchema: zodToJsonSchema(NoArgs),
      async execute() {
        const breakdowns = await client.listBreakdowns();
        return { count: breakdowns.length, breakdowns };
      },
    },
    {
      name: 'northbeam.list_attribution_models',
      description: 'List the attribution-model IDs Northbeam supports (e.g. `northbeam_custom__va` = "Clicks + Modeled Views" — the default; `last_touch`, `first_touch`, `linear`, etc.). Pass one into `northbeam.metrics_explorer` via `attributionModel` if the user wants a specific model.',
      schema: NoArgs as z.ZodType<Record<string, never>>,
      jsonSchema: zodToJsonSchema(NoArgs),
      async execute() {
        const models = await client.listAttributionModels();
        return { count: models.length, models };
      },
    },
    {
      name: 'northbeam.list_orders',
      description: [
        'List the per-order rows Northbeam has on file for a date range (GET /v2/orders).',
        'Use this whenever the user asks for "orders from Northbeam", a list of orders, or per-order detail (customer name/email, purchase total, refund amount, etc).',
        'Each row contains: order_id, customer_id, customer_name, customer_email, customer_phone_number, time_of_purchase (ISO), currency, purchase_total, tax, shipping_cost, discount_amount, discount_codes, order_tags, is_recurring_order, is_cancelled, is_deleted, updated_at.',
        'IMPORTANT: this endpoint does NOT include per-order attribution (no touchpoints, no channel-attributed flag, no first-time/returning at the order grain). For attribution at the aggregate level use `northbeam.metrics_explorer`. For touchpoints per order, the Northbeam dashboard is still the only source.',
        'Date range is inclusive YYYY-MM-DD. By default cancelled and deleted rows are filtered out — set `includeCancelled: true` to include them.',
      ].join(' '),
      schema: ListOrdersArgs as z.ZodType<ListOrdersArgs>,
      jsonSchema: zodToJsonSchema(ListOrdersArgs),
      async execute(args: ListOrdersArgs) {
        try {
          const { startDate, endDate } = normalizeDateRange(args.dateRange);
          const all = await client.listOrders({ startDate, endDate });
          const filtered = args.includeCancelled
            ? all
            : all.filter((o) => !o.is_cancelled && !o.is_deleted);
          // Pre-compute the day-by-day breakdown server-side so the LLM doesn't
          // have to bucket timestamps itself. We've observed the model getting
          // PT-day arithmetic wrong (off-by-one weekday labels, mismatched
          // counts) when asked to "show daily orders". By emitting the rollup
          // here the LLM just has to render the table.
          const ptDayFmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
          });
          const ptDayWithName = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Los_Angeles', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
          });
          const dailyMap = new Map<string, { date: string; weekday: string; orders: number; revenue: number }>();
          for (const o of filtered) {
            const t = (o as { time_of_purchase?: string }).time_of_purchase;
            if (typeof t !== 'string') continue;
            const dt = new Date(t);
            const date = ptDayFmt.format(dt);
            const weekday = ptDayWithName.formatToParts(dt).find((p) => p.type === 'weekday')?.value ?? '';
            const total = Number((o as { purchase_total?: unknown }).purchase_total ?? 0);
            const e = dailyMap.get(date) ?? { date, weekday, orders: 0, revenue: 0 };
            e.orders += 1;
            e.revenue += total;
            dailyMap.set(date, e);
          }
          const dailyBreakdown = [...dailyMap.values()]
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((e) => ({ ...e, revenue: Math.round(e.revenue * 100) / 100 }));
          return {
            period: { startDate, endDate },
            source: 'northbeam_v2_orders' as const,
            count: filtered.length,
            totalReturned: all.length,
            cancelledOrDeletedExcluded: all.length - filtered.length,
            dailyBreakdown,
            orders: filtered,
          };
        } catch (err) {
          if (err instanceof NorthbeamApiError) {
            return { ok: false, error: { code: 'NORTHBEAM_API_ERROR', status: err.status, message: err.message, body: err.body } };
          }
          throw err;
        }
      },
    },
  ];
}

// ---- payload assembly ----

export function buildExportPayload(args: MetricsExplorerArgs): DataExportPayload {
  const breakdowns: DataExportBreakdown[] = args.breakdown ? [args.breakdown] : [];
  // Resolve calendar-relative presets (month_to_date, quarter_to_date, etc.)
  // that NB doesn't natively support into explicit {start, end} date ranges.
  const resolvedDateRange: typeof args.dateRange =
    typeof args.dateRange === 'string'
      ? (resolveCalendarPreset(args.dateRange) ?? args.dateRange)
      : args.dateRange;

  const periodFields: Pick<DataExportPayload, 'period_type' | 'period_options'> =
    typeof resolvedDateRange === 'string'
      ? { period_type: presetToPeriodType(resolvedDateRange) }
      // The API rejects {from,to} (which the docs example suggests) and demands
      // {period_starting_at, period_ending_at} as ISO 8601 datetimes for FIXED
      // windows. Bare YYYY-MM-DD also gets rejected with "invalid datetime
      // format". We attach midnight UTC to the start and end-of-day to the end
      // so the FIXED window is inclusive of both calendar days.
      : { period_type: 'FIXED', period_options: { period_starting_at: `${resolvedDateRange.start}T00:00:00.000Z`, period_ending_at: `${resolvedDateRange.end}T23:59:59.999Z` } };
  return {
    level: args.level,
    time_granularity: args.granularity,
    ...periodFields,
    breakdowns,
    options: {
      // export_aggregation:'BREAKDOWN' collapses the whole period into one row per
      // breakdown_value (no `date` column). 'DATE' returns one row per
      // (date × breakdown_value) — use this when the question is per-day.
      export_aggregation: args.bucketByDate ? 'DATE' : 'BREAKDOWN',
      remove_zero_spend: false,
      aggregate_data: args.aggregateData,
      include_ids: false,
    },
    attribution_options: {
      attribution_models: [args.attributionModel],
      accounting_modes: [args.accountingMode],
      attribution_windows: [args.attributionWindow],
    },
    metrics: args.metrics.map((id) => ({ id })),
  };
}

function presetToPeriodType(preset: string): string {
  // NB's enum is restricted: only specific N-day buckets are native
  // (LAST_3/7/14/28/30/60/90/180_DAYS). 365 days isn't one of them — see
  // their 422 response. Map to LAST_52_WEEKS which is the closest native
  // bucket; resolveCalendarPreset can produce an exact FIXED range when
  // truly needed.
  switch (preset) {
    case 'yesterday': return 'YESTERDAY';
    case 'last_7_days': return 'LAST_7_DAYS';
    case 'last_14_days': return 'LAST_14_DAYS';
    case 'last_30_days': return 'LAST_30_DAYS';
    case 'last_90_days': return 'LAST_90_DAYS';
    case 'last_180_days': return 'LAST_180_DAYS';
    case 'last_365_days': return 'LAST_52_WEEKS';
    default: throw new Error(`unknown date preset: ${preset}`);
  }
}

/**
 * Resolve calendar-relative presets that NB doesn't natively support
 * (last_14_days, month_to_date, quarter_to_date, year_to_date, this_month,
 * last_month) into explicit {start, end} date objects. NB-native presets pass
 * through unchanged so the NB API can use its own logic.
 *
 * All "today" / month / quarter / year boundaries are computed in PACIFIC TIME
 * to match the rest of Gantri's reporting (NB orders bucketed by PT day,
 * Grafana panels filtered by PT, late-orders cutoffs in PT).
 */
function resolveCalendarPreset(preset: string): { start: string; end: string } | null {
  // Today's calendar date in Pacific Time.
  const ptParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = Number(ptParts.find((p) => p.type === 'year')?.value ?? '0');
  const m = Number(ptParts.find((p) => p.type === 'month')?.value ?? '0');
  const d = Number(ptParts.find((p) => p.type === 'day')?.value ?? '0');
  const todayStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // Date-only arithmetic on a noon UTC anchor is safe across DST.
  const subDays = (n: number): string => {
    const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    dt.setUTCDate(dt.getUTCDate() - n);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  };
  switch (preset) {
    case 'last_14_days': return { start: subDays(13), end: todayStr };
    case 'this_month':
    case 'month_to_date': return { start: `${y}-${String(m).padStart(2, '0')}-01`, end: todayStr };
    case 'last_month': {
      const lmYear = m === 1 ? y - 1 : y;
      const lmMonth = m === 1 ? 12 : m - 1;
      const lastDayOfPrev = new Date(Date.UTC(y, m - 1, 0, 12, 0, 0));
      const endStr = `${lastDayOfPrev.getUTCFullYear()}-${String(lastDayOfPrev.getUTCMonth() + 1).padStart(2, '0')}-${String(lastDayOfPrev.getUTCDate()).padStart(2, '0')}`;
      return { start: `${lmYear}-${String(lmMonth).padStart(2, '0')}-01`, end: endStr };
    }
    case 'quarter_to_date': {
      const qStart = Math.floor((m - 1) / 3) * 3 + 1;
      return { start: `${y}-${String(qStart).padStart(2, '0')}-01`, end: todayStr };
    }
    case 'year_to_date': return { start: `${y}-01-01`, end: todayStr };
    default: return null; // NB-native preset — pass through to API
  }
}

/**
 * Fetch the catalog values for a breakdown key. The API requires the
 * `breakdowns[].values` array to be present and non-empty; if the caller didn't
 * supply one we expand to "all values for this key" so they get the slice they
 * intended. Cached implicitly by the upstream CachingRegistry (catalog endpoints
 * have a long TTL).
 */
async function fetchBreakdownValues(client: NorthbeamApiClient, key: string): Promise<string[]> {
  const breakdowns = await client.listBreakdowns();
  const match = breakdowns.find((b) => b.key === key);
  if (!match) throw new NorthbeamApiError(0, null, `Breakdown key "${key}" not found in catalog. Call northbeam.list_breakdowns to see valid keys.`);
  return match.values;
}

function redactPayload(p: DataExportPayload): DataExportPayload {
  // Nothing sensitive in the payload itself — emit as-is for logs.
  return p;
}
