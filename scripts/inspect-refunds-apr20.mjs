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

const sql = `
SELECT
  t.id, t.type, t.status,
  (t.amount->>'subtotal')::numeric / 100.0 AS subtotal_d,
  (t.amount->>'shipping')::numeric / 100.0 AS shipping_d,
  (t.amount->>'tax')::numeric / 100.0 AS tax_d,
  (t.amount->>'discount')::numeric / 100.0 AS discount_d,
  (t.amount->>'total')::numeric / 100.0 AS total_d,
  t.amount AS amount_jsonb
FROM "Transactions" t
WHERE t."createdAt" >= ($__timeFrom())::timestamp
  AND t."createdAt" <  ($__timeTo())::timestamp
  AND t.type IN ('Refund','Wholesale Refund')
  AND t.status NOT IN ('Cancelled','Lost')
ORDER BY t.type, t.id
`;

const result = await grafana.runSql({ sql, fromMs, toMs, maxRows: 50 });
console.log('FIELDS:', result.fields);
for (const row of result.rows) {
  const obj = {};
  result.fields.forEach((f, i) => { obj[f] = row[i]; });
  console.log(JSON.stringify(obj, null, 2));
}

// Day total per Grafana's perspective: try multiple plausible formulas
const formulas = [
  { name: 'rollup_current (subtract disc/credit/gift in fallback, all types positive)',
    sql: `
      COALESCE((t.amount->>'total')::numeric,
        (t.amount->>'subtotal')::numeric
        + COALESCE((t.amount->>'shipping')::numeric, 0)
        + COALESCE((t.amount->>'tax')::numeric, 0)
        - COALESCE((t.amount->>'discount')::numeric, 0)
        - COALESCE((t.amount->>'credit')::numeric, 0)
        - COALESCE((t.amount->>'gift')::numeric, 0))
    `,
  },
  { name: 'net (refund types negated)',
    sql: `
      CASE WHEN t.type IN ('Refund','Wholesale Refund','Trade Refund') THEN -1 ELSE 1 END *
      COALESCE((t.amount->>'total')::numeric,
        (t.amount->>'subtotal')::numeric
        + COALESCE((t.amount->>'shipping')::numeric, 0)
        + COALESCE((t.amount->>'tax')::numeric, 0)
        - COALESCE((t.amount->>'discount')::numeric, 0)
        - COALESCE((t.amount->>'credit')::numeric, 0)
        - COALESCE((t.amount->>'gift')::numeric, 0))
    `,
  },
];

for (const f of formulas) {
  const dayTotalSql = `
    SELECT COUNT(*)::int AS n,
           SUM(${f.sql}) / 100.0 AS day_dollars
    FROM "Transactions" t
    WHERE t."createdAt" >= ($__timeFrom())::timestamp
      AND t."createdAt" <  ($__timeTo())::timestamp
      AND t.status NOT IN ('Cancelled','Lost')
  `;
  const r = await grafana.runSql({ sql: dayTotalSql, fromMs, toMs, maxRows: 5 });
  console.log('---', f.name, '---');
  console.log(r.rows);
}
