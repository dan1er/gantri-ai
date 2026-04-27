/**
 * Curated example output shapes for EVERY tool whitelisted for live reports.
 * The compiler LLM sees these in the prompt so it can pick exact field names
 * instead of guessing.
 *
 * Why this exists: we kept seeing the LLM produce specs with refs like
 * `totals.rows[0].rev` because it was reasoning from input schemas only.
 * Now it sees concrete output samples for every tool.
 *
 * INVARIANT: every key in `WHITELISTED_TOOLS` (src/reports/live/spec.ts) MUST
 * have an entry here. The compiler validates this at module-load time and
 * throws if any tool is missing — that prevents the LLM from ever guessing.
 *
 * Maintenance rule: when a tool's output shape changes, update its sample
 * here in the same commit. Adding a new tool to the live-report whitelist?
 * Add a sample here too.
 */

import { WHITELISTED_TOOLS } from '../../reports/live/spec.js';

interface ToolOutputSample {
  /** One-line summary: shape of the rows, where the totals live, gotchas. */
  summary: string;
  /** A concrete (truncated) example of the actual JSON the tool returns.
   *  Field names here are the ground truth — use them VERBATIM. */
  example: unknown;
}

export const TOOL_OUTPUT_SHAPES: Record<string, ToolOutputSample> = {
  // ---------- Northbeam ----------
  'northbeam.metrics_explorer': {
    summary: 'Top-level: { metrics, rowCount, headers, rows, attributionModel, accountingMode, attributionWindow }. THE DATA IS ALL IN `rows`. There is NO top-level `totals`. The breakdown column (whatever key you passed) is renamed to `breakdown_value` server-side. Each metric ID becomes a column with the SAME name as the metric ID — EXCEPT `txns` whose CSV column is `transactions` (the connector keeps it as `transactions`, NOT `txns`, in row data). Daily breakdowns (bucketByDate:true) add a `date` column. Numeric values arrive as STRINGS — coerce with Number().',
    example: {
      attributionModel: 'northbeam_custom__va',
      accountingMode: 'cash',
      attributionWindow: '1',
      metrics: ['rev', 'spend', 'txns'],
      rowCount: 2,
      headers: ['breakdown_value', 'rev', 'spend', 'transactions'],
      rows: [
        { breakdown_value: 'Google Ads', rev: '11304.18', spend: '2572.06', transactions: '21.93' },
        { breakdown_value: 'Organic', rev: '6266.56', spend: '0', transactions: '10.56' },
      ],
    },
  },
  'northbeam.list_metrics': {
    summary: 'Catalog of metric IDs. { count, metrics: [{ id, displayName, … }] }. Use to discover metric IDs (e.g. "Revenue" → `rev`).',
    example: {
      count: 47,
      metrics: [
        { id: 'rev', displayName: 'Revenue' },
        { id: 'spend', displayName: 'Spend' },
        { id: 'txns', displayName: 'Transactions' },
        { id: 'aovFt', displayName: 'AOV (1st time)' },
      ],
    },
  },
  'northbeam.list_breakdowns': {
    summary: 'Catalog of breakdown keys + their valid enum values. { count, breakdowns: [{ key, values: [...] }] }.',
    example: {
      count: 5,
      breakdowns: [
        { key: 'Platform (Northbeam)', values: ['Google Ads', 'Facebook Ads', 'Organic', 'Email'] },
        { key: 'Forecast', values: ['Affiliate', 'Direct', 'Email', 'Google Ads'] },
      ],
    },
  },
  'northbeam.list_attribution_models': {
    summary: 'Catalog of attribution model IDs. { count, models: [{ id, name }] }.',
    example: {
      count: 7,
      models: [
        { id: 'northbeam_custom__va', name: 'Clicks + Modeled Views' },
        { id: 'last_touch', name: 'Last Touch' },
      ],
    },
  },
  'northbeam.list_orders': {
    summary: 'Per-order list with attribution context. { count, orders: [{ orderId, customerEmail, channel, ... }] }. Used for drilling into individual orders attributed to a channel.',
    example: {
      count: 2,
      orders: [
        { orderId: '12345', customerEmail: 'a@example.com', channel: 'Google Ads', revenue: 120.5, attributedAt: '2026-04-22' },
      ],
    },
  },

  // ---------- Gantri (Porter / DB / sales) ----------
  'gantri.order_stats': {
    summary: 'Period-aggregated order stats from Porter. Top-level scalars (totalOrders, totalRevenueDollars, avgOrderValueDollars) plus per-status / per-type breakdown arrays. NO row-level access. Use scalars for headline KPIs; use `typeBreakdown` rows for tables.',
    example: {
      period: 'last_7_days',
      typesFilter: null,
      source: 'porter',
      totalOrders: 139,
      totalRevenueDollars: 60446.92,
      avgOrderValueDollars: 434.87,
      statusBreakdown: [
        { status: 'Processed', count: 90, revenueDollars: 45000.5 },
        { status: 'Shipped', count: 49, revenueDollars: 15446.42 },
      ],
      typeBreakdown: [
        { type: 'Order', count: 57, revenueDollars: 27097.13 },
        { type: 'Wholesale', count: 43, revenueDollars: 12697.4 },
      ],
      truncated: false,
      breakdownIncomplete: false,
    },
  },
  'gantri.orders_query': {
    summary: 'Searched/filtered list of individual orders from Porter. { totalMatching, page, returnedCount, orders: [{ id, type, status, customerName, email, totalDollars, ... }] }. Use `orders[]` for tables; `totalMatching` for KPI counts.',
    example: {
      totalMatching: 47,
      maxPages: 5,
      page: 1,
      returnedCount: 25,
      orders: [
        { id: 53485, type: 'Order', status: 'Processed', customerName: 'Jane Doe', email: 'jane@example.com', userId: 1234, totalCents: 12000, totalDollars: 120 },
      ],
    },
  },
  'gantri.late_orders_report': {
    summary: 'Snapshot of currently-late orders. { totalLate, ordersListed, buckets, orders }. `buckets.byDeadline.customerDeadlineMissed` is the headline. `orders[]` has primaryCause, causeSummary, daysPastDeliveryBy, deadlineMissed (boolean).',
    example: {
      totalLate: 48,
      ordersListed: 48,
      buckets: {
        byDaysLate: { '0-3': 17, '4-7': 10, '8-14': 7, '15+': 14 },
        byPrimaryCause: { 'Part scrapped': 2, 'Reworked 4×': 10, 'gunk': 3 },
        byType: { Order: 26, Wholesale: 12, Trade: 5 },
        byDeadline: { customerDeadlineMissed: 21, withinCustomerWindow: 27, noCustomerDeadline: 0 },
      },
      orders: [
        { id: 51083, type: 'Marketing', status: 'Processed', customerName: 'Jennifer Pham', daysPastDeliveryBy: 64, deadlineMissed: true, daysLate: 71, totalDollars: 0, primaryCause: 'Part scrapped', causeSummary: 'Part scrapped (78) — reworked 3×, other failure modes', noteFlags: [], adminLink: 'https://admin.gantri.com/orders/51083' },
      ],
    },
  },
  'gantri.sales_report': {
    summary: 'Per-transaction-type sales rollup. { period, source, rows, totals, summary }. `rows[]` has one entry per type (Order, Wholesale, Trade, Refund, etc.). `totals` and `summary` are the SAME object (aliased). Money fields are aliased under multiple naming conventions (fullTotal === full_total === fullTotalDollars === totalRevenue).',
    example: {
      period: 'last_7_days',
      source: 'grafana_sales_panel',
      rows: [
        { type: 'Order', orders: 57, items: 92, giftCards: 0, gift_cards: 0, subtotal: 25000, shipping: 1500, tax: 597.13, discount: 0, credit: 0, salesExclTax: 26500, sales_excl_tax: 26500, fullTotal: 27097.13, full_total: 27097.13 },
      ],
      totals: { orders: 139, items: 220, giftCards: 0, fullTotal: 60446.92, fullTotalDollars: 60446.92, full_total: 60446.92, totalRevenue: 60446.92, subtotal: 50000, shipping: 1500, tax: 1500, discount: 0, salesExclTax: 51500 },
    },
  },
  'gantri.compare_orders_nb_vs_porter': {
    summary: 'Side-by-side count + revenue from NB and Porter for the same period — used to validate that the two sources agree. { period, northbeam: { count, revenue }, porter: { count, revenue }, diff: { countDelta, revenueDelta, revenuePctDelta } }.',
    example: {
      period: { startDate: '2026-04-21', endDate: '2026-04-27' },
      northbeam: { count: 138, revenue: 60230.5 },
      porter: { count: 139, revenue: 60446.92 },
      diff: { countDelta: -1, revenueDelta: -216.42, revenuePctDelta: -0.0036 },
    },
  },
  'gantri.diff_orders_nb_vs_porter': {
    summary: 'Per-order diff between NB and Porter for the same period. { period, onlyInPorter: [...], onlyInNorthbeam: [...], discrepancies: [...] }. Each entry includes orderId + the conflicting fields.',
    example: {
      period: { startDate: '2026-04-21', endDate: '2026-04-27' },
      onlyInPorter: [{ orderId: 53612, type: 'Order', revenue: 100 }],
      onlyInNorthbeam: [{ orderId: 'NB-12345', revenue: 80 }],
      discrepancies: [{ orderId: 53485, porterRevenue: 120, nbRevenue: 100 }],
    },
  },
  'gantri.attribution_compare_models': {
    summary: '7-attribution-model side-by-side. { period, platformFilter, metrics, models: [{ model_id, model_name, rev, spend, txns, roas } | { model_id, model_name, error }] }.',
    example: {
      period: 'last_30_days',
      platformFilter: null,
      metrics: ['rev', 'spend', 'txns'],
      models: [
        { model_id: 'northbeam_custom__va', model_name: 'Clicks + Modeled Views', rev: 245000, spend: 50000, txns: 587, roas: 4.9 },
        { model_id: 'last_touch', model_name: 'Last Touch', rev: 220000, spend: 50000, txns: 540, roas: 4.4 },
      ],
    },
  },
  'gantri.ltv_cac_by_channel': {
    summary: 'Per-channel LTV/CAC. { period, breakdown, rows: [{ channel, revenue, first_time_revenue, spend, cac_first_time, aov_first_time, aov_first_time_ltv, roas_first_time, roas_first_time_ltv, ltv_cac_ratio }], headers }.',
    example: {
      period: 'last_30_days',
      breakdown: 'Platform (Northbeam)',
      rows: [
        { channel: 'Google Ads', revenue: 100000, first_time_revenue: 60000, spend: 25000, cac_first_time: 50, aov_first_time: 200, aov_first_time_ltv: 350, roas_first_time: 2.4, roas_first_time_ltv: 4.2, ltv_cac_ratio: 7 },
      ],
      headers: ['breakdown_platform_northbeam', 'rev', 'spend', 'cacFt', 'aovFt', 'aovFtLtv', 'roasFt', 'roasFtLtv'],
    },
  },
  'gantri.new_vs_returning_split': {
    summary: 'Per-channel new vs returning split. { period, breakdown, level, rows: [{ channel, campaign?, revenue_total, revenue_new, revenue_returning, pct_new_revenue, transactions_total, transactions_new, transactions_returning, spend, cac, cac_new }] }.',
    example: {
      period: 'last_30_days',
      breakdown: 'Platform (Northbeam)',
      level: 'platform',
      rows: [
        { channel: 'Google Ads', revenue_total: 100000, revenue_new: 60000, revenue_returning: 40000, pct_new_revenue: 60, transactions_total: 250, transactions_new: 150, transactions_returning: 100, spend: 25000, cac: 100, cac_new: 167 },
      ],
    },
  },
  'gantri.budget_optimization_report': {
    summary: 'Per-campaign current-vs-prior period marginal ROAS. { currentPeriod, priorPeriod, minSpendDollars, rows: [{ platform, campaign, current_rev, current_spend, current_roas, prior_rev, prior_spend, prior_roas, delta_rev, delta_spend, marginal_roas }] }. Sorted ascending by marginal_roas (worst first).',
    example: {
      currentPeriod: { startDate: '2026-04-14', endDate: '2026-04-27' },
      priorPeriod: { startDate: '2026-03-31', endDate: '2026-04-13' },
      minSpendDollars: 100,
      rows: [
        { platform: 'Google Ads', campaign: 'Brand search', current_rev: 50000, current_spend: 8000, current_roas: 6.25, prior_rev: 45000, prior_spend: 7000, prior_roas: 6.43, delta_rev: 5000, delta_spend: 1000, marginal_roas: 5 },
      ],
    },
  },

  // ---------- GA4 ----------
  'ga4.run_report': {
    summary: 'Generic GA4 report. { period, rowCount, dimensions, metrics, rows }. `rows[]` has FLAT keys — one key per dimension/metric (e.g. `{ pagePath: "/", sessions: 12450, engagedSessions: 8123 }`). Numeric metrics auto-coerced to numbers.',
    example: {
      period: 'last_30_days',
      rowCount: 2,
      dimensions: ['pagePath'],
      metrics: ['sessions', 'engagedSessions'],
      rows: [
        { pagePath: '/', sessions: 12450, engagedSessions: 8123 },
        { pagePath: '/products', sessions: 8200, engagedSessions: 5400 },
      ],
    },
  },
  'ga4.realtime': {
    summary: 'GA4 realtime. Same flat-row shape as run_report but no `period`. { rowCount, dimensions, metrics, rows }.',
    example: {
      rowCount: 1,
      dimensions: ['country'],
      metrics: ['activeUsers'],
      rows: [{ country: 'United States', activeUsers: 412 }],
    },
  },
  'ga4.list_events': {
    summary: 'Top events by count. Same flat-row shape: { period, rowCount, dimensions: ["eventName"], metrics: ["eventCount", "totalUsers"], rows: [{ eventName, eventCount, totalUsers }] }.',
    example: {
      period: 'last_30_days',
      rowCount: 1,
      dimensions: ['eventName'],
      metrics: ['eventCount', 'totalUsers'],
      rows: [{ eventName: 'page_view', eventCount: 45000, totalUsers: 12000 }],
    },
  },
  'ga4.page_engagement_summary': {
    summary: 'Page-level scroll & traffic summary. { period, minPageViews, topN, totals, topByTraffic, highestScrollRate, lowestScrollRate, flaggedPages, notes }. `totals` is a single object; the four list fields are arrays of `{ pagePath, pageViews, scrolls, scrollRate, users }`.',
    example: {
      period: 'last_7_days',
      minPageViews: 100,
      topN: 10,
      totals: { pageViews: 150000, scrollEvents: 80000, siteScrollRate: 0.533, uniquePagesObserved: 3500, eligiblePages: 320 },
      topByTraffic: [{ pagePath: '/', pageViews: 45000, scrolls: 22000, scrollRate: 0.489, users: 12000 }],
      highestScrollRate: [{ pagePath: '/about', pageViews: 800, scrolls: 720, scrollRate: 0.9, users: 600 }],
      lowestScrollRate: [{ pagePath: '/checkout', pageViews: 5000, scrolls: 100, scrollRate: 0.02, users: 4500 }],
      flaggedPages: [],
      notes: 'scrollRate is `scroll / page_view` per URL.',
    },
  },

  // ---------- Grafana ----------
  'grafana.list_dashboards': {
    summary: 'Grafana dashboards index. { count, dashboards: [{ uid, title, folder }] }.',
    example: {
      count: 2,
      dashboards: [
        { uid: 'sales-overview', title: 'Sales Overview', folder: 'Finance' },
        { uid: 'ops-health', title: 'Ops Health', folder: '(root)' },
      ],
    },
  },
  'grafana.run_dashboard': {
    summary: 'Execute every panel of a dashboard. { dashboard, period, panels: [{ panelId, title, fields, rows } | { panelId, title, error, fields: [], rows: [] }] }. Each panel\'s `rows[]` is a SQL result, with column names from `fields[]` as keys.',
    example: {
      dashboard: { uid: 'sales-overview', title: 'Sales Overview' },
      period: { startDate: '2026-04-21', endDate: '2026-04-27' },
      panels: [
        { panelId: 1, title: 'Revenue by day', fields: ['date', 'revenue'], rows: [{ date: '2026-04-21', revenue: 8500 }, { date: '2026-04-22', revenue: 9200 }] },
      ],
    },
  },
  'grafana.sql': {
    summary: 'Run an ad-hoc SQL query against the Porter read-replica. { fields, rows }. Each `rows[]` entry is a flat object with column names as keys. Amounts on Transactions.amount are JSON in cents — divide by 100 for dollars in the SQL itself.',
    example: {
      fields: ['type', 'count', 'revenue'],
      rows: [
        { type: 'Order', count: 57, revenue: 27097.13 },
        { type: 'Wholesale', count: 43, revenue: 12697.4 },
      ],
    },
  },
};

