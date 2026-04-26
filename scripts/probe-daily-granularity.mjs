// Verify whether NB's data-export actually returns one row per day when
// time_granularity:'DAILY' is set, or if it collapses to a single aggregate.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { NorthbeamApiClient } from '../dist/connectors/northbeam-api/client.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);
const nb = new NorthbeamApiClient({ apiKey, dataClientId });

// Test 1: DAILY without aggregateData, no breakdown, just spend, 7 days
console.log('=== TEST 1: DAILY, aggregate_data:false, no breakdown, 7 days ===');
const csv1 = await nb.runExport({
  level: 'platform',
  time_granularity: 'DAILY',
  period_type: 'FIXED',
  period_options: { period_starting_at: '2026-01-01T00:00:00.000Z', period_ending_at: '2026-01-07T23:59:59.999Z' },
  breakdowns: [],
  options: { export_aggregation: 'BREAKDOWN', remove_zero_spend: false, aggregate_data: false, include_ids: false },
  attribution_options: { attribution_models: ['northbeam_custom__va'], accounting_modes: ['cash'], attribution_windows: ['1'] },
  metrics: [{ id: 'spend' }],
}, { timeoutMs: 120_000 });
console.log(`rows: ${csv1.rows.length}, headers: ${csv1.headers.join(', ')}`);
for (const r of csv1.rows.slice(0, 10)) console.log(' ', r);

// Test 2: DAILY with aggregateData:true (LLM's default)
console.log('\n=== TEST 2: DAILY, aggregate_data:true, no breakdown, 7 days ===');
const csv2 = await nb.runExport({
  level: 'platform',
  time_granularity: 'DAILY',
  period_type: 'FIXED',
  period_options: { period_starting_at: '2026-01-01T00:00:00.000Z', period_ending_at: '2026-01-07T23:59:59.999Z' },
  breakdowns: [],
  options: { export_aggregation: 'BREAKDOWN', remove_zero_spend: false, aggregate_data: true, include_ids: false },
  attribution_options: { attribution_models: ['northbeam_custom__va'], accounting_modes: ['cash'], attribution_windows: ['1'] },
  metrics: [{ id: 'spend' }],
}, { timeoutMs: 120_000 });
console.log(`rows: ${csv2.rows.length}, headers: ${csv2.headers.join(', ')}`);
for (const r of csv2.rows.slice(0, 10)) console.log(' ', r);

// Test 3: DAILY with breakdown=Platform, aggregate_data:false, 7 days
console.log('\n=== TEST 3: DAILY, aggregate_data:false, breakdown=Platform, 7 days ===');
const csv3 = await nb.runExport({
  level: 'platform',
  time_granularity: 'DAILY',
  period_type: 'FIXED',
  period_options: { period_starting_at: '2026-01-01T00:00:00.000Z', period_ending_at: '2026-01-07T23:59:59.999Z' },
  breakdowns: [{ key: 'Platform (Northbeam)', values: ['Google Ads', 'Facebook Ads'] }],
  options: { export_aggregation: 'BREAKDOWN', remove_zero_spend: false, aggregate_data: false, include_ids: false },
  attribution_options: { attribution_models: ['northbeam_custom__va'], accounting_modes: ['cash'], attribution_windows: ['1'] },
  metrics: [{ id: 'spend' }],
}, { timeoutMs: 120_000 });
console.log(`rows: ${csv3.rows.length}, headers: ${csv3.headers.join(', ')}`);
for (const r of csv3.rows.slice(0, 14)) console.log(' ', r);
