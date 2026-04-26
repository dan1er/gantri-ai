// Replicate Grafana Sales panel formula exactly for Trade type, verify match.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { GrafanaConnector } from '../dist/connectors/grafana/grafana-connector.js';

const supabase = getSupabase();
const [grafanaUrl, grafanaToken, grafanaPgUid] = await Promise.all([
  readVaultSecret(supabase, 'GRAFANA_URL'),
  readVaultSecret(supabase, 'GRAFANA_TOKEN'),
  readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
]);
const grafana = new GrafanaConnector({ baseUrl: grafanaUrl, token: grafanaToken, postgresDsUid: grafanaPgUid });

const fromMs = Date.parse('2024-01-01T08:00:00.000Z');
const toMs   = Date.parse('2026-04-24T07:00:00.000Z');

// Replicate Grafana's exact non-refund-type SQL for Trade
const sql = `
WITH t_inner AS (
  SELECT
    t.id, t.status, t."createdAt", t.type,
    SUM(COALESCE(sa.subtotal, 0)) + SUM(COALESCE(gc.subtotal, 0)) AS subtotal,
    SUM(COALESCE(sa.tax, 0)) AS tax,
    SUM(COALESCE(sa.shipping, 0)) AS "shippingAmount",
    SUM(COALESCE(sa.discount, 0)) AS discount,
    COALESCE(t.amount->>'credit', '0')::decimal AS credit
  FROM "Transactions" t
  LEFT JOIN (
    SELECT sa."orderId",
      SUM(COALESCE((sa.amount->>'subtotal')::decimal, 0)) AS subtotal,
      SUM(COALESCE((sa.amount->>'tax')::decimal, 0)) AS tax,
      SUM(COALESCE((sa.amount->>'shipping')::decimal, 0)) AS shipping,
      SUM(COALESCE((sa.amount->>'discount')::decimal, 0)) AS discount
    FROM "StockAssociations" sa GROUP BY sa."orderId"
  ) sa ON t.id = sa."orderId"
  LEFT JOIN (
    SELECT gc."orderId", SUM(gc.amount) AS subtotal
    FROM "GiftCards" gc GROUP BY gc."orderId"
  ) gc ON t.id = gc."orderId"
  GROUP BY t.id, t.type, t.status, t."createdAt"
)
SELECT
  type,
  COUNT(*) AS orders,
  SUM(subtotal)/100.0 AS sub,
  SUM("shippingAmount")/100.0 AS ship,
  SUM(tax)/100.0 AS tax,
  SUM(discount)/100.0 AS disc,
  (SUM(subtotal) + SUM("shippingAmount") + SUM(tax) - SUM(discount))/100.0 AS full_total
FROM t_inner
WHERE status NOT IN ('Unpaid', 'Cancelled')
  AND type NOT IN ('Refund', 'Third Party Refund', 'Made Refund', 'Trade Refund', 'Wholesale Refund')
  AND "createdAt" BETWEEN $__timeFrom() AND $__timeTo()
GROUP BY type
ORDER BY full_total DESC;
`;
const r = await grafana.runSql({ sql, fromMs, toMs, maxRows: 50 });
console.log('FIELDS:', r.fields);
for (const row of r.rows) {
  const obj = {};
  r.fields.forEach((f, i) => { obj[f] = row[i]; });
  console.log(JSON.stringify(obj));
}
