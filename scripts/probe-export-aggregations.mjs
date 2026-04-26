// Find the export_aggregation value that actually produces per-day rows.
// We've confirmed BREAKDOWN does not — there's no date column in those rows.
// Try the other values NB might support.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);

const headers = { Authorization: apiKey, 'Data-Client-ID': dataClientId, 'Content-Type': 'application/json' };

async function probe(label, exportAggregation, extraOpts = {}) {
  const body = {
    level: 'platform',
    time_granularity: 'DAILY',
    period_type: 'FIXED',
    period_options: { period_starting_at: '2026-01-01T00:00:00.000Z', period_ending_at: '2026-01-07T23:59:59.999Z' },
    breakdowns: [],
    options: { export_aggregation: exportAggregation, remove_zero_spend: false, aggregate_data: false, include_ids: false, ...extraOpts },
    attribution_options: { attribution_models: ['northbeam_custom__va'], accounting_modes: ['cash'], attribution_windows: ['1'] },
    metrics: [{ id: 'spend' }],
  };
  const r = await fetch('https://api.northbeam.io/v1/exports/data-export', {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log(`${label.padEnd(40)} status=${r.status}`);
  if (r.ok) {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { parsed = JSON.parse(JSON.parse(text)); }
    console.log(`  job: ${parsed?.id ?? '(no id)'}`);
  } else {
    console.log(`  body: ${text.slice(0, 300)}`);
  }
}

// Test different export_aggregation values to find one that returns per-day rows
for (const v of ['BREAKDOWN', 'TIME', 'BREAKDOWN_AND_TIME', 'ROW', 'NONE', 'DAILY', 'DATE']) {
  try { await probe(`export_aggregation=${v}`, v); }
  catch (e) { console.log(`${`export_aggregation=${v}`.padEnd(40)} crashed: ${e.message}`); }
  await new Promise((r) => setTimeout(r, 500));
}
