// Theory: Grafana Sales panel sums StockAssociations.amount.subtotal not
// Transactions.amount.subtotal. Test that for Trade.
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

console.log('Trade revenue: comparing Transactions.subtotal vs StockAssociations.subtotal');

// 1) Sum of Transactions.subtotal for Trade
await probe('SUM Transactions.amount.subtotal',
  `SELECT SUM((t.amount->>'subtotal')::numeric)/100.0
   FROM "Transactions" t
   WHERE t."createdAt" BETWEEN $__timeFrom() AND $__timeTo()
     AND t.type = 'Trade'
     AND t.status NOT IN ('Cancelled')`);

// 2) Sum of StockAssociations.subtotal for Trade transactions, mimicking the
//    Grafana Sales-panel join exactly.
await probe('SUM SA.amount.subtotal joined to Trade transactions (Grafana per-product panel)',
  `SELECT SUM((sa.amount->>'subtotal')::decimal)/100.0
   FROM "Transactions" t
   JOIN "StockAssociations" sa ON sa."orderId" = t.id
   WHERE t."createdAt" BETWEEN $__timeFrom() AND $__timeTo()
     AND t.type = 'Trade'
     AND t.status NOT IN ('Unpaid','Cancelled')`);

// 3) Same but match the Sales panel's filter exactly (incl GiftCards)
await probe('SA.subtotal + GC.subtotal (Grafana Sales panel formula)',
  `WITH sa_agg AS (
     SELECT sa."orderId", SUM((sa.amount->>'subtotal')::decimal) AS s
     FROM "StockAssociations" sa GROUP BY sa."orderId"
   ),
   gc_agg AS (
     SELECT gc."orderId", SUM(gc.amount) AS s
     FROM "GiftCards" gc GROUP BY gc."orderId"
   )
   SELECT (COALESCE(SUM(sa_agg.s),0) + COALESCE(SUM(gc_agg.s),0))/100.0
   FROM "Transactions" t
   LEFT JOIN sa_agg ON sa_agg."orderId" = t.id
   LEFT JOIN gc_agg ON gc_agg."orderId" = t.id
   WHERE t."createdAt" BETWEEN $__timeFrom() AND $__timeTo()
     AND t.type = 'Trade'
     AND t.status NOT IN ('Unpaid','Cancelled')`);

// 4) The Sales panel also adds CASE filters and groups by SKU — replicate that and SUM
await probe("Sales panel formula exact (with p.status filter and t.status NOT IN ('Unpaid','Cancelled'))",
  `WITH sa_agg AS (
     SELECT sa."orderId", sa."productId", (sa.amount->>'subtotal')::decimal AS sub
     FROM "StockAssociations" sa
   ),
   gc_agg AS (
     SELECT gc."orderId", gc."productId", gc.amount AS sub
     FROM "GiftCards" gc
   )
   SELECT (COALESCE(SUM(sa_agg.sub),0) + COALESCE(SUM(gc_agg.sub),0))/100.0
   FROM "Transactions" t
   LEFT JOIN sa_agg ON sa_agg."orderId" = t.id
   LEFT JOIN gc_agg ON gc_agg."orderId" = t.id
   LEFT JOIN "Products" p ON sa_agg."productId" = p.id OR gc_agg."productId" = p.id
   WHERE t."createdAt" BETWEEN $__timeFrom() AND $__timeTo()
     AND t.type = 'Trade'
     AND t.status NOT IN ('Unpaid','Cancelled')
     AND p.status NOT IN ('In preparation')`);
