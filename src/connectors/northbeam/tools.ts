import { z } from 'zod';
import type { ToolDef } from '../base/connector.js';
import type { NorthbeamGraphqlClient } from './graphql-client.js';
import type { TtlCache } from '../../storage/cache.js';
import {
  ACCOUNTING_MODES,
  ATTRIBUTION_MODELS,
  ATTRIBUTION_WINDOWS,
  METRIC_CATALOG,
  SALES_LEVELS,
  TIME_GRANULARITIES,
} from './catalog.js';
import {
  FETCH_PARTNERS_APEX_CONSENT,
  GET_OVERVIEW_METRICS_REPORT_V3,
  GET_SALES_BREAKDOWN_CONFIGS,
  GET_SALES_METRICS_REPORT_V4,
} from './queries.js';

export interface NorthbeamToolDeps {
  gql: NorthbeamGraphqlClient;
  cache: TtlCache;
  nowISO?: () => string;
}

const METRIC_IDS = METRIC_CATALOG.map((m) => m.id) as [string, ...string[]];

const DateRange = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const Common = {
  attributionModel: z.enum(ATTRIBUTION_MODELS).default('linear'),
  attributionWindow: z.enum(ATTRIBUTION_WINDOWS).default('1'),
  accountingMode: z.enum(ACCOUNTING_MODES).default('accrual'),
  timeGranularity: z.enum(TIME_GRANULARITIES).default('daily'),
};

const OverviewArgs = z.object({
  dateRange: DateRange,
  metrics: z.array(z.enum(METRIC_IDS)).min(1).max(20),
  dimensions: z.array(z.string()).default(['date']),
  ...Common,
  compareToPreviousPeriod: z.boolean().default(true),
});
type OverviewArgs = z.infer<typeof OverviewArgs>;

function previousPeriod(range: { startDate: string; endDate: string }) {
  const start = new Date(range.startDate + 'T00:00:00Z').getTime();
  const end = new Date(range.endDate + 'T00:00:00Z').getTime();
  const span = end - start;
  const prevEnd = new Date(start - 24 * 3600 * 1000);
  const prevStart = new Date(prevEnd.getTime() - span);
  return {
    startDate: prevStart.toISOString().slice(0, 10),
    endDate: prevEnd.toISOString().slice(0, 10),
  };
}

function cacheTtl(dateRange: { endDate: string }, nowISO: () => string): number {
  const today = nowISO().slice(0, 10);
  const end = dateRange.endDate;
  const daysAgo = Math.floor(
    (new Date(today + 'T00:00:00Z').getTime() - new Date(end + 'T00:00:00Z').getTime()) / 86_400_000,
  );
  if (daysAgo <= 0) return 5 * 60;
  if (daysAgo <= 7) return 30 * 60;
  return 24 * 60 * 60;
}

const SalesArgs = z.object({
  level: z.enum(SALES_LEVELS),
  dateRange: DateRange,
  metrics: z.array(z.enum(METRIC_IDS)).min(1).max(20),
  breakdown: z.string().optional(),
  platformFilter: z.string().optional(),
  statusFilter: z.array(z.string()).optional(),
  sorting: z
    .array(z.object({ dimensionId: z.string(), order: z.enum(['asc', 'desc']) }))
    .optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
  ...Common,
  compareToPreviousPeriod: z.boolean().default(false),
});
type SalesArgs = z.infer<typeof SalesArgs>;

