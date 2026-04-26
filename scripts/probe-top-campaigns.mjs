// Quick smoke test for level=campaign — confirms the API returns per-campaign
// rows with rev/spend/ROAS data we can sort.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { NorthbeamApiConnector } from '../dist/connectors/northbeam-api/connector.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);

const connector = new NorthbeamApiConnector({ apiKey, dataClientId });
const explorer = connector.tools.find((t) => t.name === 'northbeam.metrics_explorer');

const t0 = Date.now();
const r = await explorer.execute({
  dateRange: 'last_30_days',
  metrics: ['rev', 'spend', 'txns'],
  level: 'campaign',
  aggregateData: false,
  attributionModel: 'northbeam_custom__va',
  accountingMode: 'cash',
  attributionWindow: '1',
  granularity: 'DAILY',
});
console.log(`elapsed: ${Date.now() - t0}ms`);
if ('error' in r) { console.log('ERROR:', r.error); process.exit(1); }

console.log(`headers (${r.headers.length}):`, r.headers);
console.log(`rows: ${r.rowCount}`);

// Compute ROAS, top 5 by ROAS where spend > 0
const ranked = r.rows
  .map((row) => ({
    campaign: row.campaign_name,
    status: row.status,
    rev: parseFloat(row.rev || '0'),
    spend: parseFloat(row.spend || '0'),
    txns: parseFloat(row.transactions || row.txns || '0'),
  }))
  .filter((row) => row.spend > 0)
  .map((row) => ({ ...row, roas: row.rev / row.spend }))
  .sort((a, b) => b.roas - a.roas);

console.log('\nTop 5 campaigns by ROAS (spend > $0):');
for (const c of ranked.slice(0, 5)) {
  console.log(`  ${c.campaign.slice(0, 60).padEnd(60)} ROAS=${c.roas.toFixed(2)}x rev=$${c.rev.toFixed(0)} spend=$${c.spend.toFixed(0)} status=${c.status}`);
}
console.log('\nTop 5 campaigns by raw revenue:');
const byRev = [...ranked].sort((a, b) => b.rev - a.rev);
for (const c of byRev.slice(0, 5)) {
  console.log(`  ${c.campaign.slice(0, 60).padEnd(60)} rev=$${c.rev.toFixed(0)} spend=$${c.spend.toFixed(0)} ROAS=${c.roas.toFixed(2)}x`);
}
