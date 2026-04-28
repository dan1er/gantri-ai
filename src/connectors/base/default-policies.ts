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

  // GA4: data is processed within hours; treat ranges ending 1+ days ago as final.
  // ga4.list_events is the event catalog — stable across the property, big TTL win.
  'ga4.list_events': { version: 1, settleDays: 1, openTtlSec: 3600, dateRangePath: 'dateRange' },
  'ga4.run_report': { version: 1, settleDays: 1, openTtlSec: 600, dateRangePath: 'dateRange' },
  // ga4.realtime is real-time by definition — never cache.

  // Live Reports — find/list are read-only; cache briefly so repeated calls in
  // a single conversation don't re-query Supabase.
  // dateRangePath points to a field that doesn't exist in these tools' args,
  // so decideCacheStrategy falls through to the openTtlSec TTL branch (range
  // is undefined → mode:'ttl' with openTtlSec). publish/recompile/archive are
  // mutating — never cache.
  'reports.find_similar_reports': { version: 1, settleDays: 0, openTtlSec: 60, dateRangePath: '_none' },
  'reports.list_my_reports': { version: 1, settleDays: 0, openTtlSec: 30, dateRangePath: '_none' },

  // Impact.com — actions go PENDING → APPROVED at Locking Date (~30d after
  // event), then CLEARED. Anything ~45+ days old has settled. Live data
  // (PENDING) changes throughout the day as new conversions land.
  'impact.list_partners': { version: 1, settleDays: 0, openTtlSec: 600, dateRangePath: '_none' },
  'impact.list_actions': { version: 1, settleDays: 45, openTtlSec: 300, dateRangePath: 'dateRange' },
  'impact.partner_performance': { version: 1, settleDays: 45, openTtlSec: 300, dateRangePath: 'dateRange' },

  // Klaviyo — *-values-reports endpoints have brutal limits (1/s burst,
  // 2/min steady, 225/day). Past-period data is settled (Klaviyo doesn't
  // backfill opens/clicks beyond a few days), so we settle aggressively.
  // Open windows refresh every 10 min — clicks/opens trickle in for
  // ~24-48h after a send.
  'klaviyo.list_campaigns': { version: 1, settleDays: 0, openTtlSec: 600, dateRangePath: '_none' },
  'klaviyo.list_segments': { version: 1, settleDays: 0, openTtlSec: 600, dateRangePath: '_none' },
  'klaviyo.campaign_performance': { version: 1, settleDays: 7, openTtlSec: 600, dateRangePath: 'dateRange' },
  'klaviyo.flow_performance': { version: 1, settleDays: 7, openTtlSec: 600, dateRangePath: 'dateRange' },
};
