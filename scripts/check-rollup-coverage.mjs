// Check: does Porter have transactions before 2024-05-04 that the rollup is missing?
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { GrafanaConnector } from '../dist/connectors/grafana/grafana-connector.js';

const supabase = getSupabase();
const [grafanaUrl, grafanaToken, grafanaPgUid] = await Promise.all([
  readVaultSecret(supabase, 'GRAFANA_URL'),
  readVaultSecret(supabase, 'GRAFANA_TOKEN'),
  readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
]);
const grafana = new GrafanaConnector({ baseUrl: grafanaUrl, token: grafanaToken, postgresDsUid: grafanaPgUid });

const fromMs = Date.parse('2023-01-01T00:00:00.000Z');
const toMs = Date.parse('2024-06-01T00:00:00.000Z');
const sql = `
SELECT
  MIN(t."createdAt"::date) AS earliest,
  MAX(t."createdAt"::date) AS latest_in_range,
  COUNT(*) AS rows_in_range,
  COUNT(*) FILTER (WHERE t."createdAt" < '2024-05-04') AS rows_before_rollup_start
FROM "Transactions" t
WHERE t."createdAt" >= ($__timeFrom())::timestamp
  AND t."createdAt" <  ($__timeTo())::timestamp
  AND t.status NOT IN ('Cancelled','Lost')
`;
const r = await grafana.runSql({ sql, fromMs, toMs, maxRows: 5 });
console.log('FIELDS:', r.fields);
console.log('ROW:', r.rows[0]);
