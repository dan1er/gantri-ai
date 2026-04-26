// Two probes:
// 1) Are different attribution_models really yielding identical CSV output?
//    Calling 3 separate exports with different model IDs and diffing.
// 2) For budget_optimization, why is prior_rev always 0? Check the prior-week
//    export rows for campaign_name + breakdown_platform_northbeam shape.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { NorthbeamApiClient } from '../dist/connectors/northbeam-api/client.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);
const nb = new NorthbeamApiClient({ apiKey, dataClientId });

const period = { startDate: '2026-04-18', endDate: '2026-04-25' };
const prior = { startDate: '2026-04-11', endDate: '2026-04-17' };

function buildExport(opts) {
  return {
    level: opts.level ?? 'platform',
    time_granularity: 'DAILY',
    period_type: 'FIXED',
    period_options: {
      period_starting_at: `${opts.dateRange.startDate}T00:00:00.000Z`,
      period_ending_at: `${opts.dateRange.endDate}T23:59:59.999Z`,
    },
    breakdowns: opts.breakdown ? [opts.breakdown] : [],
    options: {
      export_aggregation: 'BREAKDOWN',
      remove_zero_spend: false,
      aggregate_data: opts.aggregateData ?? true,
      include_ids: false,
    },
    attribution_options: {
      attribution_models: [opts.attributionModel],
      accounting_modes: ['cash'],
      attribution_windows: ['1'],
    },
    metrics: opts.metrics.map((id) => ({ id })),
  };
}

console.log('=== PROBE 1: 3 attribution models, no breakdown, no platform filter ===');
for (const modelId of ['northbeam_custom__va', 'last_touch', 'first_touch']) {
  const csv = await nb.runExport(buildExport({
    dateRange: period,
    attributionModel: modelId,
    metrics: ['rev', 'spend', 'txns'],
  }), { timeoutMs: 90_000 });
  console.log(`\nmodel=${modelId} → ${csv.rows.length} rows, headers=${csv.headers.length}`);
  for (const r of csv.rows) {
    console.log(`  acc=${r.accounting_mode?.padEnd(20)} window=${r.attribution_window?.padEnd(10)} model=${r.attribution_model?.padEnd(28)} rev=${r.rev || '-'} spend=${r.spend || '-'} tx=${r.transactions || '-'}`);
  }
}

console.log('\n\n=== PROBE 2: budget_optimization prior period at campaign level ===');
const csv = await nb.runExport(buildExport({
  dateRange: prior,
  attributionModel: 'northbeam_custom__va',
  metrics: ['rev', 'spend', 'txns'],
  level: 'campaign',
  aggregateData: false,
}), { timeoutMs: 180_000 });
console.log(`rows: ${csv.rows.length}`);
console.log('headers:', csv.headers.slice(0, 25).join(', '));
console.log('\nfirst 5 prior-period rows:');
for (const r of csv.rows.slice(0, 5)) {
  console.log({
    platform: r.breakdown_platform_northbeam,
    campaign_name: r.campaign_name,
    rev: r.rev,
    spend: r.spend,
    txns: r.transactions,
    acc: r.accounting_mode,
    window: r.attribution_window,
  });
}
console.log('\ndistinct campaign_names in prior:');
const names = new Set();
for (const r of csv.rows) names.add(r.campaign_name || '(none)');
for (const n of [...names].slice(0, 15)) console.log(`  ${n}`);
console.log(`(${names.size} total)`);
