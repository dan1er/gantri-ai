import { z } from 'zod';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import type { Connector, ToolDef } from '../base/connector.js';
import { logger } from '../../logger.js';
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
    .enum(['yesterday', 'last_7_days', 'last_30_days', 'last_90_days', 'last_180_days', 'last_365_days'])
    .describe('Preset relative window. Use this whenever the question is "last week", "last 30 days", etc.'),
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
    .describe('When true, NB sums campaigns within each breakdown so you get one row per (date × breakdown_value). Set false for per-campaign rows.'),
});
type MetricsExplorerArgs = z.infer<typeof MetricsExplorerArgs>;

const NoArgs = z.object({}).strict();

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
        // The API requires breakdowns[].values to be a non-empty enum array.
        // If the caller didn't pass one, auto-populate from the catalog so the
        // LLM doesn't have to make a discovery call before every breakdown.
        const breakdown = args.breakdown && (!args.breakdown.values || args.breakdown.values.length === 0)
          ? { key: args.breakdown.key, values: await fetchBreakdownValues(client, args.breakdown.key) }
          : args.breakdown;
        const payload = buildExportPayload({ ...args, breakdown });
        logger.info({ args, payload: redactPayload(payload) }, 'northbeam.metrics_explorer →');
        try {
          const csv = await client.runExport(payload);
          return {
            attributionModel: args.attributionModel,
            accountingMode: args.accountingMode,
            attributionWindow: args.attributionWindow,
            metrics: args.metrics,
            rowCount: csv.rows.length,
            headers: csv.headers,
            rows: csv.rows,
          };
        } catch (err) {
          if (err instanceof NorthbeamApiError) {
            return { error: { code: 'NORTHBEAM_API_ERROR', status: err.status, message: err.message, body: err.body } };
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
  ];
}

// ---- payload assembly ----

export function buildExportPayload(args: MetricsExplorerArgs): DataExportPayload {
  const breakdowns: DataExportBreakdown[] = args.breakdown ? [args.breakdown] : [];
  const periodFields: Pick<DataExportPayload, 'period_type' | 'period_options'> =
    typeof args.dateRange === 'string'
      ? { period_type: presetToPeriodType(args.dateRange) }
      // The API rejects {from,to} (which the docs example suggests) and demands
      // {period_starting_at, period_ending_at} as ISO 8601 datetimes for FIXED
      // windows. Bare YYYY-MM-DD also gets rejected with "invalid datetime
      // format". We attach midnight UTC to the start and end-of-day to the end
      // so the FIXED window is inclusive of both calendar days.
      : { period_type: 'FIXED', period_options: { period_starting_at: `${args.dateRange.start}T00:00:00.000Z`, period_ending_at: `${args.dateRange.end}T23:59:59.999Z` } };
  return {
    level: 'platform',
    time_granularity: args.granularity,
    ...periodFields,
    breakdowns,
    options: {
      export_aggregation: 'BREAKDOWN',
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
  switch (preset) {
    case 'yesterday': return 'YESTERDAY';
    case 'last_7_days': return 'LAST_7_DAYS';
    case 'last_30_days': return 'LAST_30_DAYS';
    case 'last_90_days': return 'LAST_90_DAYS';
    case 'last_180_days': return 'LAST_180_DAYS';
    case 'last_365_days': return 'LAST_365_DAYS';
    default: throw new Error(`unknown date preset: ${preset}`);
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
