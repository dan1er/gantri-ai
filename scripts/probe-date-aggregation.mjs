// With export_aggregation:'DATE', what shape comes back?
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { NorthbeamApiClient } from '../dist/connectors/northbeam-api/client.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);
const nb = new NorthbeamApiClient({ apiKey, dataClientId });

console.log('=== TEST 1: DATE aggregation, DAILY, 7 days, no breakdown, just spend ===');
const csv1 = await nb.runExport({
  level: 'platform',
  time_granularity: 'DAILY',
  period_type: 'FIXED',
  period_options: { period_starting_at: '2026-01-01T00:00:00.000Z', period_ending_at: '2026-01-07T23:59:59.999Z' },
  breakdowns: [],
  options: { export_aggregation: 'DATE', remove_zero_spend: false, aggregate_data: true, include_ids: false },
  attribution_options: { attribution_models: ['northbeam_custom__va'], accounting_modes: ['cash'], attribution_windows: ['1'] },
  metrics: [{ id: 'spend' }],
}, { timeoutMs: 120_000 });
console.log(`rows: ${csv1.rows.length}, headers: ${csv1.headers.join(', ')}`);
for (const r of csv1.rows) console.log(' ', r);

console.log('\n=== TEST 2: DATE aggregation, DAILY, 7 days, breakdown=Platform ===');
const csv2 = await nb.runExport({
  level: 'platform',
  time_granularity: 'DAILY',
  period_type: 'FIXED',
  period_options: { period_starting_at: '2026-01-01T00:00:00.000Z', period_ending_at: '2026-01-07T23:59:59.999Z' },
  breakdowns: [{ key: 'Platform (Northbeam)', values: ['Google Ads', 'Facebook Ads'] }],
  options: { export_aggregation: 'DATE', remove_zero_spend: false, aggregate_data: true, include_ids: false },
  attribution_options: { attribution_models: ['northbeam_custom__va'], accounting_modes: ['cash'], attribution_windows: ['1'] },
  metrics: [{ id: 'spend' }],
}, { timeoutMs: 120_000 });
console.log(`rows: ${csv2.rows.length}, headers: ${csv2.headers.join(', ')}`);
for (const r of csv2.rows.slice(0, 20)) console.log(' ', r);
