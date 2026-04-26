// Investigate the $428.81 Trade revenue gap (Grafana $455,555.35 vs rollup
// $455,126.54). Probe several formulas + check for outliers.
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

async function probe(name, sql) {
  const r = await grafana.runSql({ sql, fromMs, toMs, maxRows: 5 });
  console.log(`${name.padEnd(80)} ${JSON.stringify(r.rows[0])}`);
}

console.log('=== Trade revenue under different formulas (2024-01-01 to 2026-04-23) ===');
const where = `t."createdAt" >= ($__timeFrom())::timestamp AND t."createdAt" <  ($__timeTo())::timestamp AND t.type = 'Trade' AND t.status NOT IN ('Cancelled')`;
await probe('SUM amount.total (when set)',
  `SELECT SUM((t.amount->>'total')::numeric)/100.0 FROM "Transactions" t WHERE ${where}`);
await probe('SUM(subtotal+ship+tax)',
  `SELECT SUM((t.amount->>'subtotal')::numeric + COALESCE((t.amount->>'shipping')::numeric,0) + COALESCE((t.amount->>'tax')::numeric,0))/100.0 FROM "Transactions" t WHERE ${where}`);
await probe('SUM(subtotal+ship+tax) - discount',
  `SELECT SUM((t.amount->>'subtotal')::numeric + COALESCE((t.amount->>'shipping')::numeric,0) + COALESCE((t.amount->>'tax')::numeric,0) - COALESCE((t.amount->>'discount')::numeric,0))/100.0 FROM "Transactions" t WHERE ${where}`);
await probe('rollup formula (sub+ship+tax - disc - cred - gift)',
  `SELECT SUM((t.amount->>'subtotal')::numeric + COALESCE((t.amount->>'shipping')::numeric,0) + COALESCE((t.amount->>'tax')::numeric,0) - COALESCE((t.amount->>'discount')::numeric,0) - COALESCE((t.amount->>'credit')::numeric,0) - COALESCE((t.amount->>'gift')::numeric,0))/100.0 FROM "Transactions" t WHERE ${where}`);
await probe('Status NOT IN Cancelled,Lost (old rollup)',
  `SELECT SUM((t.amount->>'subtotal')::numeric + COALESCE((t.amount->>'shipping')::numeric,0) + COALESCE((t.amount->>'tax')::numeric,0) - COALESCE((t.amount->>'discount')::numeric,0) - COALESCE((t.amount->>'credit')::numeric,0) - COALESCE((t.amount->>'gift')::numeric,0))/100.0 FROM "Transactions" t WHERE t."createdAt" >= ($__timeFrom())::timestamp AND t."createdAt" <  ($__timeTo())::timestamp AND t.type = 'Trade' AND t.status NOT IN ('Cancelled','Lost')`);
await probe('Total discount sum (Trade)',
  `SELECT SUM(COALESCE((t.amount->>'discount')::numeric,0))/100.0 FROM "Transactions" t WHERE ${where}`);
await probe('Total credit sum (Trade)',
  `SELECT SUM(COALESCE((t.amount->>'credit')::numeric,0))/100.0 FROM "Transactions" t WHERE ${where}`);
await probe('Total gift sum (Trade)',
  `SELECT SUM(COALESCE((t.amount->>'gift')::numeric,0))/100.0 FROM "Transactions" t WHERE ${where}`);
await probe('COALESCE(amount.total, sub+ship+tax-disc-cred-gift)',
  `SELECT SUM(COALESCE((t.amount->>'total')::numeric,
                       (t.amount->>'subtotal')::numeric + COALESCE((t.amount->>'shipping')::numeric,0) + COALESCE((t.amount->>'tax')::numeric,0) - COALESCE((t.amount->>'discount')::numeric,0) - COALESCE((t.amount->>'credit')::numeric,0) - COALESCE((t.amount->>'gift')::numeric,0)))/100.0 FROM "Transactions" t WHERE ${where}`);
await probe('COALESCE(amount.total, sub+ship+tax-disc) ← gift NOT subtracted in fallback',
  `SELECT SUM(COALESCE((t.amount->>'total')::numeric,
                       (t.amount->>'subtotal')::numeric + COALESCE((t.amount->>'shipping')::numeric,0) + COALESCE((t.amount->>'tax')::numeric,0) - COALESCE((t.amount->>'discount')::numeric,0)))/100.0 FROM "Transactions" t WHERE ${where}`);
await probe('rollup but exclude Refunded status (in case Grafana does)',
  `SELECT SUM((t.amount->>'subtotal')::numeric + COALESCE((t.amount->>'shipping')::numeric,0) + COALESCE((t.amount->>'tax')::numeric,0) - COALESCE((t.amount->>'discount')::numeric,0) - COALESCE((t.amount->>'credit')::numeric,0) - COALESCE((t.amount->>'gift')::numeric,0))/100.0 FROM "Transactions" t WHERE ${where} AND t.status NOT IN ('Refunded','Partially refunded')`);
