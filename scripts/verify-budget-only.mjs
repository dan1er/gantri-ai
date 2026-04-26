// Re-run only budget_optimization_report to confirm fix.
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
const tool = conn.tools.find((t) => t.name === 'gantri.budget_optimization_report');

const r = await tool.execute({
  currentPeriod: { startDate: '2026-04-18', endDate: '2026-04-25' },
  priorPeriod: { startDate: '2026-04-11', endDate: '2026-04-17' },
  minSpendDollars: 50,
});
console.log(`rows: ${r.rows.length}`);
for (const row of r.rows) console.log(row);

console.log('\n=== sanity check: how many rows have prior_rev > 0? ===');
const withPriorRev = r.rows.filter((row) => row.prior_rev > 0);
console.log(`${withPriorRev.length}/${r.rows.length} campaigns have nonzero prior_rev`);
if (withPriorRev.length === 0) {
  console.log('SUSPICIOUS: zero campaigns have prior revenue. Either every $50+/wk campaign generated $0 prior week (unlikely) or there is still a bug.');
}
