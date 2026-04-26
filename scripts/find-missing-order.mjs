// Find the single Order transaction that exists in one source but not the
// other. Goes day-by-day, narrows to the offending day, then dumps the
// individual order ids on each side to find the missing one.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { GrafanaConnector } from '../dist/connectors/grafana/grafana-connector.js';

const supabase = getSupabase();
const [grafanaUrl, grafanaToken, grafanaPgUid] = await Promise.all([
  readVaultSecret(supabase, 'GRAFANA_URL'),
  readVaultSecret(supabase, 'GRAFANA_TOKEN'),
  readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
]);
const grafana = new GrafanaConnector({ baseUrl: grafanaUrl, token: grafanaToken, postgresDsUid: grafanaPgUid });

const startDate = '2024-01-01';
const endDate = '2026-04-23';
// PT midnight bounds (DST-aware approximate)
const fromMs = Date.parse(startDate + 'T08:00:00.000Z'); // 2024-01-01 PT
const toMs   = Date.parse('2026-04-24T07:00:00.000Z');   // 2026-04-24 00:00 PT exclusive

// Per-day counts via Grafana with the same WHERE the rollup uses
const perDaySql = `
SELECT
  DATE_TRUNC('day', t."createdAt" AT TIME ZONE 'America/Los_Angeles')::date AS day,
  COUNT(*)::int AS n
FROM "Transactions" t
WHERE t."createdAt" >= ($__timeFrom())::timestamp
  AND t."createdAt" <  ($__timeTo())::timestamp
  AND t.type = 'Order'
  AND t.status NOT IN ('Cancelled','Lost')
GROUP BY day
ORDER BY day
`;
const perDay = await grafana.runSql({ sql: perDaySql, fromMs, toMs, maxRows: 1500 });
const liveByDay = new Map();
for (const row of perDay.rows) {
  const day = row[0];
  const ymd = typeof day === 'string' ? day.slice(0, 10) : new Date(day).toISOString().slice(0, 10);
  liveByDay.set(ymd, Number(row[1]));
}

const { data: rollupRows, error } = await supabase
  .from('sales_daily_rollup')
  .select('date, by_type')
  .gte('date', startDate)
  .lte('date', endDate)
  .order('date', { ascending: true });
if (error) throw error;
const rollupByDay = new Map();
for (const r of rollupRows) {
  const ord = r.by_type?.Order?.orders ?? 0;
  rollupByDay.set(r.date, ord);
}

let liveTotal = 0, rollupTotal = 0;
for (const v of liveByDay.values()) liveTotal += v;
for (const v of rollupByDay.values()) rollupTotal += v;
console.log(`live: ${liveTotal} | rollup: ${rollupTotal} | diff: ${liveTotal - rollupTotal}`);

// Find the day(s) with the count discrepancy
const allDays = new Set([...liveByDay.keys(), ...rollupByDay.keys()]);
const offendingDays = [];
for (const d of [...allDays].sort()) {
  const live = liveByDay.get(d) ?? 0;
  const roll = rollupByDay.get(d) ?? 0;
  if (live !== roll) {
    offendingDays.push({ day: d, live, roll });
    console.log(`offending day: ${d} live=${live} rollup=${roll}`);
  }
}

if (offendingDays.length === 0) {
  console.log('No per-day diffs found — counts match per-day. The aggregate diff might come from rollup days outside the queried range or a filter.');
  process.exit(0);
}

// For each offending day, list the actual order ids live and compare
for (const { day } of offendingDays) {
  const idsSql = `
    SELECT t.id, t.type, t.status, t."createdAt", t."customerName"
    FROM "Transactions" t
    WHERE t."createdAt" >= ($__timeFrom())::timestamp
      AND t."createdAt" <  ($__timeTo())::timestamp
      AND DATE_TRUNC('day', t."createdAt" AT TIME ZONE 'America/Los_Angeles')::date = '${day}'
      AND t.type = 'Order'
      AND t.status NOT IN ('Cancelled','Lost')
    ORDER BY t.id
  `;
  // Use a wide window to be safe
  const dayFrom = Date.parse(day + 'T00:00:00.000Z') - 86400000;
  const dayTo = Date.parse(day + 'T00:00:00.000Z') + 2 * 86400000;
  const ids = await grafana.runSql({ sql: idsSql, fromMs: dayFrom, toMs: dayTo, maxRows: 200 });
  console.log(`\n=== Live orders on ${day} (${ids.rows.length}): ===`);
  for (const row of ids.rows) {
    const obj = {};
    ids.fields.forEach((f, i) => { obj[f] = row[i]; });
    console.log(`  id=${obj.id} type=${obj.type} status=${obj.status} created=${new Date(obj.createdAt).toISOString()} customer=${obj.customerName}`);
  }
}
