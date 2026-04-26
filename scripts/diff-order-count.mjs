// Why does the rollup say 9,656 Orders for 2024-01-01..2026-04-25 when Grafana
// said 9,657? Run the same WHERE clause against Porter (live) and against the
// rollup table to find the offender.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { GrafanaConnector } from '../dist/connectors/grafana/grafana-connector.js';

const supabase = getSupabase();
const [grafanaUrl, grafanaToken, grafanaPgUid] = await Promise.all([
  readVaultSecret(supabase, 'GRAFANA_URL'),
  readVaultSecret(supabase, 'GRAFANA_TOKEN'),
  readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
]);
const grafana = new GrafanaConnector({ baseUrl: grafanaUrl, token: grafanaToken, postgresDsUid: grafanaPgUid });

// PT midnight bounds
const fromMs = Date.parse('2024-01-01T08:00:00.000Z');  // 2024-01-01 00:00 PT (UTC-8 in Jan)
const toMs   = Date.parse('2026-04-26T07:00:00.000Z');  // 2026-04-26 00:00 PT (UTC-7 in Apr DST)

// 1) Live count via Grafana with the EXACT same SQL the rollup uses
const liveSql = `
SELECT COUNT(*)::int AS n
FROM "Transactions" t
WHERE t."createdAt" >= ($__timeFrom())::timestamp
  AND t."createdAt" <  ($__timeTo())::timestamp
  AND t.type = 'Order'
  AND t.status NOT IN ('Cancelled','Lost')
`;
const live = await grafana.runSql({ sql: liveSql, fromMs, toMs, maxRows: 5 });
console.log('LIVE count (same WHERE as rollup):', live.rows[0]);

// 2) Per-day live counts + revenue across multiple definitions
const perDaySql = `
SELECT
  DATE_TRUNC('day', t."createdAt" AT TIME ZONE 'America/Los_Angeles')::date AS day,
  COUNT(*)::int AS n,
  SUM((t.amount->>'total')::numeric) / 100.0 AS rev_total,
  SUM((t.amount->>'subtotal')::numeric + COALESCE((t.amount->>'shipping')::numeric, 0) + COALESCE((t.amount->>'tax')::numeric, 0)) / 100.0 AS rev_full_total,
  SUM(COALESCE((t.amount->>'discount')::numeric, 0)) / 100.0 AS discount_sum,
  SUM(COALESCE((t.amount->>'credit')::numeric, 0)) / 100.0 AS credit_sum,
  SUM(COALESCE((t.amount->>'gift')::numeric, 0)) / 100.0 AS gift_sum
FROM "Transactions" t
WHERE t."createdAt" >= ($__timeFrom())::timestamp
  AND t."createdAt" <  ($__timeTo())::timestamp
  AND t.type = 'Order'
  AND t.status NOT IN ('Cancelled','Lost')
GROUP BY day
ORDER BY day
`;
const perDay = await grafana.runSql({ sql: perDaySql, fromMs, toMs, maxRows: 1000 });
console.log(`days with Order data (live): ${perDay.rows.length}`);

// Pull the rollup's per-day Order count
const { data: rollupRows } = await supabase
  .from('sales_daily_rollup')
  .select('date, by_type')
  .gte('date', '2024-01-01')
  .lte('date', '2026-04-25')
  .order('date', { ascending: true });

const rollupByDay = new Map();
for (const r of rollupRows) {
  const ord = r.by_type?.Order?.orders ?? 0;
  rollupByDay.set(r.date, ord);
}

const liveByDay = new Map();
for (const row of perDay.rows) {
  const day = row[0];
  const ymd = typeof day === 'string' ? day.slice(0, 10) : new Date(day).toISOString().slice(0, 10);
  liveByDay.set(ymd, {
    n: Number(row[1]),
    revTotal: Number(row[2] ?? 0),       // sum of amount.total
    revFullTotal: Number(row[3] ?? 0),   // subtotal + shipping + tax (Grafana's "Full Total")
    discount: Number(row[4] ?? 0),
    credit: Number(row[5] ?? 0),
    gift: Number(row[6] ?? 0),
  });
}

const rollupRevByDay = new Map();
for (const r of rollupRows) {
  const ord = r.by_type?.Order?.revenueCents ?? 0;
  rollupRevByDay.set(r.date, Number(ord) / 100);
}

let liveTotal = 0, rollupTotal = 0;
let liveRevTotal = 0, liveRevFullTotal = 0, rollupRevTotal = 0;
let totalDiscount = 0, totalCredit = 0, totalGift = 0;
for (const v of liveByDay.values()) {
  liveTotal += v.n;
  liveRevTotal += v.revTotal;
  liveRevFullTotal += v.revFullTotal;
  totalDiscount += v.discount;
  totalCredit += v.credit;
  totalGift += v.gift;
}
for (const v of rollupByDay.values()) rollupTotal += v;
for (const v of rollupRevByDay.values()) rollupRevTotal += v;

console.log(`\n--- COUNT diff ---`);
console.log(`live count: ${liveTotal}`);
console.log(`rollup count: ${rollupTotal}`);
console.log(`diff: ${liveTotal - rollupTotal}`);

console.log(`\n--- REVENUE diff ---`);
console.log(`live amount.total sum (only when set): $${liveRevTotal.toFixed(2)}`);
console.log(`live subtotal+ship+tax:                $${liveRevFullTotal.toFixed(2)} (Grafana "Full Total")`);
console.log(`live discount sum:                     $${totalDiscount.toFixed(2)}`);
console.log(`live credit sum:                       $${totalCredit.toFixed(2)}`);
console.log(`live gift sum:                         $${totalGift.toFixed(2)}`);
const fallbackComputed = liveRevFullTotal - totalDiscount - totalCredit - totalGift;
console.log(`subtotal+ship+tax - disc - cred - gift: $${fallbackComputed.toFixed(2)} (rollup fallback formula)`);
console.log(`rollup revenue (table):                $${rollupRevTotal.toFixed(2)}`);
console.log(`fallbackComputed - rollup:             $${(fallbackComputed - rollupRevTotal).toFixed(2)}`);

console.log('\ndays where count or revenue differ (first 5):');
const allDays = new Set([...liveByDay.keys(), ...rollupByDay.keys()]);
let printed = 0;
for (const d of [...allDays].sort()) {
  if (printed >= 5) break;
  const liveData = liveByDay.get(d);
  const roll = rollupByDay.get(d) ?? 0;
  const rollRev = rollupRevByDay.get(d) ?? 0;
  if (liveData && (liveData.n !== roll || Math.abs(liveData.revFullTotal - rollRev) > 0.01)) {
    console.log(`  ${d}: count live=${liveData.n} roll=${roll} | full=$${liveData.revFullTotal.toFixed(2)} roll=$${rollRev.toFixed(2)} | disc=$${liveData.discount} cred=$${liveData.credit} gift=$${liveData.gift}`);
    printed++;
  }
}