export function buildNorthbeamTools(deps: NorthbeamToolDeps): ToolDef[] {
  const nowISO = deps.nowISO ?? (() => new Date().toISOString());

  const overview: ToolDef<OverviewArgs> = {
    name: 'northbeam.overview',
    description:
      'Returns high-level marketing metrics (spend, revenue, ROAS, etc.) for a date range, optionally compared against the previous period. Use for summary questions like "how much did we spend last week" or "what was ROAS yesterday".',
    schema: OverviewArgs as z.ZodType<OverviewArgs>,
    jsonSchema: zodToJsonSchema(OverviewArgs),
    async execute(args) {
      const dimensions = args.dimensions ?? ['date'];
      const variables = {
        ...args,
        dimensionIds: dimensions,
        metricIds: args.metrics,
        level: 'campaign',
        breakdownFilters: [],
        sorting: [{ dimensionId: dimensions[0] ?? 'date', order: 'asc' }],
        compareDateRange: args.compareToPreviousPeriod ? previousPeriod(args.dateRange) : null,
      };
      const key = `nb.overview:${JSON.stringify(variables)}`;
      const cached = await deps.cache.get(key);
      if (cached) return cached;
      const data = await deps.gql.request<{
        me: { overviewMetricsReportV3: { rows: unknown[]; summary: { actual: any[]; comparison: any[] | null } } };
      }>('GetOverviewMetricsReportV3', GET_OVERVIEW_METRICS_REPORT_V3, variables);
      const report = data.me.overviewMetricsReportV3;
      const result = {
        period: args.dateRange,
        comparePeriod: variables.compareDateRange,
        summary: {
          actual: report.summary.actual?.[0]?.metrics ?? {},
          comparison: report.summary.comparison?.[0]?.metrics ?? null,
        },
        rows: report.rows,
      };
      await deps.cache.set(key, result, cacheTtl(args.dateRange, nowISO));
      return result;
    },
  };

  const sales: ToolDef<SalesArgs> = {
    name: 'northbeam.sales',
    description:
      'Returns a granular performance table at campaign/adset/ad/platform level with rich metrics and optional breakdown by Platform (Northbeam) / Category / Targeting. Use for drill-down questions like "best campaigns last week" or "Meta ROAS by adset".',
    schema: SalesArgs as z.ZodType<SalesArgs>,
    jsonSchema: zodToJsonSchema(SalesArgs),
    async execute(args) {
      const dimensionIds = ['name', 'campaignName'];
      if (args.breakdown) dimensionIds.push(`breakdown:${args.breakdown}`);
      const breakdownFilters = args.platformFilter
        ? [{ key: 'Platform (Northbeam)', values: [args.platformFilter] }]
        : [];
      const variables = {
        ...args,
        dimensionIds,
        metricIds: args.metrics,
        breakdownFilters,
        universalBenchmarkBreakdownFilters: [],
        metricFilters: [],
        statusFilters: args.statusFilter ?? null,
        sorting: args.sorting ?? [{ dimensionId: 'spend', order: 'desc' }],
        compareDateRange: args.compareToPreviousPeriod ? previousPeriod(args.dateRange) : null,
        isSummary: false,
        summaryDimensionIds: null,
        advancedSearch: null,
      };
      const key = `nb.sales:${JSON.stringify(variables)}`;
      const cached = await deps.cache.get(key);
      if (cached) return cached;
      const data = await deps.gql.request<{
        me: { salesMetricsReportV4: { actual: unknown[]; comparison: unknown[] | null } };
      }>('GetSalesMetricsReportV4', GET_SALES_METRICS_REPORT_V4, variables);
      const result = {
        period: args.dateRange,
        comparePeriod: variables.compareDateRange,
        rows: data.me.salesMetricsReportV4.actual,
        comparison: data.me.salesMetricsReportV4.comparison,
      };
      await deps.cache.set(key, result, cacheTtl(args.dateRange, nowISO));
      return result;
    },
  };

  const listBreakdowns: ToolDef<Record<string, never>> = {
    name: 'northbeam.list_breakdowns',
    description:
      'Lists available breakdown dimensions (e.g. Platform, Category) and their allowed values. Use before `northbeam.sales` with a breakdown to ground on valid keys.',
    schema: z.object({}).strict(),
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const key = `nb.breakdowns`;
      const cached = await deps.cache.get(key);
      if (cached) return cached;
      const data = await deps.gql.request<{
        me: { salesBreakdownConfigs: Array<{ key: string; choices: Array<{ value: string }> }> };
      }>('GetSalesBreakdownConfigs', GET_SALES_BREAKDOWN_CONFIGS, {});
      const breakdowns: Record<string, string[]> = {};
      for (const b of data.me.salesBreakdownConfigs) {
        breakdowns[b.key] = b.choices.map((c) => c.value);
      }
      const result = { breakdowns };
      await deps.cache.set(key, result, 24 * 60 * 60);
      return result;
    },
  };

  const listMetrics: ToolDef<Record<string, never>> = {
    name: 'northbeam.list_metrics',
    description: 'Lists the metric IDs available to `northbeam.overview` and `northbeam.sales`.',
    schema: z.object({}).strict(),
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { metrics: METRIC_CATALOG };
    },
  };

  const connectedPartners: ToolDef<Record<string, never>> = {
    name: 'northbeam.connected_partners',
    description: 'Reports which ad platforms (Meta, Google Ads, etc.) have a working connection into Northbeam.',
    schema: z.object({}).strict(),
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const key = `nb.partners`;
      const cached = await deps.cache.get(key);
      if (cached) return cached;
      const data = await deps.gql.request<{
        me: { partnerApexConsent: unknown[]; isMetaCapiConfigured: boolean };
      }>('FetchPartnersApexConsent', FETCH_PARTNERS_APEX_CONSENT, {});
      const result = {
        partners: data.me.partnerApexConsent,
        isMetaCapiConfigured: data.me.isMetaCapiConfigured,
      };
      await deps.cache.set(key, result, 24 * 60 * 60);
      return result;
    },
  };

  return [overview, sales, listBreakdowns, listMetrics, connectedPartners];
}

// Small util just for Claude's tool manifest. Covers the shapes used in this file.
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def: any = (schema as any)._def;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, child] of Object.entries<any>(shape)) {
        properties[k] = zodToJsonSchema(child);
        if (!('defaultValue' in (child as any)._def) && !((child as any).isOptional?.())) {
          required.push(k);
        }
      }
      return { type: 'object', properties, required, additionalProperties: false };
    }
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def.type) };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodDefault':
      return zodToJsonSchema(def.innerType);
    case 'ZodOptional':
      return zodToJsonSchema(def.innerType);
    default:
      return {};
  }
}
