// Final replication: produce the EXACT CSV Lana described, fetch + dump head.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';

const supabase = getSupabase();
const [apiKey, clientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);
const headers = { Authorization: apiKey, 'Data-Client-ID': clientId, 'Content-Type': 'application/json' };
const BASE = 'https://api.northbeam.io';

const payload = {
  level: 'platform',
  time_granularity: 'DAILY',
  period_type: 'LAST_7_DAYS',
  breakdowns: [
    { key: 'Forecast',
      values: ['Affiliate','Direct','Email','Google Ads','Meta Ads','Organic Search','Organic Social','Other',''] },
  ],
  options: { export_aggregation: 'BREAKDOWN', remove_zero_spend: false, aggregate_data: true, include_ids: false },
  attribution_options: {
    attribution_models: ['northbeam_custom__va'], // Clicks + Modeled Views
    accounting_modes: ['cash'],                   // "Cash Snapshot" in UI
    attribution_windows: ['1'],
  },
  metrics: [{ id: 'rev' }, { id: 'spend' }, { id: 'txns' }],
};

console.log('payload:', JSON.stringify(payload, null, 2));

const cr = await fetch(`${BASE}/v1/exports/data-export`, { method: 'POST', headers, body: JSON.stringify(payload) });
const cb = await cr.json();
console.log(`POST /data-export -> ${cr.status}`, cb);
if (cr.status !== 201) process.exit(1);

const id = cb.id;
const t0 = Date.now();
for (let i = 0; i < 60; i++) {
  await new Promise((res) => setTimeout(res, 1000));
  const pr = await fetch(`${BASE}/v1/exports/data-export/result/${id}`, { headers });
  const pb = await pr.json();
  console.log(`  t+${Date.now() - t0}ms status=${pb.status}`);
  if (pb.status !== 'PENDING' && pb.status !== 'RUNNING') {
    if (pb.status === 'SUCCESS') {
      const csv = await fetch(pb.result[0]).then((r) => r.text());
      const lines = csv.split('\n');
      console.log(`\n=== CSV: ${lines.length - 1} data rows ===`);
      console.log('--- header + first 15 rows ---');
      for (const ln of lines.slice(0, 16)) console.log(ln);
      console.log('--- last 3 rows ---');
      for (const ln of lines.slice(-4, -1)) console.log(ln);
    } else {
      console.log(JSON.stringify(pb, null, 2));
    }
    break;
  }
}
