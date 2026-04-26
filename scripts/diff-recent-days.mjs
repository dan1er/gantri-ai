import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { GrafanaConnector } from '../dist/connectors/grafana/grafana-connector.js';

const supabase = getSupabase();
const [apiKey, dataClientId, grafanaUrl, grafanaToken, grafanaPgUid] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
  readVaultSecret(supabase, 'GRAFANA_URL'),
  readVaultSecret(supabase, 'GRAFANA_TOKEN'),
  readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
]);
const grafana = new GrafanaConnector({ baseUrl: grafanaUrl, token: grafanaToken, postgresDsUid: grafanaPgUid });

async function nbOrders(startDate, endDateExclusive) {
  const r = await fetch(`https://api.northbeam.io/v2/orders?start_date=${startDate}&end_date=${endDateExclusive}`, {
    headers: { Authorization: apiKey, 'Data-Client-ID': dataClientId },
  });
  let body = JSON.parse(await r.text());
  if (typeof body === 'string') body = JSON.parse(body);
  return body.filter((o) => !o.is_cancelled && !o.is_deleted);
}

// Pull Apr 24, 25, 26 (3 day window) from NB
const nb = await nbOrders('2026-04-24', '2026-04-27');
console.log(`NB returned ${nb.length} orders for 2026-04-24 to 2026-04-26 (inclusive)`);

// Bucket by PT day
const ptDay = (iso) => {
  const ms = Date.parse(iso);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(ms));
};
const byDay = new Map();
for (const o of nb) {
  const day = ptDay(o.time_of_purchase);
  byDay.set(day, [...(byDay.get(day) ?? []), o]);
}
console.log('\nNB orders bucketed by PT day:');
for (const [day, orders] of [...byDay.entries()].sort()) {
  console.log(`  ${day}: ${orders.length} orders`);
  for (const o of orders) console.log(`    id=${o.order_id} time=${o.time_of_purchase} customer=${o.customer_name} total=$${o.purchase_total}`);
}

// Now Grafana type=Order for the same days, bucketed by createdAt PT
console.log('\n--- Grafana type=Order, status NOT IN (Unpaid, Cancelled), PT-bucketed ---');
const gsql = `
SELECT t.id, t.type, t.status, t."createdAt",
       DATE_TRUNC('day', t."createdAt" AT TIME ZONE 'America/Los_Angeles')::date AS pt_day,
       (t.amount->>'total')::numeric/100.0 AS total_dollars
FROM "Transactions" t
WHERE t."createdAt" >= '2026-04-24 07:00:00'::timestamp
  AND t."createdAt" <  '2026-04-27 07:00:00'::timestamp
  AND t.type = 'Order'
  AND t.status NOT IN ('Unpaid','Cancelled')
ORDER BY t.id`;
const gr = await grafana.runSql({
  sql: gsql,
  fromMs: Date.parse('2026-04-24T00:00:00Z'),
  toMs: Date.parse('2026-04-28T00:00:00Z'),
  maxRows: 200,
});
const grafByDay = new Map();
for (const row of gr.rows) {
  const obj = {};
  gr.fields.forEach((f, i) => { obj[f] = row[i]; });
  const day = typeof obj.pt_day === 'string' ? obj.pt_day.slice(0, 10) : new Date(obj.pt_day).toISOString().slice(0, 10);
  grafByDay.set(day, [...(grafByDay.get(day) ?? []), obj]);
}
for (const [day, orders] of [...grafByDay.entries()].sort()) {
  console.log(`  ${day}: ${orders.length} orders`);
  for (const o of orders) console.log(`    id=${o.id} status=${o.status} created=${new Date(o.createdAt).toISOString()} total=$${o.total_dollars}`);
}

// Diff: which order IDs are in NB but not Grafana, and vice versa, per day
console.log('\n--- Diff per PT day ---');
const allDays = new Set([...byDay.keys(), ...grafByDay.keys()]);
for (const day of [...allDays].sort()) {
  const nbIds = new Set((byDay.get(day) ?? []).map((o) => String(o.order_id)));
  const grafIds = new Set((grafByDay.get(day) ?? []).map((o) => String(o.id)));
  const onlyNb = [...nbIds].filter((id) => !grafIds.has(id));
  const onlyGraf = [...grafIds].filter((id) => !nbIds.has(id));
  console.log(`  ${day}: NB=${nbIds.size}, Grafana=${grafIds.size}`);
  if (onlyNb.length) console.log(`    only in NB: ${onlyNb.join(', ')}`);
  if (onlyGraf.length) console.log(`    only in Grafana: ${onlyGraf.join(', ')}`);
}
