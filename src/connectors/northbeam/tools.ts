import { z } from 'zod';
import type { ToolDef } from '../base/connector.js';
import type { NorthbeamGraphqlClient } from './graphql-client.js';
import { TtlCache } from '../../storage/cache.js';
import {
  ACCOUNTING_MODES,
  ATTRIBUTION_MODELS,
  ATTRIBUTION_WINDOWS,
  METRIC_CATALOG,
  SALES_LEVELS,
  TIME_GRANULARITIES,
} from './catalog.js';
import {
  FETCH_ORDER_SUMMARY,
  FETCH_ORDER_SUMMARY_GRAPH,
  FETCH_ORDER_SUMMARY_GRAPH_KPI,
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

// LLMs sometimes send enum values with surrounding quotes (e.g. `"7"` as a
// literal 3-char string) or as numbers. Normalize before validating.
const normalizeEnum = (v: unknown): unknown => {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.replace(/^["']+|["']+$/g, '');
  return v;
};

const Common = {
  attributionModel: z.preprocess(normalizeEnum, z.enum(ATTRIBUTION_MODELS)).default('linear'),
  attributionWindow: z.preprocess(normalizeEnum, z.enum(ATTRIBUTION_WINDOWS)).default('1'),
  accountingMode: z.preprocess(normalizeEnum, z.enum(ACCOUNTING_MODES)).default('accrual'),
  timeGranularity: z.preprocess(normalizeEnum, z.enum(TIME_GRANULARITIES)).default('daily'),
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
  const dayMs = 24 * 3600 * 1000;
  const start = new Date(range.startDate + 'T00:00:00Z').getTime();
  const end = new Date(range.endDate + 'T00:00:00Z').getTime();
  const span = end - start + dayMs;
  const prevEnd = new Date(start - dayMs);
  const prevStart = new Date(prevEnd.getTime() - span + dayMs);
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
  level: z.preprocess(normalizeEnum, z.enum(SALES_LEVELS)),
  dateRange: DateRange,
  metrics: z.array(z.enum(METRIC_IDS)).min(1).max(20),
  breakdown: z.string().optional(),
  platformFilter: z.string().optional(),
  statusFilter: z.array(z.string()).optional(),
  /**
   * Which metric to sort results by, descending. Defaults to the first entry
   * of `metrics`. Sorting is performed client-side because Northbeam's API
   * only accepts sort-by-dimension, not sort-by-metric.
   */
  sortByMetric: z.enum(METRIC_IDS).optional(),
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
      const variables = {
        ...args,
        dimensionIds: args.dimensions ?? ['date'],
        metricIds: args.metrics,
        level: 'campaign',
        breakdownFilters: [],
        sorting: [{ dimensionId: (args.dimensions ?? ['date'])[0] ?? 'date', order: 'asc' }],
        compareDateRange: args.compareToPreviousPeriod ? previousPeriod(args.dateRange) : null,
      };
      const key = TtlCache.key('nb.overview', variables as Record<string, unknown>);
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
      'Returns a granular performance table at campaign/adset/ad/platform level with rich metrics and optional breakdown by Platform (Northbeam), Category (Northbeam), Targeting (Northbeam), etc. Use for drill-down questions like "best campaigns last week" or "Meta ROAS by adset". The `breakdown` argument must be one of the keys returned by `northbeam.list_breakdowns`; do not invent a breakdown key.',
    schema: SalesArgs as z.ZodType<SalesArgs>,
    jsonSchema: zodToJsonSchema(SalesArgs),
    async execute(args) {
      const dimensionIds = ['name', 'campaignName'];
      if (args.breakdown) dimensionIds.push(`breakdown:${args.breakdown}`);
      // Northbeam's filter input: `{ breakdown: string, value: string }` — note
      // singular `value`, not `values`; breakdown is the key name from
      // `GetSalesBreakdownConfigs`.
      const breakdownFilters = args.platformFilter
        ? [{ breakdown: 'Platform (Northbeam)', value: args.platformFilter }]
        : [];
      const variables = {
        ...args,
        dimensionIds,
        metricIds: args.metrics,
        breakdownFilters,
        universalBenchmarkBreakdownFilters: [],
        metricFilters: [],
        statusFilters: args.statusFilter ?? null,
        // Northbeam only accepts sort-by-dimension server-side. Always sort by
        // `name` ascending for stable ordering; metric-based sorting is applied
        // client-side below.
        sorting: [{ dimensionId: 'name', order: 'asc' }],
        compareDateRange: args.compareToPreviousPeriod ? previousPeriod(args.dateRange) : null,
        isSummary: false,
        summaryDimensionIds: null,
        advancedSearch: null,
      };
      const key = TtlCache.key('nb.sales', variables as Record<string, unknown>);
      const cached = await deps.cache.get(key);
      if (cached) return cached;
      const data = await deps.gql.request<{
        me: { salesMetricsReportV4: { actual: unknown[]; comparison: unknown[] | null } };
      }>('GetSalesMetricsReportV4', GET_SALES_METRICS_REPORT_V4, variables);

      // Client-side sort by the requested metric (descending), then apply limit.
      const sortMetric = args.sortByMetric ?? args.metrics[0];
      const rows = (data.me.salesMetricsReportV4.actual as Array<{ metrics?: Record<string, number | null> }>)
        .slice()
        .sort((a, b) => (b.metrics?.[sortMetric] ?? -Infinity) - (a.metrics?.[sortMetric] ?? -Infinity))
        .slice(args.offset, args.offset + args.limit);

      const result = {
        period: args.dateRange,
        comparePeriod: variables.compareDateRange,
        sortedBy: { metric: sortMetric, order: 'desc' as const },
        rows,
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

  // ========================================================================
  // Orders page tools: individual orders + revenue/count KPIs.
  // ========================================================================

  const OrderFilters = z.object({
    attributed: z.boolean().optional(),
    orderTypes: z.array(z.enum(['first_time', 'returning'])).optional(),
    customerTags: z.array(z.string()).optional(),
    orderTags: z.array(z.string()).optional(),
    sourceName: z.array(z.string()).optional(),
    discountCodes: z.array(z.string()).optional(),
    subscriptions: z.array(z.string()).optional(),
    products: z.array(z.string()).optional(),
    adPlatforms: z.array(z.string()).optional(),
    ecommercePlatforms: z.array(z.string()).optional(),
    adjustForReturns: z.boolean().default(false),
  });

  /** Convert a plain date-range {startDate, endDate} (YYYY-MM-DD, interpreted
   *  in Northbeam's tenant timezone — America/Los_Angeles) into the ISO instant
   *  range the orders API expects. Uses a -07:00 offset (PDT). If Northbeam
   *  ever surfaces a different tz or we cross a DST boundary, revisit. */
  function toIsoDateRange(range: { startDate: string; endDate: string }) {
    const endNextDay = addOneDayIso(range.endDate);
    return {
      start: `${range.startDate}T07:00:00.000Z`, // 00:00 PT
      end: `${endNextDay}T06:59:59.999Z`,         // 23:59:59 PT on endDate
    };
  }
  function addOneDayIso(dateYmd: string): string {
    const d = new Date(`${dateYmd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  /** Convert OrderFilters + null-fill all other fields Northbeam expects. */
  function buildOrderFilterOptions(f: z.infer<typeof OrderFilters> | undefined, includeDateRange?: { start: string; end: string }) {
    const base = {
      discountCodes: f?.discountCodes ?? null,
      subscriptions: f?.subscriptions ?? null,
      customerTags: f?.customerTags ?? null,
      orderTags: f?.orderTags ?? null,
      sourceName: f?.sourceName ?? null,
      orderTypes: f?.orderTypes ?? null,
      products: f?.products ?? null,
      attributed: f?.attributed ?? null,
      adjustForReturns: f?.adjustForReturns ?? false,
      adPlatforms: f?.adPlatforms ?? null,
      ecommercePlatforms: f?.ecommercePlatforms ?? null,
    };
    return includeDateRange ? { ...base, dateRange: includeDateRange } : base;
  }

  // Northbeam's `OrdersSortingField` enum only accepts `date`; any other field
  // (revenue, touchpoints, etc.) must be sorted client-side.
  const ORDERS_SORTABLE_METRICS = [
    'revenueInDollars',
    'numberOfTouchpoints',
    'refundAmountInDollars',
    'discountValue',
  ] as const;
  const ORDERS_METRIC_ALIASES: Record<string, (typeof ORDERS_SORTABLE_METRICS)[number]> = {
    revenue: 'revenueInDollars',
    revenues: 'revenueInDollars',
    touchpoints: 'numberOfTouchpoints',
    touchpoint: 'numberOfTouchpoints',
    refund: 'refundAmountInDollars',
    refunds: 'refundAmountInDollars',
    discount: 'discountValue',
    discounts: 'discountValue',
  };
  const normalizeOrdersMetric = (v: unknown): unknown => {
    const s = typeof v === 'string' ? v.replace(/^["']+|["']+$/g, '') : v;
    if (typeof s === 'string' && s in ORDERS_METRIC_ALIASES) return ORDERS_METRIC_ALIASES[s];
    return s;
  };

  const OrdersListArgs = z.object({
    dateRange: DateRange,
    filters: OrderFilters.optional(),
    sortOrder: z.preprocess(normalizeEnum, z.enum(['asc', 'desc'])).default('desc'),
    /**
     * Optional: sort results client-side by this metric (descending order
     * always). Overrides the default date-based sort. Northbeam's API only
     * allows server-side sort by date, so non-date sorts are applied after
     * fetching.
     */
    sortByMetric: z.preprocess(normalizeOrdersMetric, z.enum(ORDERS_SORTABLE_METRICS)).optional(),
    limit: z.number().int().min(1).max(5000).default(25),
    offset: z.number().int().min(0).default(0),
  });
  type OrdersListArgs = z.infer<typeof OrdersListArgs>;

  const ordersList: ToolDef<OrdersListArgs> = {
    name: 'northbeam.orders_list',
    description:
      'Returns individual orders (revenue, customer email, products, touchpoints, attributed flag, first-time vs returning) for a date range with optional filters. Use for questions like "who bought a Pavone Floor Light last week", "top 10 orders yesterday by revenue", "list unattributed orders this month", or "how many first-time vs returning orders".',
    schema: OrdersListArgs as z.ZodType<OrdersListArgs>,
    jsonSchema: zodToJsonSchema(OrdersListArgs),
    async execute(args) {
      // For client-side metric sort we need to pull the whole dataset for the
      // period; otherwise respect the requested page.
      const needsAllRows = !!args.sortByMetric;
      const variables = {
        filterOptions: buildOrderFilterOptions(args.filters, toIsoDateRange(args.dateRange)),
        sorting: { sortingField: 'date', sortingOrder: args.sortOrder },
        limit: needsAllRows ? 1000 : args.limit,
        offset: needsAllRows ? 0 : args.offset,
      };
      const key = TtlCache.key('nb.orders_list.v2', {
        ...variables,
        sortByMetric: args.sortByMetric ?? null,
        limit: args.limit,
        offset: args.offset,
      } as Record<string, unknown>);
      const cached = await deps.cache.get(key);
      if (cached) return cached;
      const data = await deps.gql.request<{
        me: {
          orders: {
            data: Array<Record<string, unknown> & { revenueInDollars?: number | null }>;
            totalCount: number;
          };
        };
      }>('FetchOrderSummary', FETCH_ORDER_SUMMARY, variables);

      let orders = data.me.orders.data;
      if (args.sortByMetric) {
        const metric = args.sortByMetric;
        orders = orders
          .slice()
          .sort((a, b) => ((b[metric] as number | null) ?? -Infinity) - ((a[metric] as number | null) ?? -Infinity))
          .slice(args.offset, args.offset + args.limit);
      }

      const result = {
        period: args.dateRange,
        sortedBy: args.sortByMetric ?? `date ${args.sortOrder}`,
        orders,
        totalCount: data.me.orders.totalCount,
        returnedCount: orders.length,
      };
      await deps.cache.set(key, result, cacheTtl(args.dateRange, nowISO));
      return result;
    },
  };

  const OrdersSummaryArgs = z.object({
    dateRange: DateRange,
    filters: OrderFilters.optional(),
    compareToPreviousPeriod: z.boolean().default(true),
    granularity: z.preprocess(normalizeEnum, z.enum(['DAY', 'WEEK', 'MONTH'])).default('DAY'),
    includeTimeSeries: z.boolean().default(false),
  });
  type OrdersSummaryArgs = z.infer<typeof OrdersSummaryArgs>;

  const ordersSummary: ToolDef<OrdersSummaryArgs> = {
    name: 'northbeam.orders_summary',
    description:
      'Returns aggregate order KPIs (`orderRevenue`, `orderCount`) for a date range, compared against the previous period by default. Optionally returns daily/weekly/monthly time-series. Use for summary questions like "total revenue last week", "how many orders yesterday", "orders by day for April".',
    schema: OrdersSummaryArgs as z.ZodType<OrdersSummaryArgs>,
    jsonSchema: zodToJsonSchema(OrdersSummaryArgs),
    async execute(args) {
      const dateRangeIso = toIsoDateRange(args.dateRange);
      const filterOptions = buildOrderFilterOptions(args.filters);
      const cacheKey = TtlCache.key('nb.orders_summary', { args } as Record<string, unknown>);
      const cached = await deps.cache.get(cacheKey);
      if (cached) return cached;

      const compareRange = args.compareToPreviousPeriod ? previousPeriod(args.dateRange) : null;
      const compareRangeIso = compareRange ? toIsoDateRange(compareRange) : null;

      const kpiPromise = deps.gql.request<{
        me: {
          orderSummaryGraphKPI: {
            currentKPIs: { orderRevenue: number; orderCount: number };
            comparisonKPIs: { orderRevenue: number; orderCount: number };
          };
        };
      }>(
        'FetchOrderSummaryGraphKPI',
        FETCH_ORDER_SUMMARY_GRAPH_KPI,
        {
          dateRange: dateRangeIso,
          comparedDateRange: compareRangeIso ?? dateRangeIso,
          filterOptions,
        },
      );

      const graphPromise = args.includeTimeSeries
        ? deps.gql.request<{
            me: { orderSummaryGraph: { data: Array<{ orderRevenue: number; orderCount: number; datetime: string }> } };
          }>('FetchOrderSummaryGraph', FETCH_ORDER_SUMMARY_GRAPH, {
            dateRange: dateRangeIso,
            granularity: args.granularity,
            filterOptions,
          })
        : Promise.resolve(null);

      const [kpiData, graphData] = await Promise.all([kpiPromise, graphPromise]);
      const kpi = kpiData.me.orderSummaryGraphKPI;

      const result = {
        period: args.dateRange,
        comparePeriod: compareRange,
        actual: { revenue: kpi.currentKPIs.orderRevenue, orderCount: kpi.currentKPIs.orderCount },
        comparison: args.compareToPreviousPeriod
          ? { revenue: kpi.comparisonKPIs.orderRevenue, orderCount: kpi.comparisonKPIs.orderCount }
          : null,
        timeSeries: graphData?.me.orderSummaryGraph.data ?? null,
      };
      await deps.cache.set(cacheKey, result, cacheTtl(args.dateRange, nowISO));
      return result;
    },
  };

  return [overview, sales, listBreakdowns, listMetrics, connectedPartners, ordersList, ordersSummary];
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
