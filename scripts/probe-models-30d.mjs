// Test attribution_compare_models with a 30-day window to confirm different
// models actually yield different numbers (over short windows they converge).
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { NorthbeamApiClient } from '../dist/connectors/northbeam-api/client.js';
import { MarketingAnalysisConnector } from '../dist/connectors/marketing-analysis/connector.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);
const nb = new NorthbeamApiClient({ apiKey, dataClientId });
const conn = new MarketingAnalysisConnector({ nb });
const tool = conn.tools.find((t) => t.name === 'gantri.attribution_compare_models');

console.log('=== attribution_compare_models, 30 days, all 7 models, breakdown=Google Ads ===');
const r = await tool.execute({
  dateRange: { startDate: '2026-03-26', endDate: '2026-04-25' },
  metrics: ['rev', 'spend', 'txns'],
  platformFilter: 'Google Ads',
});
console.log('models returned:', r.models.length);
for (const m of r.models) console.log(` `, m);

console.log('\n=== same, all platforms together (no filter) ===');
const r2 = await tool.execute({
  dateRange: { startDate: '2026-03-26', endDate: '2026-04-25' },
  metrics: ['rev', 'spend', 'txns'],
});
for (const m of r2.models) console.log(` `, m);
