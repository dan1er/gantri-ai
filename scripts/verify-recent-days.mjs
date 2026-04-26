import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { NorthbeamApiClient } from '../dist/connectors/northbeam-api/client.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);
const client = new NorthbeamApiClient({ apiKey, dataClientId });

for (const date of ['2026-04-24', '2026-04-25', '2026-04-26']) {
  const r = await client.listOrders({ startDate: date, endDate: date });
  const total = r.reduce((s, o) => s + Number(o.purchase_total ?? 0), 0);
  console.log(`${date}: ${r.length} orders, $${total.toFixed(2)}`);
  for (const o of r) console.log(`   ${o.order_id}  ${o.time_of_purchase}  ${o.customer_name}  $${o.purchase_total}`);
}
