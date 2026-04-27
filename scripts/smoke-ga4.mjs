// One-off smoke test for the GA4 connector.
// Reads the service-account JSON from disk, constructs Ga4Client +
// Ga4Connector, and calls each tool against the real GA4 property.
// Validates auth + the two Data API endpoints end-to-end.
//
// Usage:
//   GA4_KEY_PATH=/Users/danierestevez/Desktop/gantri-508ea-7e7e1a8f8f91.json \
//   GA4_PROPERTY_ID=321849214 \
//   node scripts/smoke-ga4.mjs

import fs from 'node:fs';
import { Ga4Client } from '../dist/connectors/ga4/client.js';
import { Ga4Connector } from '../dist/connectors/ga4/connector.js';

const keyPath = process.env.GA4_KEY_PATH;
const propertyId = process.env.GA4_PROPERTY_ID;
if (!keyPath || !propertyId) {
  console.error('Set GA4_KEY_PATH and GA4_PROPERTY_ID');
  process.exit(2);
}

const serviceAccountKey = fs.readFileSync(keyPath, 'utf8');

const client = new Ga4Client({ propertyId, serviceAccountKey });
const conn = new Ga4Connector({ client });
const runReport = conn.tools.find((t) => t.name === 'ga4.run_report');
const realtime = conn.tools.find((t) => t.name === 'ga4.realtime');

// Match the production code path: registry.execute() runs args through
// schema.parse() before calling tool.execute(). Mirror that here so default
// values (e.g. realtime's default metrics) get applied.
async function run(tool, rawArgs) {
  const parsed = tool.schema.parse(rawArgs);
  return tool.execute(parsed);
}

console.log(`\n=== ga4.run_report — sessions by channel, last 7 days ===`);
const t0 = Date.now();
const r1 = await run(runReport, {
  dateRange: 'last_7_days',
  dimensions: ['sessionDefaultChannelGroup'],
  metrics: ['sessions', 'totalUsers'],
});
console.log(`elapsed ${Date.now() - t0}ms`);
console.log(JSON.stringify(r1, null, 2).slice(0, 1500));

console.log(`\n=== ga4.realtime — active users right now ===`);
const t1 = Date.now();
const r2 = await run(realtime, {});
console.log(`elapsed ${Date.now() - t1}ms`);
console.log(JSON.stringify(r2, null, 2));

console.log(`\n=== healthCheck ===`);
const t2 = Date.now();
const hc = await conn.healthCheck();
console.log(`elapsed ${Date.now() - t2}ms`);
console.log(JSON.stringify(hc));

if (r1?.error || r2?.error || !hc.ok) {
  console.error('\nFAIL — at least one call returned an error');
  process.exit(1);
}
console.log('\nOK — all GA4 calls succeeded');
