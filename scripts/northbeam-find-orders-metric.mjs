// Find the exact metric ID for "Orders" (formerly Transactions) and verify the
// "Cash Snapshot" accounting mode by attempting an export with a few candidate
// values.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';

const supabase = getSupabase();
const [apiKey, clientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);
const headers = { Authorization: apiKey, 'Data-Client-ID': clientId, 'Content-Type': 'application/json' };
const BASE = 'https://api.northbeam.io';

// ----- find orders/transactions metric ids -----
const r = await fetch(`${BASE}/v1/exports/metrics`, { headers });
const { metrics } = await r.json();
console.log(`metrics total: ${metrics.length}`);

// Headline metric IDs the dashboard would call "Orders" / "Transactions".
// Likely contains "transactions" or "orders" without subscript; explicit ones
// already filter past in the long list.
const tightFilter = (m) =>
  /^transactions?$/i.test(m.id) ||
  /^orders?$/i.test(m.id) ||
  /^purchases?$/i.test(m.id) ||
  /^transactions?$/i.test(m.label || '') ||
  /^orders?$/i.test(m.label || '');

console.log('tight matches for orders/transactions:');
for (const m of metrics.filter(tightFilter)) console.log(`  ${m.id.padEnd(34)} ${m.label}`);

// Also list any metric whose label is exactly "Orders" or "Transactions":
console.log('exact label matches:');
for (const m of metrics.filter((m) => ['orders','transactions','revenue','spend'].includes((m.label || '').toLowerCase()))) {
  console.log(`  ${m.id.padEnd(34)} ${m.label}`);
}

// ----- try the export with attribution_options Lana asked for -----
async function tryExport(label, accountingMode, attributionWindow, metricsArr) {
  const payload = {
    level: 'platform',
    time_granularity: 'DAILY',
    period_type: 'YESTERDAY',
    breakdowns: [{ key: 'Forecast', values: ['Affiliate','Direct','Email','Google Ads','Meta Ads','Organic Search','Organic Social','Other',''] }],
    options: { export_aggregation: 'BREAKDOWN', remove_zero_spend: false, aggregate_data: false, include_ids: false },
    attribution_options: {
      attribution_models: ['northbeam_custom__va'],
      accounting_modes: [accountingMode],
      attribution_windows: [attributionWindow],
    },
    metrics: metricsArr.map((id) => ({ id })),
  };
  const r = await fetch(`${BASE}/v1/exports/data-export`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const body = await r.json().catch(() => null);
  console.log(`\n--- ${label} (mode=${accountingMode}, window=${attributionWindow}) -> ${r.status}`);
  if (r.status !== 201) { console.log(JSON.stringify(body, null, 2)); return null; }
  const id = body && body.id;
  for (let i = 0; i < 30; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    const pr = await fetch(`${BASE}/v1/exports/data-export/result/${id}`, { headers });
    const pb = await pr.json().catch(() => null);
    if (pb && pb.status && pb.status !== 'PENDING' && pb.status !== 'RUNNING') {
      console.log(`  status=${pb.status}`);
      if (pb.status === 'SUCCESS' && pb.result && pb.result[0]) {
        const csv = await fetch(pb.result[0]).then((res) => res.text());
        const lines = csv.split('\n').slice(0, 8);
        console.log('  CSV head:');
        for (const ln of lines) console.log('    ' + ln);
      } else {
        console.log(JSON.stringify(pb, null, 2));
      }
      return pb;
    }
  }
}

// First try: docs-style "cash" + cash variants
await tryExport('cash + 1d window', 'cash', '1', ['rev', 'spend', 'transactions']);
await tryExport('cash_snapshot + 1d window', 'cash_snapshot', '1', ['rev', 'spend', 'transactions']);
