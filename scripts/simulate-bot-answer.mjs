// Simulate exactly what the bot does when asked "revenue por order type from
// 2024-01-01 to 2026-04-23". Then compare to Grafana panel SQL.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { GrafanaConnector } from '../dist/connectors/grafana/grafana-connector.js';
import { RollupRepo } from '../dist/storage/rollup-repo.js';
import { RollupConnector } from '../dist/connectors/rollup/rollup-connector.js';

const supabase = getSupabase();
const repo = new RollupRepo(supabase);
const conn = new RollupConnector({ repo });
const tool = conn.tools.find((t) => t.name === 'gantri.daily_rollup');

console.log('=== Bot tool call: gantri.daily_rollup ===');
const botResp = await tool.execute({
  dateRange: { startDate: '2024-01-01', endDate: '2026-04-23' },
  dimension: 'type',
  granularity: 'period',
});
console.log(`period: ${botResp.period.startDate} → ${botResp.period.endDate}`);
console.log(`dimension: ${botResp.dimension}, granularity: ${botResp.granularity}, rows: ${botResp.rows.length}`);
const botByType = new Map();
for (const row of botResp.rows) {
  botByType.set(row.dimensionKey, { rev: row.totalRevenueDollars, orders: row.totalOrders });
}

// Run Grafana panel SQL live for cross-check
const [grafanaUrl, grafanaToken, grafanaPgUid] = await Promise.all([
  readVaultSecret(supabase, 'GRAFANA_URL'),
  readVaultSecret(supabase, 'GRAFANA_TOKEN'),
  readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
]);
const grafana = new GrafanaConnector({ baseUrl: grafanaUrl, token: grafanaToken, postgresDsUid: grafanaPgUid });
const fromMs = Date.parse('2024-01-01T08:00:00Z');
const toMs   = Date.parse('2026-04-24T07:00:00Z');
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
    -1 * (SUM(COALESCE((sa.amount->>'subtotal')::decimal, 0))
      + COALESCE(SUM((gc.amount)::decimal), 0)
      + SUM(COALESCE((sa.amount->>'shipping')::decimal, 0))
      + SUM(COALESCE((sa.amount->>'tax')::decimal, 0))
      - SUM(COALESCE((sa.amount->>'discount')::decimal, 0))) AS rev,
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
const grafByType = new Map();
for (const row of r.rows) {
  const obj = {};
  r.fields.forEach((f, i) => { obj[f] = row[i]; });
  grafByType.set(obj.type, { rev: Number(obj.rev), orders: Number(obj.orders) });
}

console.log('\n=== Bot answer vs Grafana panel SQL (live) ===');
const types = [...new Set([...botByType.keys(), ...grafByType.keys()])].sort();
let allMatch = true;
console.log('Type'.padEnd(22) + 'Bot $'.padStart(14) + 'Grafana $'.padStart(14) + ' Bot#  Graf#');
for (const t of types) {
  const b = botByType.get(t) ?? { rev: 0, orders: 0 };
  const g = grafByType.get(t) ?? { rev: 0, orders: 0 };
  const match = Math.abs(b.rev - g.rev) < 0.01 && b.orders === g.orders;
  if (!match) allMatch = false;
  console.log(`${t.padEnd(22)}${b.rev.toFixed(2).padStart(14)}${g.rev.toFixed(2).padStart(14)}  ${String(b.orders).padStart(5)} ${String(g.orders).padStart(5)} ${match ? '✅' : '❌'}`);
}
console.log(allMatch ? '\n*** ALL MATCH ***' : '\n*** MISMATCH ***');
