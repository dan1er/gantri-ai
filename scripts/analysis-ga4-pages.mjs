// Ad-hoc analysis: where do people go on the gantri.com site?
// Pulls top pages, top landing pages, top events, and engagement
// breakdowns from GA4 over the last 30 days.

import fs from 'node:fs';
import { Ga4Client } from '../dist/connectors/ga4/client.js';
import { Ga4Connector } from '../dist/connectors/ga4/connector.js';

const keyPath = process.env.GA4_KEY_PATH;
const propertyId = process.env.GA4_PROPERTY_ID;
if (!keyPath || !propertyId) { console.error('Set GA4_KEY_PATH and GA4_PROPERTY_ID'); process.exit(2); }

const client = new Ga4Client({ propertyId, serviceAccountKey: fs.readFileSync(keyPath, 'utf8') });
const conn = new Ga4Connector({ client });
const runReport = conn.tools.find((t) => t.name === 'ga4.run_report');

async function run(args, label) {
  const parsed = runReport.schema.parse(args);
  const t0 = Date.now();
  const r = await runReport.execute(parsed);
  console.log(`\n=== ${label} (${r.rowCount ?? r.rows?.length ?? 0} rows, ${Date.now() - t0}ms) ===`);
  return r;
}

function printTable(rows, cols, max = 20) {
  const widths = cols.map((c) => Math.max(c.length, ...rows.slice(0, max).map((r) => String(r[c] ?? '').length)));
  console.log(cols.map((c, i) => c.padEnd(widths[i])).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows.slice(0, max)) {
    console.log(cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join('  '));
  }
}

// 1. Top pages by total views, last 30d
const topPages = await run({
  dateRange: 'last_30_days',
  dimensions: ['pagePath'],
  metrics: ['screenPageViews', 'totalUsers', 'sessions', 'engagementRate', 'userEngagementDuration'],
  orderBy: { metric: 'screenPageViews', desc: true },
  limit: 30,
}, 'TOP 30 PAGES BY PAGE VIEWS — last 30 days');
printTable(topPages.rows, ['pagePath', 'screenPageViews', 'totalUsers', 'sessions', 'engagementRate', 'userEngagementDuration'], 30);

// 2. Top landing pages by sessions (entry points)
const topLanding = await run({
  dateRange: 'last_30_days',
  dimensions: ['landingPage'],
  metrics: ['sessions', 'totalUsers', 'engagementRate', 'bounceRate'],
  orderBy: { metric: 'sessions', desc: true },
  limit: 20,
}, 'TOP 20 LANDING PAGES BY SESSIONS — last 30 days');
printTable(topLanding.rows, ['landingPage', 'sessions', 'totalUsers', 'engagementRate', 'bounceRate']);

// 3. Top events
const topEvents = await run({
  dateRange: 'last_30_days',
  dimensions: ['eventName'],
  metrics: ['eventCount', 'totalUsers'],
  orderBy: { metric: 'eventCount', desc: true },
  limit: 30,
}, 'TOP 30 EVENTS BY COUNT — last 30 days');
printTable(topEvents.rows, ['eventName', 'eventCount', 'totalUsers'], 30);

// 4. Pages by engagement time (where do people *spend* time?)
const byEngagement = await run({
  dateRange: 'last_30_days',
  dimensions: ['pagePath'],
  metrics: ['userEngagementDuration', 'screenPageViews', 'totalUsers'],
  orderBy: { metric: 'userEngagementDuration', desc: true },
  limit: 20,
}, 'TOP 20 PAGES BY USER ENGAGEMENT TIME (seconds) — last 30 days');
printTable(byEngagement.rows, ['pagePath', 'userEngagementDuration', 'screenPageViews', 'totalUsers']);

// 5. Top pages by add_to_cart event (commercial intent)
const cartPages = await run({
  dateRange: 'last_30_days',
  dimensions: ['pagePath', 'eventName'],
  metrics: ['eventCount', 'totalUsers'],
  orderBy: { metric: 'eventCount', desc: true },
  limit: 200,
}, 'COMMERCIAL EVENTS BY PAGE — last 30 days (filtered client-side)');
const commercialEvents = new Set(['add_to_cart', 'view_item', 'begin_checkout', 'purchase', 'add_to_wishlist', 'select_item']);
const cartFiltered = cartPages.rows.filter((r) => commercialEvents.has(r.eventName));
const byPageEvent = {};
for (const r of cartFiltered) {
  if (!byPageEvent[r.pagePath]) byPageEvent[r.pagePath] = {};
  byPageEvent[r.pagePath][r.eventName] = r.eventCount;
}
const pageRollup = Object.entries(byPageEvent).map(([page, evs]) => ({
  pagePath: page,
  view_item: evs.view_item || 0,
  add_to_cart: evs.add_to_cart || 0,
  begin_checkout: evs.begin_checkout || 0,
  add_to_wishlist: evs.add_to_wishlist || 0,
})).sort((a, b) => b.add_to_cart - a.add_to_cart).slice(0, 20);
console.log('\n--- Top 20 pages by add_to_cart events ---');
printTable(pageRollup, ['pagePath', 'view_item', 'add_to_cart', 'begin_checkout', 'add_to_wishlist']);

// 6. Totals (so we can quote percentages)
const totals = await run({
  dateRange: 'last_30_days',
  metrics: ['screenPageViews', 'sessions', 'totalUsers', 'newUsers', 'eventCount', 'engagementRate', 'bounceRate'],
}, 'TOTALS — last 30 days');
console.log(JSON.stringify(totals.rows[0], null, 2));
