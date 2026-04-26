// Discover whether NB export API actually honors `accounting_modes` and
// `attribution_windows` filters, or if every row × (mode × window) combo
// always comes back. Critical for the marketing-analysis tools — if the
// filter is ignored, summing CSV rows double/quadruple-counts.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { NorthbeamApiClient } from '../dist/connectors/northbeam-api/client.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);
const nb = new NorthbeamApiClient({ apiKey, dataClientId });

const csv = await nb.runExport({
  level: 'platform',
  time_granularity: 'DAILY',
  period_type: 'LAST_7_DAYS',
  breakdowns: [{ key: 'Platform (Northbeam)', values: ['Google Ads', 'Facebook Ads'] }],
  options: { export_aggregation: 'BREAKDOWN', remove_zero_spend: false, aggregate_data: true, include_ids: false },
  attribution_options: { attribution_models: ['northbeam_custom__va'], accounting_modes: ['cash'], attribution_windows: ['1'] },
  metrics: [{ id: 'rev' }, { id: 'spend' }, { id: 'txns' }],
}, { timeoutMs: 180_000 });

console.log(`total rows: ${csv.rows.length}`);
console.log('all rows:');
for (const r of csv.rows) {
  console.log(`  channel=${r.breakdown_platform_northbeam.padEnd(15)} acc=${r.accounting_mode.padEnd(22)} window=${r.attribution_window.padEnd(8)} rev=${r.rev || '-'} spend=${r.spend || '-'}`);
}

// Group by channel to confirm we're getting multiple rows per channel
const byChannel = new Map();
for (const r of csv.rows) {
  const k = r.breakdown_platform_northbeam;
  byChannel.set(k, (byChannel.get(k) ?? 0) + 1);
}
console.log('\nrow count per channel:');
for (const [k, n] of byChannel) console.log(`  ${k}: ${n} rows`);

// Group by (acc_mode, window) — see how many distinct combos NB returns
const combos = new Set();
for (const r of csv.rows) combos.add(`${r.accounting_mode} | ${r.attribution_window}`);
console.log('\ndistinct (accounting_mode, window) combos:');
for (const c of combos) console.log(`  ${c}`);
