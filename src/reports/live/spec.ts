import { z } from 'zod';

/**
 * A date-range value that a step arg may reference.
 * - Preset string (e.g. "last_7_days")
 * - Object with explicit start/end dates (YYYY-MM-DD)
 * - The literal token "$REPORT_RANGE" — substituted at runtime with the
 *   viewer's effective range (URL override or spec default).
 */
export const DateRangeRef = z.union([
  z.literal('$REPORT_RANGE'),
  z.enum(['yesterday', 'last_7_days', 'last_14_days', 'last_30_days', 'last_90_days', 'last_180_days', 'last_365_days', 'this_month', 'last_month', 'month_to_date', 'quarter_to_date', 'year_to_date']),
  z.object({ start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);

export type DateRangeRef = z.infer<typeof DateRangeRef>;

/**
 * Whitelist of tool names a Live Report spec may invoke. Enforced both at
 * compile time (Zod) and at runtime (the runner double-checks before
 * dispatching). Adding a new tool to this set means it has been audited as
 * safe for unattended invocation: read-only, args validated by its own Zod
 * schema, output stable across versions.
 */
export const WHITELISTED_TOOLS = new Set<string>([
  // Northbeam
  'northbeam.metrics_explorer',
  'northbeam.list_metrics',
  'northbeam.list_breakdowns',
  'northbeam.list_attribution_models',
  'northbeam.list_orders',
  // Gantri Porter aggregations + analyses
  'gantri.order_stats',
  'gantri.orders_query',
  'gantri.late_orders_report',
  'gantri.sales_report',
  'gantri.compare_orders_nb_vs_porter',
  'gantri.diff_orders_nb_vs_porter',
  'gantri.attribution_compare_models',
  'gantri.ltv_cac_by_channel',
  'gantri.new_vs_returning_split',
  'gantri.budget_optimization_report',
  // GA4
  'ga4.run_report',
  'ga4.realtime',
  'ga4.list_events',
  'ga4.page_engagement_summary',
  // Grafana
  'grafana.sql',
  'grafana.run_dashboard',
  'grafana.list_dashboards',
  // Impact.com partnerships
  'impact.list_partners',
  'impact.list_actions',
  'impact.partner_performance',
  // Klaviyo email/SMS
  'klaviyo.campaign_performance',
  'klaviyo.consented_signups',
  'klaviyo.flow_performance',
  'klaviyo.list_campaigns',
  'klaviyo.list_segments',
  // Google Search Console (SEO)
  'gsc.list_sites',
  'gsc.search_performance',
  'gsc.inspect_url',
  // Pipedrive CRM (B2B trade / wholesale)
  'pipedrive.activity_summary',
  'pipedrive.deal_detail',
  'pipedrive.deal_timeseries',
  'pipedrive.list_deals',
  'pipedrive.list_directory',
  'pipedrive.lost_reasons_breakdown',
  'pipedrive.organization_detail',
  'pipedrive.organization_performance',
  'pipedrive.pipeline_snapshot',
  'pipedrive.search',
  'pipedrive.user_performance',
]);

const ToolName = z.string().refine((t) => WHITELISTED_TOOLS.has(t), {
  message: 'Tool is not whitelisted for live reports',
});

const StepId = z.string().min(1).max(64).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'id must be a valid identifier');

/** A regular tool-invoking step. `kind` is optional (defaults to "tool") so
 *  existing persisted specs without the field continue to validate. */
const ToolStep = z.object({
  id: StepId,
  kind: z.literal('tool').optional(),
  tool: ToolName,
  args: z.record(z.unknown()),
});

/**
 * Scalar arithmetic over already-resolved step results. Evaluated AFTER all
 * tool steps complete. The result is stored at `dataResults[id]` and
 * referenced from kpi blocks like any data ref.
 *
 * Example — week-over-week % change:
 *   { id: 'wow', kind: 'derived', op: 'pct_change',
 *     a: 'this_week.totals.fullTotal', b: 'last_week.totals.fullTotal' }
 *
 * Both `a` and `b` MUST be ValueRefs (paths into `dataResults`); literals
 * are not supported — keeps the spec auditable and the eval trivial.
 */
const DerivedStep = z.object({
  id: StepId,
  kind: z.literal('derived'),
  op: z.enum(['add', 'subtract', 'multiply', 'divide', 'pct_change']),
  a: z.string().min(1).max(200),
  b: z.string().min(1).max(200),
});

const DataStep = z.union([ToolStep, DerivedStep]);

const ValueRef = z.string().min(1).max(200);

const KpiBlock = z.object({
  type: z.literal('kpi'),
  label: z.string().min(1).max(80),
  value: ValueRef,
  delta: z.object({
    from: ValueRef,
    format: z.enum(['percent', 'absolute']).default('percent'),
  }).optional(),
  format: z.enum(['currency', 'number', 'percent']).default('number'),
  width: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(1),
});

const ChartBlock = z.object({
  type: z.literal('chart'),
  variant: z.enum(['line', 'area', 'bar', 'donut', 'horizontal_bar']),
  title: z.string().min(1).max(120),
  data: ValueRef,
  x: z.string().min(1).max(64),
  y: z.union([z.string().min(1).max(64), z.array(z.string().min(1).max(64)).min(1).max(8)]),
  yFormat: z.enum(['currency', 'number', 'percent']).default('number'),
  height: z.enum(['sm', 'md', 'lg']).default('md'),
});

const TableColumn = z.object({
  field: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  format: z.enum(['currency', 'number', 'percent', 'date_pt', 'admin_order_link', 'pct_delta']).optional(),
  align: z.enum(['left', 'right', 'center']).default('left'),
});

const TableBlock = z.object({
  type: z.literal('table'),
  title: z.string().min(1).max(120).optional(),
  data: ValueRef,
  columns: z.array(TableColumn).min(1).max(20),
  sortBy: z.object({
    field: z.string().min(1).max(64),
    direction: z.enum(['asc', 'desc']).default('desc'),
  }).optional(),
  pageSize: z.number().int().min(1).max(500).default(25),
});

const TextBlock = z.object({
  type: z.literal('text'),
  markdown: z.string().min(1).max(20_000),
});

const DividerBlock = z.object({
  type: z.literal('divider'),
});

const UiBlock = z.discriminatedUnion('type', [KpiBlock, ChartBlock, TableBlock, TextBlock, DividerBlock]);

export const LiveReportSpec = z.object({
  version: z.literal(1),
  title: z.string().min(1).max(200),
  subtitle: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(4000).optional(),
  data: z.array(DataStep).min(1).max(20),
  ui: z.array(UiBlock).min(1).max(60),
  cacheTtlSec: z.number().int().min(0).max(86_400).default(300),
  dateRange: DateRangeRef.default('last_7_days').describe('Default date range for the report. Steps reference it via "$REPORT_RANGE" — the runner substitutes the effective range (URL override or this default) before dispatching.'),
});

export type LiveReportSpec = z.infer<typeof LiveReportSpec>;
export type DataStep = z.infer<typeof DataStep>;
export type UiBlock = z.infer<typeof UiBlock>;
export type KpiBlock = z.infer<typeof KpiBlock>;
export type ChartBlock = z.infer<typeof ChartBlock>;
export type TableBlock = z.infer<typeof TableBlock>;
export type TextBlock = z.infer<typeof TextBlock>;
