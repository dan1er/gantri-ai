// Run Grafana's exact Sales panel formula against Porter live, then compare
// per-type totals against the rollup table. Print ANY diff > 1¢.
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

// Grafana's full panel SQL — non-refund + refund UNION
const sql = `
WITH non_refund AS (
  SELECT t.type AS type,
    SUM(COALESCE((sa.amount->>'subtotal')::decimal, 0))
      + COALESCE(SUM((gc.amount)::decimal), 0)
      + SUM(COALESCE((sa.amount->>'shipping')::decimal, 0))
      + SUM(COALESCE((sa.amount->>'tax')::decimal, 0))
      - SUM(COALESCE((sa.amount->>'discount')::decimal, 0)) AS rev,
    COUNT(DISTINCT t.id) AS orders
  FROM "Transactions" t
  LEFT JOIN "StockAssociations" sa ON sa."orderId" = t.id
  LEFT JOIN "GiftCards" gc ON gc."orderId" = t.id
  WHERE t."createdAt" BETWEEN $__timeFrom() AND $__timeTo()
    AND t.status NOT IN ('Unpaid','Cancelled')
    AND t.type NOT IN ('Refund','Third Party Refund','Made Refund','Trade Refund','Wholesale Refund')
  GROUP BY t.type
),
refund AS (
  SELECT t.type AS type,
    -1 * (
      SUM(COALESCE((sa.amount->>'subtotal')::decimal, 0))
      + COALESCE(SUM((gc.amount)::decimal), 0)
      + SUM(COALESCE((sa.amount->>'shipping')::decimal, 0))
      + SUM(COALESCE((sa.amount->>'tax')::decimal, 0))
      - SUM(COALESCE((sa.amount->>'discount')::decimal, 0))
    ) AS rev,
    COUNT(DISTINCT t.id) AS orders
  FROM "Transactions" t
  LEFT JOIN "StockAssociations" sa ON sa."orderId" = t.id
  LEFT JOIN "GiftCards" gc ON gc."orderId" = t.id
  WHERE t."completedAt" BETWEEN $__timeFrom() AND $__timeTo()
    AND t.status IN ('Refunded','Delivered')
    AND t.type IN ('Refund','Third Party Refund','Made Refund','Trade Refund','Wholesale Refund')
  GROUP BY t.type
)
SELECT type, SUM(rev)/100.0 AS rev, SUM(orders) AS orders
FROM (SELECT * FROM non_refund UNION ALL SELECT * FROM refund) x
GROUP BY type ORDER BY rev DESC NULLS LAST;
`;
const r = await grafana.runSql({ sql, fromMs, toMs, maxRows: 50 });
const live = new Map();
for (const row of r.rows) {
  const obj = {};
  r.fields.forEach((f, i) => { obj[f] = row[i]; });
  live.set(obj.type, { rev: Number(obj.rev), orders: Number(obj.orders) });
}

// Pull rollup table for the same range
const { data: rollupRows } = await supabase
  .from('sales_daily_rollup')
  .select('by_type')
  .gte('date', '2024-01-01')
  .lte('date', '2026-04-23');

const rollup = new Map();
for (const row of rollupRows) {
  for (const [type, agg] of Object.entries(row.by_type ?? {})) {
    const e = rollup.get(type) ?? { rev: 0, orders: 0 };
    e.rev += (agg.revenueCents ?? 0) / 100;
    e.orders += agg.orders ?? 0;
    rollup.set(type, e);
  }
}

const types = [...new Set([...live.keys(), ...rollup.keys()])].sort();
console.log('Type'.padEnd(22) + 'Live $'.padStart(15) + 'Rollup $'.padStart(15) + 'Diff $'.padStart(12) + ' Live#  Roll#');
for (const t of types) {
  const l = live.get(t) ?? { rev: 0, orders: 0 };
  const r = rollup.get(t) ?? { rev: 0, orders: 0 };
  const diff = l.rev - r.rev;
  const flag = Math.abs(diff) > 0.01 || l.orders !== r.orders ? ' ⚠️' : ' ✅';
  console.log(`${t.padEnd(22)}${l.rev.toFixed(2).padStart(15)}${r.rev.toFixed(2).padStart(15)}${diff.toFixed(2).padStart(12)}  ${String(l.orders).padStart(5)}  ${String(r.orders).padStart(5)}${flag}`);
}
