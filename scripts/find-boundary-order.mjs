// Hypothesis: the bot returns 9,645 but Grafana panel returns 9,646. The
// extra order is likely on a boundary — either date (April 23 evening PT
// crossing into April 24 UTC) or status (an Order with status='Refunded' or
// 'Lost' that the rollup excludes). Probe all reasonable filter variants.

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
const toMs   = Date.parse('2026-04-24T07:00:00.000Z'); // 2026-04-24 00:00 PT exclusive

async function probe(name, sql) {
  const r = await grafana.runSql({ sql, fromMs, toMs, maxRows: 5 });
  console.log(`${name.padEnd(60)} ${JSON.stringify(r.rows[0])}`);
}

await probe('rollup formula (excludes Cancelled/Lost)',
  `SELECT COUNT(*)::int FROM "Transactions" t
   WHERE t."createdAt" >= ($__timeFrom())::timestamp AND t."createdAt" <  ($__timeTo())::timestamp
     AND t.type = 'Order' AND t.status NOT IN ('Cancelled','Lost')`);
await probe('include Lost too',
  `SELECT COUNT(*)::int FROM "Transactions" t
   WHERE t."createdAt" >= ($__timeFrom())::timestamp AND t."createdAt" <  ($__timeTo())::timestamp
     AND t.type = 'Order' AND t.status NOT IN ('Cancelled')`);
await probe('include Cancelled too',
  `SELECT COUNT(*)::int FROM "Transactions" t
   WHERE t."createdAt" >= ($__timeFrom())::timestamp AND t."createdAt" <  ($__timeTo())::timestamp
     AND t.type = 'Order' AND t.status NOT IN ('Lost')`);
await probe('NO status filter',
  `SELECT COUNT(*)::int FROM "Transactions" t
   WHERE t."createdAt" >= ($__timeFrom())::timestamp AND t."createdAt" <  ($__timeTo())::timestamp
     AND t.type = 'Order'`);
await probe('UTC bucketing (no PT shift)',
  `SELECT COUNT(*)::int FROM "Transactions" t
   WHERE t."createdAt" >= '2024-01-01' AND t."createdAt" < '2026-04-24'
     AND t.type = 'Order' AND t.status NOT IN ('Cancelled','Lost')`);
await probe('UTC + Cancelled INCLUDED',
  `SELECT COUNT(*)::int FROM "Transactions" t
   WHERE t."createdAt" >= '2024-01-01' AND t."createdAt" < '2026-04-24'
     AND t.type = 'Order' AND t.status NOT IN ('Lost')`);

// Show the Order-status histogram to spot anything unusual
console.log('\nOrder-status histogram (full window):');
const histo = await grafana.runSql({
  sql: `SELECT t.status, COUNT(*)::int AS n
        FROM "Transactions" t
        WHERE t."createdAt" >= ($__timeFrom())::timestamp AND t."createdAt" <  ($__timeTo())::timestamp
          AND t.type = 'Order'
        GROUP BY t.status ORDER BY n DESC`,
  fromMs, toMs, maxRows: 50,
});
for (const row of histo.rows) console.log('  ' + row.join('  '));

// Last day of the range — April 23 PT
console.log('\nApril 23 PT — Order rows by status:');
const apr23 = await grafana.runSql({
  sql: `SELECT t.id, t.status, t."createdAt"
        FROM "Transactions" t
        WHERE DATE_TRUNC('day', t."createdAt" AT TIME ZONE 'America/Los_Angeles')::date = '2026-04-23'
          AND t.type = 'Order'
        ORDER BY t.id`,
  fromMs: Date.parse('2026-04-22T00:00:00Z'),
  toMs: Date.parse('2026-04-25T00:00:00Z'),
  maxRows: 100,
});
for (const row of apr23.rows) console.log('  ' + row.join('  '));
