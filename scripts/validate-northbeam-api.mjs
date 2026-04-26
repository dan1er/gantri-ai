// N6 validation: exercise the new metrics_explorer tool with 4 representative
// queries before flipping the production cutover. Confirms the tool returns
// usable shapes for: (a) spend on a specific date, (b) ROAS by Platform last
// 30d, (c) first-time/returning aggregates this week, (d) Lana's Forecast CSV.

import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { NorthbeamApiConnector } from '../dist/connectors/northbeam-api/connector.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);

const connector = new NorthbeamApiConnector({ apiKey, dataClientId });
const explorer = connector.tools.find((t) => t.name === 'northbeam.metrics_explorer');
if (!explorer) throw new Error('metrics_explorer tool missing');

async function run(label, args) {
  const t0 = Date.now();
  console.log(`\n=== ${label} ===`);
  console.log('args:', JSON.stringify(args));
  try {
    const r = await explorer.execute(args);
    const dur = Date.now() - t0;
    if ('error' in r) { console.log(`ERROR after ${dur}ms:`, r.error); return; }
    console.log(`SUCCESS in ${dur}ms — rows=${r.rowCount}`);
    console.log('headers:', r.headers);
    console.log('first 3 rows:'); for (const row of r.rows.slice(0, 3)) console.log(' ', row);
  } catch (err) {
    console.log(`THREW after ${Date.now() - t0}ms:`, err.message);
  }
}

// (a) Single-day spend, no breakdown
await run('a) spend on Jan 1 2026', {
  dateRange: { start: '2026-01-01', end: '2026-01-01' },
  metrics: ['spend'],
  attributionModel: 'northbeam_custom__va',
  accountingMode: 'cash',
  attributionWindow: '1',
  granularity: 'DAILY',
  aggregateData: true,
});

// (b) ROAS by Platform last 30d (rev + spend, no client-side compute here)
await run('b) rev+spend by Platform last 30d', {
  dateRange: 'last_30_days',
  metrics: ['rev', 'spend'],
  breakdown: { key: 'Platform (Northbeam)' },
  attributionModel: 'northbeam_custom__va',
  accountingMode: 'cash',
  attributionWindow: '1',
  granularity: 'DAILY',
  aggregateData: true,
});

// (c) First-time vs returning aggregates this week
await run('c) FT vs RTN aggregates last 7d', {
  dateRange: 'last_7_days',
  metrics: ['aovFt', 'aovRtn', 'visitorsFt', 'visitorsRtn'],
  attributionModel: 'northbeam_custom__va',
  accountingMode: 'cash',
  attributionWindow: '1',
  granularity: 'DAILY',
  aggregateData: true,
});

// (d) Lana's exact CSV: Forecast × cash × clicks+modeled views × rev/spend/txns
await run("d) Lana's Forecast CSV last 7d", {
  dateRange: 'last_7_days',
  metrics: ['rev', 'spend', 'txns'],
  breakdown: { key: 'Forecast' },
  attributionModel: 'northbeam_custom__va',
  accountingMode: 'cash',
  attributionWindow: '1',
  granularity: 'DAILY',
  aggregateData: true,
});
