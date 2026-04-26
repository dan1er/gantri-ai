// Compare NB vs Grafana per-PT-day for Apr 13-26 using the FIXED PT-bucketing
// listOrders. This should produce ~0 diff per day except for very recent
// ingestion lag.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { NorthbeamApiClient } from '../dist/connectors/northbeam-api/client.js';
import { GrafanaConnector } from '../dist/connectors/grafana/grafana-connector.js';

const supabase = getSupabase();
const [apiKey, dataClientId, grafanaUrl, grafanaToken, grafanaPgUid] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
  readVaultSecret(supabase, 'GRAFANA_URL'),
  readVaultSecret(supabase, 'GRAFANA_TOKEN'),
  readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
]);

const client = new NorthbeamApiClient({ apiKey, dataClientId });
const grafana = new GrafanaConnector({ baseUrl: grafanaUrl, token: grafanaToken, postgresDsUid: grafanaPgUid });

// Pull NB once for the whole window (cheaper)
const nb = await client.listOrders({ startDate: '2026-04-13', endDate: '2026-04-26' });
const ptDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone:'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(Date.parse(iso)));
const nbByDay = new Map();
for (const o of nb) {
  const day = ptDay(o.time_of_purchase);
  const e = nbByDay.get(day) ?? { count: 0, rev: 0 };
  e.count++;
  e.rev += Number(o.purchase_total ?? 0);
  nbByDay.set(day, e);
}

const sql = `
SELECT DATE_TRUNC('day', t."createdAt" AT TIME ZONE 'America/Los_Angeles')::date AS day,
       COUNT(*)::int AS n,
       SUM((t.amount->>'total')::numeric)/100.0 AS rev
FROM "Transactions" t
WHERE t."createdAt" >= '2026-04-13 07:00:00'::timestamp
  AND t."createdAt" <  '2026-04-27 07:00:00'::timestamp
  AND t.type = 'Order'
  AND t.status NOT IN ('Unpaid','Cancelled')
GROUP BY day ORDER BY day`;
const gr = await grafana.runSql({ sql, fromMs: Date.parse('2026-04-13T00:00:00Z'), toMs: Date.parse('2026-04-28T00:00:00Z'), maxRows: 50 });
const grafByDay = new Map();
for (const row of gr.rows) {
  const obj = {};
  gr.fields.forEach((f, i) => { obj[f] = row[i]; });
  const day = typeof obj.day === 'string' ? obj.day.slice(0,10) : new Date(obj.day).toISOString().slice(0,10);
  grafByDay.set(day, { count: Number(obj.n), rev: Number(obj.rev ?? 0) });
}

console.log('Day        NB#  G#   diff#   NB$         G$          diff$');
const days = [];
for (let d = new Date(Date.UTC(2026, 3, 13)); d <= new Date(Date.UTC(2026, 3, 26)); d.setUTCDate(d.getUTCDate()+1)) days.push(d.toISOString().slice(0,10));
for (const day of days) {
  const n = nbByDay.get(day) ?? { count:0, rev:0 };
  const g = grafByDay.get(day) ?? { count:0, rev:0 };
  const dC = n.count - g.count;
  const dR = n.rev - g.rev;
  const flag = (dC === 0 && Math.abs(dR) < 1) ? '✅' : '⚠️';
  console.log(`${day}  ${String(n.count).padStart(3)} ${String(g.count).padStart(3)}  ${(dC>=0?'+':'')+dC}   $${n.rev.toFixed(2).padStart(10)}  $${g.rev.toFixed(2).padStart(10)}  ${(dR>=0?'+':'')+dR.toFixed(2)} ${flag}`);
}
