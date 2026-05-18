// Demonstrates the DefaultJobTemplates fallback by stubbing one stock-side
// duration to null at the JS layer (no DB write) and re-running the resolution.
// This is a "what would happen if a product was misconfigured" probe — useful
// because the live data has zero null stock-side durations today, so the
// fallback path is dormant on real data.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { GrafanaConnector } from '../dist/connectors/grafana/grafana-connector.js';
import {
  parseDefaultJobTemplatesRows,
  resolveStockDuration,
  djtKey,
} from '../dist/connectors/product-durations/product-durations-connector.js';

const supabase = getSupabase();
const [grafanaUrl, grafanaToken, grafanaPgUid] = await Promise.all([
  readVaultSecret(supabase, 'GRAFANA_URL'),
  readVaultSecret(supabase, 'GRAFANA_TOKEN'),
  readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
]);
const grafana = new GrafanaConnector({ baseUrl: grafanaUrl, token: grafanaToken, postgresDsUid: grafanaPgUid });

const fromMs = Date.now() - 86400000;
const toMs = Date.now() + 86400000;

// Load real DefaultJobTemplates from prod.
const dr = await grafana.runSql({
  sql: `SELECT "groupType", step, type, duration FROM "DefaultJobTemplates" WHERE "groupType" IS NOT NULL AND step IS NOT NULL AND type IS NOT NULL`,
  fromMs, toMs, maxRows: 1000,
});
const defaults = parseDefaultJobTemplatesRows(dr.fields, dr.rows);

console.log('Loaded DefaultJobTemplates map. Size:', defaults.size);
console.log('Sample keys:');
const samples = ['stock-job-flush_mount|Assemble|Assemble',
                 'stock-job-flush_mount|Assemble|Stage',
                 'stock-job-flush_mount|Pack|Pack',
                 'stock-job-flush_mount|QA|QC',
                 'stock-job-floor|Pack|Pack'];
for (const k of samples) {
  console.log(`  ${k} → ${defaults.get(k)}`);
}

// Now simulate resolution for an imaginary product whose stockBlock leaves
// everything null but knows its groupType. Should produce a mix of
// source='default' and source='unset'.
console.log('\n=== Simulated resolution for a misconfigured stock-job-flush_mount product ===');
for (const [step, type] of [['Assemble', 'Assemble'], ['Assemble', 'Stage'], ['Pack', 'Pack'], ['QA', 'QC']]) {
  const r = resolveStockDuration(null, defaults, 'stock-job-flush_mount', step, type);
  console.log(`  ${step}/${type}: ${JSON.stringify(r)}`);
}

// And for a real product with values set — should be source='product' for all.
console.log('\n=== Simulated resolution with product overrides ===');
const fakeStock = { assemble: 20, stage: 2, pack: 10, qc: 3 };
for (const [step, type, val] of [
  ['Assemble', 'Assemble', fakeStock.assemble],
  ['Assemble', 'Stage', fakeStock.stage],
  ['Pack', 'Pack', fakeStock.pack],
  ['QA', 'QC', fakeStock.qc],
]) {
  const r = resolveStockDuration(val, defaults, 'stock-job-flush_mount', step, type);
  console.log(`  ${step}/${type}: ${JSON.stringify(r)}`);
}
