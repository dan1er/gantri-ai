import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { GrafanaConnector } from '../dist/connectors/grafana/grafana-connector.js';

const supabase = getSupabase();
const [grafanaUrl, grafanaToken, grafanaPgUid] = await Promise.all([
  readVaultSecret(supabase, 'GRAFANA_URL'),
  readVaultSecret(supabase, 'GRAFANA_TOKEN'),
  readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
]);
const grafana = new GrafanaConnector({ baseUrl: grafanaUrl, token: grafanaToken, postgresDsUid: grafanaPgUid });

const fromMs = Date.parse('2024-01-01T00:00:00.000Z');
const toMs = Date.parse('2026-12-31T00:00:00.000Z');

const sql = `
SELECT type, COUNT(*) AS n
FROM "Transactions"
WHERE "createdAt" >= ($__timeFrom())::timestamp
  AND "createdAt" <  ($__timeTo())::timestamp
GROUP BY type
ORDER BY n DESC
`;
const r = await grafana.runSql({ sql, fromMs, toMs, maxRows: 50 });
console.log('FIELDS:', r.fields);
for (const row of r.rows) console.log(row);