await probe('SUM gift only on non-Refunded Trade (does this explain $428?)',
  `SELECT SUM(COALESCE((t.amount->>'gift')::numeric,0))/100.0 FROM "Transactions" t WHERE ${where} AND t.status NOT IN ('Refunded','Partially refunded')`);
await probe('SUM gift only on Refunded/Partially refunded Trade',
  `SELECT SUM(COALESCE((t.amount->>'gift')::numeric,0))/100.0 FROM "Transactions" t WHERE ${where} AND t.status IN ('Refunded','Partially refunded')`);
await probe("filtered by completedAt instead of createdAt",
  `SELECT SUM((t.amount->>'subtotal')::numeric + COALESCE((t.amount->>'shipping')::numeric,0) + COALESCE((t.amount->>'tax')::numeric,0) - COALESCE((t.amount->>'discount')::numeric,0) - COALESCE((t.amount->>'credit')::numeric,0) - COALESCE((t.amount->>'gift')::numeric,0))/100.0 FROM "Transactions" t WHERE t."completedAt" >= ($__timeFrom())::timestamp AND t."completedAt" <  ($__timeTo())::timestamp AND t.type = 'Trade' AND t.status NOT IN ('Cancelled')`);
await probe("count by completedAt (Trade)",
  `SELECT COUNT(*)::int FROM "Transactions" t WHERE t."completedAt" >= ($__timeFrom())::timestamp AND t."completedAt" <  ($__timeTo())::timestamp AND t.type = 'Trade' AND t.status NOT IN ('Cancelled')`);
await probe("rollup formula but status NOT IN ('Unpaid','Cancelled') ← Grafana filter",
  `SELECT SUM((t.amount->>'subtotal')::numeric + COALESCE((t.amount->>'shipping')::numeric,0) + COALESCE((t.amount->>'tax')::numeric,0) - COALESCE((t.amount->>'discount')::numeric,0) - COALESCE((t.amount->>'credit')::numeric,0) - COALESCE((t.amount->>'gift')::numeric,0))/100.0 FROM "Transactions" t WHERE t."createdAt" >= ($__timeFrom())::timestamp AND t."createdAt" <  ($__timeTo())::timestamp AND t.type = 'Trade' AND t.status NOT IN ('Unpaid','Cancelled')`);
await probe('count of Trade Unpaid',
  `SELECT COUNT(*)::int FROM "Transactions" t WHERE t."createdAt" >= ($__timeFrom())::timestamp AND t."createdAt" <  ($__timeTo())::timestamp AND t.type = 'Trade' AND t.status = 'Unpaid'`);
await probe('count by status (Trade)',
  `SELECT json_agg(json_build_object('status', s, 'n', n)) FROM (
     SELECT t.status AS s, COUNT(*) AS n FROM "Transactions" t WHERE ${where} GROUP BY t.status ORDER BY n DESC) x`);

// Where do trade rows have non-zero credit/gift?
console.log('\n=== Trade rows with non-zero credit OR gift OR discount ===');
const r = await grafana.runSql({
  sql: `SELECT t.id, t.status, t."customerName",
               (t.amount->>'subtotal')::numeric/100.0 AS subtotal,
               COALESCE((t.amount->>'shipping')::numeric,0)/100.0 AS shipping,
               COALESCE((t.amount->>'tax')::numeric,0)/100.0 AS tax,
               COALESCE((t.amount->>'discount')::numeric,0)/100.0 AS discount,
               COALESCE((t.amount->>'credit')::numeric,0)/100.0 AS credit,
               COALESCE((t.amount->>'gift')::numeric,0)/100.0 AS gift,
               (t.amount->>'total')::numeric/100.0 AS total
        FROM "Transactions" t
        WHERE ${where}
          AND ( COALESCE((t.amount->>'credit')::numeric,0) > 0
             OR COALESCE((t.amount->>'gift')::numeric,0) > 0
             OR COALESCE((t.amount->>'discount')::numeric,0) > 0 )
        ORDER BY t.id`,
  fromMs, toMs, maxRows: 50,
});
for (const row of r.rows) {
  const obj = {};
  r.fields.forEach((f, i) => { obj[f] = row[i]; });
  console.log(`  id=${obj.id} status=${obj.status} sub=${obj.subtotal} ship=${obj.shipping} tax=${obj.tax} disc=${obj.discount} cred=${obj.credit} gift=${obj.gift} total=${obj.total}`);
}
