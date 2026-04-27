// Pulls NB /v2/orders for Jan 1 → today and prints per-PT-day counts
// (excluding cancelled/deleted, matching the bot's tool semantics).
// This is the ground-truth check for "NB stopped ingesting Mar 26".

import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { NorthbeamApiClient } from '../dist/connectors/northbeam-api/client.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);
const nb = new NorthbeamApiClient({ apiKey, dataClientId });

const startDate = '2026-01-01';
const endDate = '2026-04-26';

console.log(`Fetching NB orders ${startDate} → ${endDate}…`);
const t0 = Date.now();
const orders = await nb.listOrders({ startDate, endDate });
console.log(`got ${orders.length} rows in ${Date.now() - t0}ms`);

const byDay = new Map();
let totalRev = 0;
let nonCancelled = 0;
for (const o of orders) {
  if (o.is_cancelled || o.is_deleted) continue;
  nonCancelled++;
  const t = o.time_of_purchase;
  if (typeof t !== 'string') continue;
  const ptDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(t));
  const bucket = byDay.get(ptDay) ?? { count: 0, revenue: 0 };
  bucket.count++;
  bucket.revenue += Number(o.purchase_total ?? 0);
  totalRev += Number(o.purchase_total ?? 0);
  byDay.set(ptDay, bucket);
}

console.log(`\nTotals (excluding cancelled/deleted):`);
console.log(`  orders: ${nonCancelled}`);
console.log(`  revenue: $${totalRev.toFixed(2)}`);
console.log(`  unique PT days: ${byDay.size}`);

const days = [...byDay.keys()].sort();
console.log(`\nFirst day: ${days[0]}`);
console.log(`Last day: ${days[days.length - 1]}`);

// Show daily breakdown
console.log(`\nDaily counts (only non-zero days printed):`);
for (const d of days) {
  const b = byDay.get(d);
  console.log(`  ${d}: ${String(b.count).padStart(3)} orders · $${b.revenue.toFixed(0)}`);
}

// Specifically show the user's claim window
console.log(`\n=== CHECK: did NB stop after Mar 26? ===`);
const afterMar26 = days.filter((d) => d > '2026-03-26');
console.log(`Days with orders AFTER 2026-03-26: ${afterMar26.length}`);
if (afterMar26.length > 0) {
  console.log(`First post-Mar-26 day: ${afterMar26[0]}`);
  console.log(`Last day with orders: ${afterMar26[afterMar26.length - 1]}`);
  let postCount = 0, postRev = 0;
  for (const d of afterMar26) { postCount += byDay.get(d).count; postRev += byDay.get(d).revenue; }
  console.log(`Total orders Mar 27 → today: ${postCount}, revenue $${postRev.toFixed(2)}`);
}
