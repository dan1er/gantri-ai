// E2E smoke test: instantiate every tool the connector exposes and call
// `tool.execute(...)` against the LIVE Pipedrive tenant. Reports per-tool
// pass/fail with output snippet so we catch param-validation errors that
// the unit tests can't (because they stub fetch).
//
// Usage:
//   PIPEDRIVE_API_TOKEN=<token> node scripts/smoke-pipedrive-tools.mjs
//
// Exits 0 if all tools succeed. 1 if any fails.

import { PipedriveApiClient } from '../dist/connectors/pipedrive/client.js';
import { PipedriveConnector } from '../dist/connectors/pipedrive/connector.js';

const TOKEN = process.env.PIPEDRIVE_API_TOKEN;
if (!TOKEN) { console.error('PIPEDRIVE_API_TOKEN env var required'); process.exit(2); }

const client = new PipedriveApiClient({ apiToken: TOKEN });
const conn = new PipedriveConnector({ client });
const tools = new Map(conn.tools.map((t) => [t.name, t]));

const cases = [
  { name: 'pipedrive.list_directory (pipelines)',  tool: 'pipedrive.list_directory', args: { kind: 'pipelines' } },
  { name: 'pipedrive.list_directory (stages)',     tool: 'pipedrive.list_directory', args: { kind: 'stages' } },
  { name: 'pipedrive.list_directory (users)',      tool: 'pipedrive.list_directory', args: { kind: 'users' } },
  { name: 'pipedrive.list_directory (deal_fields)', tool: 'pipedrive.list_directory', args: { kind: 'deal_fields' } },
  { name: 'pipedrive.list_directory (source_options)', tool: 'pipedrive.list_directory', args: { kind: 'source_options' } },
  { name: 'pipedrive.search (Rarify)',             tool: 'pipedrive.search', args: { query: 'Rarify' } },
  { name: 'pipedrive.deal_timeseries (Q1 weekly add_time)', tool: 'pipedrive.deal_timeseries', args: { dateRange: { startDate: '2026-01-01', endDate: '2026-03-31' }, granularity: 'week', dateField: 'add_time' } },
  { name: 'pipedrive.deal_timeseries (12mo monthly won)', tool: 'pipedrive.deal_timeseries', args: { dateRange: { startDate: '2025-05-01', endDate: '2026-04-30' }, granularity: 'month', dateField: 'won_time' } },
  { name: 'pipedrive.pipeline_snapshot (Made id=2)', tool: 'pipedrive.pipeline_snapshot', args: { pipelineId: 2 } },
  { name: 'pipedrive.pipeline_snapshot (all)',     tool: 'pipedrive.pipeline_snapshot', args: {} },
  { name: 'pipedrive.list_deals (top 10 open by value)', tool: 'pipedrive.list_deals', args: { status: 'open', sortBy: 'value', sortOrder: 'desc', limit: 10 } },
  { name: 'pipedrive.list_deals (lost last month)', tool: 'pipedrive.list_deals', args: { status: 'lost', dateRange: { startDate: '2026-03-01', endDate: '2026-03-31' }, dateField: 'update_time', limit: 50 } },
  { name: 'pipedrive.deal_detail (id=816)',        tool: 'pipedrive.deal_detail', args: { dealId: 816 } },
  { name: 'pipedrive.organization_performance (top 15 YTD)', tool: 'pipedrive.organization_performance', args: { dateRange: 'year_to_date', topN: 15, metric: 'won_value' } },
  { name: 'pipedrive.organization_detail (Rarify id=339)', tool: 'pipedrive.organization_detail', args: { orgId: 339 } },
  { name: 'pipedrive.lost_reasons_breakdown (Q1)', tool: 'pipedrive.lost_reasons_breakdown', args: { dateRange: { startDate: '2026-01-01', endDate: '2026-03-31' }, topN: 10 } },
  { name: 'pipedrive.activity_summary (Mar 2026 done)', tool: 'pipedrive.activity_summary', args: { dateRange: { startDate: '2026-03-01', endDate: '2026-03-31' }, granularity: 'month' } },
  { name: 'pipedrive.user_performance (last 90 won_value)', tool: 'pipedrive.user_performance', args: { dateRange: 'last_90_days', metric: 'won_value', topN: 10 } },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  const t = tools.get(c.tool);
  if (!t) { console.log(`  ✗ ${c.name}  TOOL NOT FOUND`); fail++; continue; }
  try {
    const out = await t.execute(c.args);
    // Tools wrap errors in { ok: false, error: {...} }. Detect that.
    if (out && typeof out === 'object' && 'ok' in out && out.ok === false) {
      console.log(`  ✗ ${c.name}  ERROR  ${JSON.stringify(out.error).slice(0, 160)}`);
      fail++;
      continue;
    }
    const summary = JSON.stringify(out).slice(0, 140);
    console.log(`  ✓ ${c.name}  ${summary}...`);
    pass++;
  } catch (err) {
    console.log(`  ✗ ${c.name}  THREW  ${(err && err.message ? err.message : String(err)).slice(0, 160)}`);
    fail++;
  }
}

console.log(`\n  ${pass} passed, ${fail} failed (of ${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
