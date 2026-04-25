// Verify the daily rollup against a fresh Grafana SQL run, day by day, for the
// last 720 days. Both sides apply the same formula — if any day differs, it's
// either a stale rollup row or a data race.
//
// Reports total mismatches, per-day diffs ≥ 1¢, and summary stats.

import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { GrafanaConnector } from '../dist/connectors/grafana/grafana-connector.js';

const supabase = getSupabase();
const [grafanaUrl, grafanaToken, grafanaPgUid] = await Promise.all([
  readVaultSecret(supabase, 'GRAFANA_URL'),
  readVaultSecret(supabase, 'GRAFANA_TOKEN'),
  readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
]);
const grafana = new GrafanaConnector({ baseUrl: grafanaUrl, token: grafanaToken, postgresDsUid: grafanaPgUid });

const PT_TZ = 'America/Los_Angeles';
const days = Number(process.argv[2] || 720);

// 1) Pull the rollup table (last `days` rows)
const { data: rollupRows, error } = await supabase
  .from('sales_daily_rollup')
  .select('date,total_orders,total_revenue_cents,by_type')
  .gte('date', new Date(Date.now() - (days + 5) * 86400000).toISOString().slice(0, 10))
  .order('date', { ascending: true });
if (error) throw error;
const rollup = new Map();
for (const r of rollupRows) rollup.set(r.date, r);
console.log(`rollup rows: ${rollup.size}`);

// 2) Run the same SQL against Grafana for the whole window in one shot.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: PT_TZ, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
const fromDay = new Date(today + 'T00:00:00');
fromDay.setDate(fromDay.getDate() - days);
const fromYmd = fromDay.toISOString().slice(0, 10);
const toYmd = today;

// Wall-clock midnight PT → UTC ms (PT is UTC-7 during DST). Approximate is fine
// for a window query — Grafana respects $__timeFrom/$__timeTo as bounds, the SQL
// trims to PT days inside the WHERE.
const fromMs = Date.parse(`${fromYmd}T07:00:00.000Z`);
const toMs = Date.parse(`${toYmd}T08:00:00.000Z`); // small headroom for DST

const SQL = `
SELECT
  DATE_TRUNC('day', t."createdAt" AT TIME ZONE 'America/Los_Angeles')::date AS day,
  COUNT(*)::int AS n,
  SUM(
    (CASE WHEN t.type LIKE '%Refund' THEN -1 ELSE 1 END) *
    COALESCE((t.amount->>'total')::numeric,
             (t.amount->>'subtotal')::numeric
             + COALESCE((t.amount->>'shipping')::numeric, 0)
             + COALESCE((t.amount->>'tax')::numeric, 0)
             - COALESCE((t.amount->>'discount')::numeric, 0)
             - COALESCE((t.amount->>'credit')::numeric, 0)
             - COALESCE((t.amount->>'gift')::numeric, 0))
  )::bigint AS revenue_cents
FROM "Transactions" t
WHERE t."createdAt" >= ($__timeFrom())::timestamp
  AND t."createdAt" <  ($__timeTo())::timestamp
  AND t.status NOT IN ('Cancelled','Lost')
GROUP BY day
ORDER BY day
`;

const result = await grafana.runSql({ sql: SQL, fromMs, toMs, maxRows: days + 10 });
console.log(`grafana rows: ${result.rows.length}`);

// 3) Compare every day in the rollup to the matching grafana day.
const grafanaByDay = new Map();
for (const row of result.rows) {
  const obj = {};
  result.fields.forEach((f, i) => { obj[f] = row[i]; });
  // Postgres DATE comes through as ms-epoch UTC midnight or string — handle both.
  let day;
  if (typeof obj.day === 'string') day = obj.day.slice(0, 10);
  else if (typeof obj.day === 'number') day = new Date(obj.day).toISOString().slice(0, 10);
  else continue;
  grafanaByDay.set(day, { n: Number(obj.n), revenue_cents: Number(obj.revenue_cents) });
}

const mismatches = [];
const onlyRollup = [];
const onlyGrafana = [];
for (const [date, r] of rollup) {
  const g = grafanaByDay.get(date);
  if (!g) { onlyRollup.push(date); continue; }
  const dRev = Number(r.total_revenue_cents) - g.revenue_cents;
  const dN = Number(r.total_orders) - g.n;
  if (Math.abs(dRev) > 0 || dN !== 0) {
    mismatches.push({ date, rollup_orders: r.total_orders, grafana_orders: g.n, dN, rollup_cents: r.total_revenue_cents, grafana_cents: g.revenue_cents, dRev });
  }
}
for (const [date] of grafanaByDay) {
  if (!rollup.has(date)) onlyGrafana.push(date);
}

console.log(`---`);
console.log(`days compared: ${rollup.size}`);
console.log(`mismatches:    ${mismatches.length}`);
console.log(`only in rollup (no grafana row, prob zero-row days): ${onlyRollup.length}`);
console.log(`only in grafana (rollup missing this day): ${onlyGrafana.length}`);
if (mismatches.length > 0) {
  console.log('---first 20 mismatches:');
  for (const m of mismatches.slice(0, 20)) console.log(JSON.stringify(m));
}
if (onlyGrafana.length > 0) {
  console.log('---only in grafana (first 20):');
  console.log(onlyGrafana.slice(0, 20));
}
