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
  /** Verified-against-source contract: the EXACT set of top-level keys the
   *  tool returns. Validated by tests/unit/live-reports/tool-output-shapes.test.ts
   *  against `Object.keys(example)` so the example object can't drift away
   *  from this declared contract.
   *
   *  When updating a tool's output, you MUST update this list AND the example
   *  in the same commit — otherwise the LLM will get stale guidance and
   *  generate broken specs. The unit test enforces this. */
  expectedTopLevelKeys: readonly string[];
  /** Optional: for each array field, declare the expected element-level keys.
   *  Tests assert the example's first row contains all of these. This catches
   *  the most common drift case (column rename inside a `rows[]` array). */
  expectedArrayElementKeys?: Record<string, readonly string[]>;
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
    expectedTopLevelKeys: ['attributionModel', 'accountingMode', 'attributionWindow', 'metrics', 'rowCount', 'headers', 'rows'],
    expectedArrayElementKeys: { rows: ['breakdown_value', 'rev', 'spend', 'transactions'] },
  },
  'northbeam.list_metrics': {
    summary: 'Catalog of metric IDs. { count, metrics: [{ id, label }] }. The display string is in `label`, NOT `displayName`. Use the `id` for `metrics_explorer.metrics[]`.',
    example: {
      count: 47,
      metrics: [
        { id: 'rev', label: 'Revenue' },
        { id: 'spend', label: 'Spend' },
        { id: 'txns', label: 'Transactions' },
        { id: 'aovFt', label: 'AOV (1st time)' },
      ],
    },
    expectedTopLevelKeys: ['count', 'metrics'],
    expectedArrayElementKeys: { metrics: ['id', 'label'] },
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
    expectedTopLevelKeys: ['count', 'breakdowns'],
    expectedArrayElementKeys: { breakdowns: ['key', 'values'] },
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
    expectedTopLevelKeys: ['count', 'models'],
    expectedArrayElementKeys: { models: ['id', 'name'] },
  },
  'northbeam.list_orders': {
    summary: 'Raw NB /v2/orders for a date range. Top-level: { period, source, count, totalReturned, cancelledOrDeletedExcluded, dailyBreakdown, orders }. `count` is post-filter (excludes cancelled/deleted); `totalReturned` is raw. `orders[]` items match the NB API order shape — most-used fields shown below.',
    example: {
      period: { startDate: '2026-04-21', endDate: '2026-04-27' },
      source: 'northbeam_v2_orders',
      count: 138,
      totalReturned: 142,
      cancelledOrDeletedExcluded: 4,
      dailyBreakdown: [
        { date: '2026-04-21', count: 22, revenue: 9500.5 },
        { date: '2026-04-22', count: 18, revenue: 7820.0 },
      ],
      orders: [
        { order_id: '12345', time_of_purchase: '2026-04-22T18:30:00Z', purchase_total: 145.5, is_cancelled: false, is_deleted: false, customer_id: '{"northbeam_api_customer_id":"65575"}', tags: ['paid_search'] },
      ],
    },
    expectedTopLevelKeys: ['period', 'source', 'count', 'totalReturned', 'cancelledOrDeletedExcluded', 'dailyBreakdown', 'orders'],
    expectedArrayElementKeys: {
      orders: ['order_id', 'time_of_purchase', 'purchase_total', 'is_cancelled', 'is_deleted'],
      dailyBreakdown: ['date', 'count', 'revenue'],
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
    expectedTopLevelKeys: ['period', 'typesFilter', 'source', 'totalOrders', 'totalRevenueDollars', 'avgOrderValueDollars', 'statusBreakdown', 'typeBreakdown', 'truncated', 'breakdownIncomplete'],
    expectedArrayElementKeys: {
      statusBreakdown: ['status', 'count', 'revenueDollars'],
      typeBreakdown: ['type', 'count', 'revenueDollars'],
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
    expectedTopLevelKeys: ['totalMatching', 'maxPages', 'page', 'returnedCount', 'orders'],
    expectedArrayElementKeys: { orders: ['id', 'type', 'status', 'customerName', 'totalDollars'] },
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
    expectedTopLevelKeys: ['totalLate', 'ordersListed', 'buckets', 'orders'],
    expectedArrayElementKeys: { orders: ['id', 'type', 'status', 'customerName', 'daysPastDeliveryBy', 'deadlineMissed', 'primaryCause', 'causeSummary', 'adminLink'] },
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
    expectedTopLevelKeys: ['period', 'source', 'rows', 'totals'],
    expectedArrayElementKeys: { rows: ['type', 'orders', 'items', 'subtotal', 'shipping', 'tax', 'fullTotal', 'full_total'] },
  },
  'gantri.compare_orders_nb_vs_porter': {
    summary: 'Per-day reconciliation between NB and Porter for type=Order. Top-level: { period, excludeToday, rows, totals, csv, notes }. THE DATA IS in `rows[]` (one entry per PT day) and `totals` (grand total). NO `northbeam`/`porter`/`diff` wrappers exist. Each row + totals has the SAME 6 numeric fields: porter_orders, porter_revenue, nb_orders, nb_revenue, order_diff, revenue_diff. `csv` is a pre-rendered comma-separated string of all rows + a TOTAL row. ARGS: `dateRange` accepts the live-reports `$REPORT_RANGE` token (preset enum or { startDate, endDate } with capital-D keys, both work).',
    example: {
      period: { startDate: '2026-04-21', endDate: '2026-04-27' },
      excludeToday: false,
      rows: [
        { date: '2026-04-21', porter_orders: 5, porter_revenue: 2018.63, nb_orders: 5, nb_revenue: 2018.63, order_diff: 0, revenue_diff: 0 },
        { date: '2026-04-22', porter_orders: 9, porter_revenue: 5131.29, nb_orders: 9, nb_revenue: 5131.29, order_diff: 0, revenue_diff: 0 },
      ],
      totals: { porter_orders: 258, porter_revenue: 123269.13, nb_orders: 258, nb_revenue: 123269.13, order_diff: 0, revenue_diff: 0 },
      csv: 'date,porter_orders,porter_revenue,nb_orders,nb_revenue,order_diff,revenue_diff\\n2026-04-21,5,2018.63,5,2018.63,0,0.00\\nTOTAL,258,123269.13,258,123269.13,0,0.00',
      notes: ['porter_revenue = SUM(amount.total) for type=Order, status NOT IN (Unpaid, Cancelled).', 'Both sides PT-day bucketed.'],
    },
    expectedTopLevelKeys: ['period', 'excludeToday', 'rows', 'totals', 'csv', 'notes'],
    expectedArrayElementKeys: { rows: ['date', 'porter_orders', 'porter_revenue', 'nb_orders', 'nb_revenue', 'order_diff', 'revenue_diff'] },
  },
  'gantri.diff_orders_nb_vs_porter': {
    summary: 'Per-order diff between NB and Porter. Top-level scalars come from a flat summary: { period, porter_count, nb_count, only_in_nb_count, only_in_porter_count, revenue_mismatch_count, status_mismatch_count, perfect_match }. Plus 4 row arrays: only_in_nb, only_in_porter, revenue_mismatch, status_mismatch — each capped at maxExamples. Plus `notes`. Use snake_case field names everywhere; field name is `period`, NOT `dateRange`.',
    example: {
      period: { startDate: '2026-04-21', endDate: '2026-04-27' },
      porter_count: 258,
      nb_count: 258,
      only_in_nb_count: 0,
      only_in_porter_count: 0,
      revenue_mismatch_count: 0,
      status_mismatch_count: 0,
      perfect_match: true,
      only_in_nb: [],
      only_in_porter: [],
      revenue_mismatch: [],
      status_mismatch: [],
      notes: ['porter_count = transactions where type=Order AND status NOT IN (Unpaid, Cancelled).'],
    },
    expectedTopLevelKeys: ['period', 'porter_count', 'nb_count', 'only_in_nb_count', 'only_in_porter_count', 'revenue_mismatch_count', 'status_mismatch_count', 'perfect_match', 'only_in_nb', 'only_in_porter', 'revenue_mismatch', 'status_mismatch', 'notes'],
  },
  'gantri.attribution_compare_models': {
    summary: '7-attribution-model side-by-side. { period, platformFilter, metrics, models }. `models[]` items have either { model_id, model_name, ...metricId } or { model_id, model_name, error } on failure. Each metric you requested becomes a key in the row using its METRIC ID name (rev, spend, txns) — `roas` is auto-computed only if you requested both rev and spend.',
    example: {
      period: 'last_30_days',
      platformFilter: null,
      metrics: ['rev', 'spend', 'txns'],
      models: [
        { model_id: 'northbeam_custom__va', model_name: 'Clicks + Modeled Views', rev: 245000, spend: 50000, txns: 587, roas: 4.9 },
        { model_id: 'last_touch', model_name: 'Last Touch', rev: 220000, spend: 50000, txns: 540, roas: 4.4 },
      ],
    },
    expectedTopLevelKeys: ['period', 'platformFilter', 'metrics', 'models'],
    expectedArrayElementKeys: { models: ['model_id', 'model_name'] },
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
    expectedTopLevelKeys: ['period', 'breakdown', 'rows', 'headers'],
    expectedArrayElementKeys: { rows: ['channel', 'revenue', 'first_time_revenue', 'spend', 'cac_first_time', 'aov_first_time', 'aov_first_time_ltv', 'ltv_cac_ratio'] },
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
    expectedTopLevelKeys: ['period', 'breakdown', 'level', 'rows'],
    expectedArrayElementKeys: { rows: ['channel', 'revenue_total', 'revenue_new', 'revenue_returning', 'pct_new_revenue', 'transactions_total', 'transactions_new', 'transactions_returning', 'spend', 'cac', 'cac_new'] },
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
    expectedTopLevelKeys: ['currentPeriod', 'priorPeriod', 'minSpendDollars', 'rows'],
    expectedArrayElementKeys: { rows: ['platform', 'campaign', 'current_rev', 'current_spend', 'current_roas', 'prior_rev', 'prior_spend', 'prior_roas', 'delta_rev', 'delta_spend', 'marginal_roas'] },
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
    expectedTopLevelKeys: ['period', 'rowCount', 'dimensions', 'metrics', 'rows'],
  },
  'ga4.realtime': {
    summary: 'GA4 realtime. Same flat-row shape as run_report but no `period`. { rowCount, dimensions, metrics, rows }.',
    example: {
      rowCount: 1,
      dimensions: ['country'],
      metrics: ['activeUsers'],
      rows: [{ country: 'United States', activeUsers: 412 }],
    },
    expectedTopLevelKeys: ['rowCount', 'dimensions', 'metrics', 'rows'],
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
    expectedTopLevelKeys: ['period', 'rowCount', 'dimensions', 'metrics', 'rows'],
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
    expectedTopLevelKeys: ['period', 'minPageViews', 'topN', 'totals', 'topByTraffic', 'highestScrollRate', 'lowestScrollRate', 'flaggedPages', 'notes'],
    expectedArrayElementKeys: {
      topByTraffic: ['pagePath', 'pageViews', 'scrolls', 'scrollRate', 'users'],
      highestScrollRate: ['pagePath', 'pageViews', 'scrolls', 'scrollRate', 'users'],
      lowestScrollRate: ['pagePath', 'pageViews', 'scrolls', 'scrollRate', 'users'],
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
    expectedTopLevelKeys: ['count', 'dashboards'],
    expectedArrayElementKeys: { dashboards: ['uid', 'title', 'folder'] },
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
    expectedTopLevelKeys: ['dashboard', 'period', 'panels'],
    expectedArrayElementKeys: { panels: ['panelId', 'title', 'fields', 'rows'] },
  },
  // ---------- Impact.com partnerships ----------
  'impact.list_partners': {
    summary: 'Media partner directory for the Impact.com brand account. { count, totalAcrossAccount, partners: [{ id, name, description, mediatype, country, status }] }. `count` = filtered (after `search`); `totalAcrossAccount` = full directory. Use this to resolve a human-readable partner name (e.g. "Wirecutter") to the `id` you need for `impact.partner_performance` / `impact.list_actions`.',
    example: {
      count: 2,
      totalAcrossAccount: 130,
      partners: [
        { id: '10078', name: 'Skimbit Ltd.', description: 'Skimlinks is the leader in commerce content...', mediatype: 'Content', country: 'GB', status: 'Active' },
        { id: '3121345', name: 'Benable', description: '', mediatype: 'Content', country: 'US', status: 'Active' },
      ],
    },
    expectedTopLevelKeys: ['count', 'totalAcrossAccount', 'partners'],
    expectedArrayElementKeys: { partners: ['id', 'name', 'description', 'mediatype', 'country', 'status'] },
  },
  'impact.list_actions': {
    summary: 'Per-conversion drilldown — one row per action (sale or signup) attributed to a partner. { dateRange, totalMatching, returnedCount, actions[] }. Each action has partner_id+name, state (PENDING/APPROVED/LOCKED/CLEARED/REVERSED), amount (gross sale), payout (commission), currency, dates, and `porter_order_id` which JOINS DIRECTLY to `gantri.orders_query`/Porter Transactions.id. Numeric fields are real numbers (already coerced from Impact CSV strings).',
    example: {
      dateRange: { startDate: '2026-04-20', endDate: '2026-04-27' },
      totalMatching: 11,
      returnedCount: 2,
      actions: [
        { id: '19816.6684.1552541', partner_id: '390418', partner_name: 'Wildfire Systems', state: 'PENDING', amount: 248, payout: 9.92, currency: 'USD', event_date: '2026-04-20T17:54:31-07:00', locking_date: '2026-05-28T00:00:00-07:00', cleared_date: '', referring_type: 'CLICK_COOKIE', referring_domain: '', promo_code: null, porter_order_id: '53904', customer_status: 'New', customer_country: 'US', customer_region: 'District of Columbia', customer_city: 'Washington' },
      ],
    },
    expectedTopLevelKeys: ['dateRange', 'totalMatching', 'returnedCount', 'actions'],
    expectedArrayElementKeys: { actions: ['id', 'partner_id', 'partner_name', 'state', 'amount', 'payout', 'currency', 'event_date', 'porter_order_id', 'customer_status'] },
  },
  'impact.partner_performance': {
    summary: 'Aggregates over /Actions, one row per partner. { dateRange, partnerCount, totals: { actions, revenue, payout, roas }, partners: [{ partner_id, partner_name, actions, revenue, payout, roas, avg_order_value, state_breakdown }] }. `state_breakdown` is an object keyed by Impact state (PENDING/APPROVED/LOCKED/CLEARED/REVERSED) with per-state counts — useful to spot pending-heavy or reversal-heavy partners.',
    example: {
      dateRange: { startDate: '2026-04-01', endDate: '2026-04-26' },
      partnerCount: 3,
      totals: { actions: 24, revenue: 5420.18, payout: 271.01, roas: 20 },
      partners: [
        { partner_id: '390418', partner_name: 'Wildfire Systems', actions: 9, revenue: 2230.5, payout: 89.22, roas: 25, avg_order_value: 247.83, state_breakdown: { PENDING: 7, APPROVED: 2 } },
        { partner_id: '10078', partner_name: 'Skimbit Ltd.', actions: 8, revenue: 1980, payout: 99, roas: 20, avg_order_value: 247.5, state_breakdown: { PENDING: 5, APPROVED: 3 } },
      ],
    },
    expectedTopLevelKeys: ['dateRange', 'partnerCount', 'totals', 'partners'],
    expectedArrayElementKeys: { partners: ['partner_id', 'partner_name', 'actions', 'revenue', 'payout', 'roas', 'avg_order_value', 'state_breakdown'] },
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
    expectedTopLevelKeys: ['fields', 'rows'],
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
