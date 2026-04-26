// Print the exact CSV column names NB returns for each metric, so we can fix
// the column lookups in marketing-analysis.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { NorthbeamApiClient } from '../dist/connectors/northbeam-api/client.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);
const nb = new NorthbeamApiClient({ apiKey, dataClientId });

// Probe all the metrics we use across the 4 tools
const allMetrics = [
  'rev', 'spend', 'txns',
  'cacFt', 'aovFt', 'aovFtLtv', 'roasFt', 'roasFtLtv', 'revFt',
  'revRtn', 'txnsFt', 'txnsRtn', 'cac',
];

const csv = await nb.runExport({
  level: 'platform',
  time_granularity: 'DAILY',
  period_type: 'LAST_7_DAYS',
  breakdowns: [{ key: 'Platform (Northbeam)', values: ['Google Ads', 'Facebook Ads'] }],
  options: { export_aggregation: 'BREAKDOWN', remove_zero_spend: false, aggregate_data: true, include_ids: false },
  attribution_options: { attribution_models: ['northbeam_custom__va'], accounting_modes: ['cash'], attribution_windows: ['1'] },
  metrics: allMetrics.map((id) => ({ id })),
}, { timeoutMs: 180_000 });

console.log('CSV column headers returned by NB:');
for (const h of csv.headers) console.log('  ' + h);

console.log('\nFirst 2 rows:');
for (const row of csv.rows.slice(0, 2)) console.log(row);

// Build mapping metric_id → likely column_name
console.log('\nProbable metric_id → column_name mapping:');
for (const m of allMetrics) {
  // Try several conventions
  const candidates = csv.headers.filter((h) => {
    const lower = h.toLowerCase();
    const mLower = m.toLowerCase();
    // 'rev' → 'rev', 'cacFt' → 'cac_1st_time' or 'new_customer_acquisition_cost'
    if (lower === mLower) return true;
    if (lower.includes(mLower)) return true;
    // CamelCase → snake_case heuristic
    const snake = m.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
      .replace('_ft', '_1st_time').replace('_rtn', '_returning').replace('_ltv', '_ltv');
    if (lower === snake) return true;
    return false;
  });
  console.log(`  ${m}  →  ${candidates.length ? candidates.join(', ') : '(NOT FOUND)'}`);
}
