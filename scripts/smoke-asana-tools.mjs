// E2E smoke test: instantiate the Asana connector and call its tool's
// `execute(...)` against the LIVE Asana workspace. Reports per-case pass/fail
// with an output snippet so we catch param-validation / response-shape bugs the
// unit tests can't (they stub fetch + the LLM).
//
// Usage:
//   ANTHROPIC_API_KEY=<key> ASANA_ACCESS_TOKEN=<token> node scripts/smoke-asana-tools.mjs
//
// (SUPABASE_* / SLACK_* stubs below satisfy the logger's env validation on
// import; they don't need real values. ANTHROPIC_API_KEY DOES need to be real
// if the window contains bounced features — otherwise the classifier degrades
// gracefully and the run still succeeds with degraded:true.)
//
// Exits 0 if all cases succeed, 1 if any fails.

import Anthropic from '@anthropic-ai/sdk';
import { AsanaApiClient } from '../dist/connectors/asana/client.js';
import { AsanaConnector } from '../dist/connectors/asana/connector.js';

const TOKEN = process.env.ASANA_ACCESS_TOKEN;
if (!TOKEN) { console.error('ASANA_ACCESS_TOKEN env var required'); process.exit(2); }

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? 'sk-ant-stub' });
const client = new AsanaApiClient({ accessToken: TOKEN });
const conn = new AsanaConnector({ client, claude });
const tool = conn.tools.find((t) => t.name === 'asana.feature_qa_stats');
if (!tool) { console.error('asana.feature_qa_stats tool not found'); process.exit(1); }

const cases = [
  { name: 'feature_qa_stats (last_90_days, full)', args: { dateRange: 'last_90_days' } },
  { name: 'feature_qa_stats (last_90_days, compact)', args: { dateRange: 'last_90_days', includeFeatures: false } },
  { name: 'feature_qa_stats (explicit June 2026)', args: { dateRange: { startDate: '2026-06-01', endDate: '2026-06-30' } } },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  try {
    const out = await tool.execute(c.args);
    if (out && typeof out === 'object' && 'ok' in out && out.ok === false) {
      console.log(`  ✗ ${c.name}  ERROR  ${JSON.stringify(out.error).slice(0, 200)}`);
      fail++;
      continue;
    }
    const t = out.totals ?? {};
    const summary = `qaActivity=${t.featuresWithQaActivity} bounced=${t.featuresBouncedAny} realBugByQa=${t.featuresRealBugByQa} process=${t.featuresProcessBounceOnly} unclassified=${t.featuresUnclassified} realBug%=${t.realBugRatePct} degraded=${out.degraded} finders=${(out.finders ?? []).length} features=${(out.features ?? []).length}`;
    console.log(`  ✓ ${c.name}\n      ${summary}`);
    pass++;
  } catch (err) {
    console.log(`  ✗ ${c.name}  THREW  ${(err && err.message ? err.message : String(err)).slice(0, 200)}`);
    fail++;
  }
}

console.log(`\n  ${pass} passed, ${fail} failed (of ${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
