import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { GrafanaConnector } from '../dist/connectors/grafana/grafana-connector.js';

const supabase = getSupabase();
const [grafanaUrl, grafanaToken, grafanaPgUid] = await Promise.all([
  readVaultSecret(supabase, 'GRAFANA_URL'),
  readVaultSecret(supabase, 'GRAFANA_TOKEN'),
  readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
]);
const grafana = new GrafanaConnector({ baseUrl: grafanaUrl, token: grafanaToken, postgresDsUid: grafanaPgUid });
const r = await grafana.runSql({
  sql: `SELECT t.id, t.type, t.status, t."createdAt", t."customerName", t."organizationId",
               (t.amount->>'subtotal')::numeric/100.0 AS subtotal,
               (t.amount->>'total')::numeric/100.0 AS total
        FROM "Transactions" t
        WHERE t.type = 'Order' AND t.status = 'Lost'
          AND t."createdAt" >= ($__timeFrom())::timestamp
          AND t."createdAt" <  ($__timeTo())::timestamp`,
  fromMs: Date.parse('2024-01-01T08:00:00Z'),
  toMs:   Date.parse('2026-04-24T07:00:00Z'),
  maxRows: 5,
});
console.log('FIELDS:', r.fields);
for (const row of r.rows) {
  const obj = {};
  r.fields.forEach((f, i) => { obj[f] = row[i]; });
  console.log(JSON.stringify(obj, null, 2));
}
