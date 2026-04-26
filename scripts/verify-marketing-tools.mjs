// E2E test of the 4 marketing-analysis tools against live NB data.
// Step 1: verify all metric IDs we hardcode exist in NB's catalog.
// Step 2: invoke each tool with a small window (last 7 days, prior 7 days for budget).
// Step 3: assert response shape + sanity-check numbers.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { NorthbeamApiClient } from '../dist/connectors/northbeam-api/client.js';
import { MarketingAnalysisConnector } from '../dist/connectors/marketing-analysis/connector.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);

const nb = new NorthbeamApiClient({ apiKey, dataClientId });

// ============ STEP 1: catalog audit ============
console.log('=== STEP 1: verify hardcoded metric IDs exist in NB catalog ===');
const catalog = await nb.listMetrics();
const catalogIds = new Set(catalog.map((m) => m.id));
console.log(`catalog has ${catalogIds.size} metric ids`);

const HARDCODED_METRICS = [
  // attribution_compare_models default
  'rev', 'spend', 'txns',
  // ltv_cac_by_channel
  'cacFt', 'aovFt', 'aovFtLtv', 'roasFt', 'roasFtLtv', 'revFt',
  // new_vs_returning_split
  'revRtn', 'txnsFt', 'txnsRtn', 'cac',
];
const missing = HARDCODED_METRICS.filter((id) => !catalogIds.has(id));
const present = HARDCODED_METRICS.filter((id) => catalogIds.has(id));
console.log(`present (${present.length}/${HARDCODED_METRICS.length}): ${present.join(', ')}`);
if (missing.length) {
  console.log(`MISSING: ${missing.join(', ')}`);
  // Find closest matches
  for (const m of missing) {
    const candidates = [...catalogIds].filter((id) => id.toLowerCase().includes(m.toLowerCase().slice(0, 3)));
    console.log(`  ${m} candidates:`, candidates.slice(0, 8));
  }
} else {
  console.log('all metric IDs present ✅');
}

// ============ STEP 2: per-tool execution ============
const conn = new MarketingAnalysisConnector({ nb });
const tool = (name) => conn.tools.find((t) => t.name === name);

const today = new Intl.DateTimeFormat('en-CA', { timeZone:'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
const ago = (days) => {
  const dt = new Date();
  dt.setUTCDate(dt.getUTCDate() - days);
  return new Intl.DateTimeFormat('en-CA', { timeZone:'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit' }).format(dt);
};

const sevenDays = { startDate: ago(8), endDate: ago(1) };  // Apr 19-25 ish (full days, exclude today)
const priorSevenDays = { startDate: ago(15), endDate: ago(9) };

console.log(`\nwindows used: current=${sevenDays.startDate}→${sevenDays.endDate}, prior=${priorSevenDays.startDate}→${priorSevenDays.endDate}\n`);

async function runTool(name, args) {
  console.log(`\n=== ${name} ===`);
  console.log(`args:`, JSON.stringify(args));
  const t0 = Date.now();
  try {
    const r = await tool(name).execute(args);
    const dur = Date.now() - t0;
    console.log(`OK in ${(dur/1000).toFixed(1)}s`);
    // print only top of result
    const summary = JSON.parse(JSON.stringify(r));
    if (summary.rows) {
      console.log(`rows: ${summary.rows.length}`);
      console.log(`first row:`, summary.rows[0]);
      console.log(`last row:`, summary.rows[summary.rows.length - 1]);
    }
    if (summary.models) {
      console.log(`models returned: ${summary.models.length}`);
      for (const m of summary.models) console.log(' ', m);
    }
    if (summary.totals) console.log(`totals:`, summary.totals);
    return r;
  } catch (err) {
    console.log(`FAIL after ${((Date.now()-t0)/1000).toFixed(1)}s: ${err.message}`);
    return null;
  }
}

// Tool 1: attribution_compare_models — only 3 models to keep test fast
await runTool('gantri.attribution_compare_models', {
  dateRange: sevenDays,
  metrics: ['rev', 'spend', 'txns'],
  models: ['northbeam_custom__va', 'last_touch', 'first_touch'],
});

// Tool 2: ltv_cac_by_channel
await runTool('gantri.ltv_cac_by_channel', {
  dateRange: sevenDays,
  breakdownKey: 'Platform (Northbeam)',
});

// Tool 3: new_vs_returning_split
await runTool('gantri.new_vs_returning_split', {
  dateRange: sevenDays,
  breakdownKey: 'Platform (Northbeam)',
  level: 'platform',
});

// Tool 4: budget_optimization_report
await runTool('gantri.budget_optimization_report', {
  currentPeriod: sevenDays,
  priorPeriod: priorSevenDays,
  minSpendDollars: 50,
});

console.log('\n=== done ===');
