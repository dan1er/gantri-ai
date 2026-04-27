// Page-depth analysis via the GA4 `scroll` event.
//
// In GA4 Enhanced Measurement, `scroll` fires once per page per session when
// a user reaches ~90% scroll depth. Ratio `scroll / page_view` per URL gives
// the share of views that reach the bottom — a proxy for how much of the
// page most users actually see.
//
// Output:
//   1. Scroll rate (90% depth) per top-30 pages by traffic.
//   2. Highest-scroll-rate pages (where users engage deeply).
//   3. Lowest-scroll-rate pages with significant traffic (where users drop).

import fs from 'node:fs';
import { Ga4Client } from '../dist/connectors/ga4/client.js';
import { Ga4Connector } from '../dist/connectors/ga4/connector.js';

const keyPath = process.env.GA4_KEY_PATH;
const propertyId = process.env.GA4_PROPERTY_ID;
if (!keyPath || !propertyId) { console.error('Set GA4_KEY_PATH and GA4_PROPERTY_ID'); process.exit(2); }

const client = new Ga4Client({ propertyId, serviceAccountKey: fs.readFileSync(keyPath, 'utf8') });
const conn = new Ga4Connector({ client });
const runReport = conn.tools.find((t) => t.name === 'ga4.run_report');

async function run(args) {
  const parsed = runReport.schema.parse(args);
  return runReport.execute(parsed);
}

function printTable(rows, cols, max = 30) {
  const widths = cols.map((c) => Math.max(c.length, ...rows.slice(0, max).map((r) => String(r[c] ?? '').length)));
  console.log(cols.map((c, i) => c.padEnd(widths[i])).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows.slice(0, max)) {
    console.log(cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join('  '));
  }
}

// Pull pagePath × eventName → eventCount, last 30 days, big enough limit to cover everything.
const all = await run({
  dateRange: 'last_30_days',
  dimensions: ['pagePath', 'eventName'],
  metrics: ['eventCount'],
  limit: 100_000,
});
console.log(`pulled ${all.rowCount} (pagePath × eventName) rows`);

// Bucket per page.
const byPage = {};
for (const r of all.rows) {
  if (!byPage[r.pagePath]) byPage[r.pagePath] = { pageViews: 0, scrolls: 0, pv3: 0, pv6: 0 };
  if (r.eventName === 'page_view') byPage[r.pagePath].pageViews += r.eventCount;
  else if (r.eventName === 'scroll') byPage[r.pagePath].scrolls += r.eventCount;
  else if (r.eventName === 'page_view_over3') byPage[r.pagePath].pv3 += r.eventCount;
  else if (r.eventName === 'page_view_over6') byPage[r.pagePath].pv6 += r.eventCount;
}

const rows = Object.entries(byPage).map(([pagePath, m]) => ({
  pagePath,
  pageViews: m.pageViews,
  scrolls: m.scrolls,
  scrollRate: m.pageViews > 0 ? m.scrolls / m.pageViews : 0,
  pv_over3s: m.pv3,
  pv_over6s: m.pv6,
  read3s_rate: m.pageViews > 0 ? m.pv3 / m.pageViews : 0,
}));

// Site totals.
const totalPv = rows.reduce((s, r) => s + r.pageViews, 0);
const totalScroll = rows.reduce((s, r) => s + r.scrolls, 0);
console.log(`\nSITE TOTALS — last 30 days`);
console.log(`  page_view events: ${totalPv.toLocaleString()}`);
console.log(`  scroll events (90% depth): ${totalScroll.toLocaleString()}`);
console.log(`  site-wide scroll-to-bottom rate: ${(100 * totalScroll / totalPv).toFixed(1)}%`);

// 1. Top 30 pages by traffic, with scroll rate.
const byTraffic = [...rows].sort((a, b) => b.pageViews - a.pageViews);
console.log('\n=== TOP 30 PAGES BY TRAFFIC — scroll-to-bottom rate ===');
const fmt = byTraffic.slice(0, 30).map((r) => ({
  pagePath: r.pagePath,
  pageViews: r.pageViews,
  scrolls: r.scrolls,
  scrollRatePct: (100 * r.scrollRate).toFixed(1) + '%',
  read3sRatePct: (100 * r.read3s_rate).toFixed(1) + '%',
}));
printTable(fmt, ['pagePath', 'pageViews', 'scrolls', 'scrollRatePct', 'read3sRatePct']);

// 2. Highest scroll-rate pages with at least 500 page views.
console.log('\n=== TOP 20 PAGES BY SCROLL RATE (min 500 page views) ===');
const highScroll = rows
  .filter((r) => r.pageViews >= 500)
  .sort((a, b) => b.scrollRate - a.scrollRate)
  .slice(0, 20)
  .map((r) => ({
    pagePath: r.pagePath,
    pageViews: r.pageViews,
    scrollRatePct: (100 * r.scrollRate).toFixed(1) + '%',
  }));
printTable(highScroll, ['pagePath', 'pageViews', 'scrollRatePct']);

// 3. Worst scroll-rate pages with significant traffic.
console.log('\n=== BOTTOM 20 PAGES BY SCROLL RATE (min 500 page views) — drop zones ===');
const lowScroll = rows
  .filter((r) => r.pageViews >= 500)
  .sort((a, b) => a.scrollRate - b.scrollRate)
  .slice(0, 20)
  .map((r) => ({
    pagePath: r.pagePath,
    pageViews: r.pageViews,
    scrollRatePct: (100 * r.scrollRate).toFixed(1) + '%',
  }));
printTable(lowScroll, ['pagePath', 'pageViews', 'scrollRatePct']);
