import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { GrafanaConnector } from '../dist/connectors/grafana/grafana-connector.js';

const supabase = getSupabase();
const [grafanaUrl, grafanaToken, grafanaPgUid] = await Promise.all([
  readVaultSecret(supabase, 'GRAFANA_URL'),
  readVaultSecret(supabase, 'GRAFANA_TOKEN'),
  readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
]);

const grafana = new GrafanaConnector({ baseUrl: grafanaUrl, token: grafanaToken, postgresDsUid: grafanaPgUid });

const fromMs = Date.parse('2026-04-20T07:00:00.000Z');
const toMs = Date.parse('2026-04-21T07:00:00.000Z');

// 1) Per-row inspection of wholesale transactions on Apr 20 PT
const sql = `
SELECT
  t.id, t.type, t.status,
  (t.amount->>'subtotal')::numeric / 100.0 AS subtotal_dollars,
  (t.amount->>'shipping')::numeric / 100.0 AS shipping_dollars,
  (t.amount->>'tax')::numeric / 100.0 AS tax_dollars,
  (t.amount->>'discount')::numeric / 100.0 AS discount_dollars,
  (t.amount->>'discounts')::numeric / 100.0 AS discounts_dollars,
  (t.amount->>'total')::numeric / 100.0 AS total_dollars,
  COALESCE((t.amount->>'total')::numeric,
    (t.amount->>'subtotal')::numeric
    + COALESCE((t.amount->>'shipping')::numeric, 0)
    + COALESCE((t.amount->>'tax')::numeric, 0))::numeric / 100.0 AS rollup_revenue_dollars,
  t.amount AS amount_jsonb
FROM "Transactions" t
WHERE t."createdAt" >= ($__timeFrom())::timestamp
  AND t."createdAt" <  ($__timeTo())::timestamp
  AND t.type = 'Wholesale'
  AND t.status NOT IN ('Cancelled','Lost')
ORDER BY t."createdAt"
`;

const result = await grafana.runSql({ sql, fromMs, toMs, maxRows: 50 });
console.log('FIELDS:', result.fields);
console.log('ROWS:');
for (const row of result.rows) {
  const obj = {};
  result.fields.forEach((f, i) => { obj[f] = row[i]; });
  console.log(JSON.stringify(obj, null, 2));
}

// 2) Sum check using the same formula as the rollup
const sumSql = `
SELECT
  COUNT(*)::int AS n,
  SUM(COALESCE((t.amount->>'total')::numeric,
        (t.amount->>'subtotal')::numeric
        + COALESCE((t.amount->>'shipping')::numeric, 0)
        + COALESCE((t.amount->>'tax')::numeric, 0))) / 100.0 AS rollup_total_dollars,
  SUM((t.amount->>'subtotal')::numeric) / 100.0 AS subtotal_sum_dollars,
  SUM(COALESCE((t.amount->>'total')::numeric, 0)) / 100.0 AS total_sum_dollars,
  SUM(COALESCE((t.amount->>'discount')::numeric, 0)) / 100.0 AS discount_sum_dollars
FROM "Transactions" t
WHERE t."createdAt" >= ($__timeFrom())::timestamp
  AND t."createdAt" <  ($__timeTo())::timestamp
  AND t.type = 'Wholesale'
  AND t.status NOT IN ('Cancelled','Lost')
`;
const sumResult = await grafana.runSql({ sql: sumSql, fromMs, toMs, maxRows: 5 });
console.log('---SUMS---');
console.log('FIELDS:', sumResult.fields);
console.log('ROWS:', sumResult.rows);
