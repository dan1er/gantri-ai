import type { CachePolicy } from './cache-policy.js';

/**
 * Per-tool caching policies the bot ships with.
 *
 * - settleDays: days to wait after a period closes before its data is final.
 * - openTtlSec: how long to cache results that include open (still-changing) days.
 * - dateRangePath: where to find {startDate, endDate} inside the tool args.
 *
 * Tools not listed here are NOT cached.
 */
export const DEFAULT_CACHE_POLICIES: Record<string, CachePolicy> = {
  // Grafana SQL hits a read-replica; trust it immediately.
  'grafana.sql': { version: 1, settleDays: 0, openTtlSec: 60, dateRangePath: 'dateRange' },
  'grafana.run_dashboard': { version: 1, settleDays: 0, openTtlSec: 300, dateRangePath: 'dateRange' },

  // Porter API: refunds can adjust prior periods up to ~30d after the fact.
  'gantri.order_stats': { version: 1, settleDays: 30, openTtlSec: 60, dateRangePath: 'dateRange' },
  // gantri.orders_query / gantri.order_get are too volatile to cache (per-row
  // status mutates) — omit.

  // Northbeam: attribution settles within ~72h.
  'northbeam.overview': { version: 1, settleDays: 3, openTtlSec: 600, dateRangePath: 'dateRange' },
  'northbeam.sales': { version: 1, settleDays: 3, openTtlSec: 600, dateRangePath: 'dateRange' },
  'northbeam.orders_summary': { version: 1, settleDays: 3, openTtlSec: 600, dateRangePath: 'dateRange' },
  'northbeam.metrics_explorer': { version: 1, settleDays: 3, openTtlSec: 600, dateRangePath: 'dateRange' },
  // northbeam.orders_list left out — row-level data, too volatile.
};