// Compile-time invariant: every whitelisted tool MUST have a documented shape.
// If you add a tool to WHITELISTED_TOOLS without updating this file, this
// throws on app boot — failing fast is preferred over the LLM guessing.
{
  const documented = new Set(Object.keys(TOOL_OUTPUT_SHAPES));
  const undocumented: string[] = [];
  for (const tool of WHITELISTED_TOOLS) {
    if (!documented.has(tool)) undocumented.push(tool);
  }
  if (undocumented.length > 0) {
    throw new Error(
      `tool-output-shapes.ts is missing documentation for these whitelisted tools: ${undocumented.join(', ')}. ` +
      'Every whitelisted tool MUST have an output sample so the live-report compiler never has to guess.',
    );
  }
}

/** Render the catalog as a markdown section the compiler prompt can embed. */
export function renderToolOutputShapes(): string {
  const sections: string[] = [
    '# TOOL OUTPUT SHAPES — these are the ACTUAL field names returned at runtime.',
    'You MUST use these exact field names in your data refs. Do NOT invent fields, do NOT pluralize/singularize, do NOT translate ("rev" stays "rev", "txns" returns as "transactions" in row data).',
    '',
    'If you need a tool that is NOT documented below, DO NOT use it — fail the compile with an error message asking for the shape to be documented first. NEVER guess a shape.',
  ];
  for (const [tool, sample] of Object.entries(TOOL_OUTPUT_SHAPES)) {
    sections.push(
      `\n## \`${tool}\``,
      sample.summary,
      '```json',
      JSON.stringify(sample.example, null, 2),
      '```',
    );
  }
  return sections.join('\n');
}
