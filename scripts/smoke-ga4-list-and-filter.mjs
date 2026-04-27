// Smoke test for the new ga4.list_events tool + dimensionFilter on run_report.
// Validates the discovery → filtered-query flow works end-to-end against the
// real Gantri GA4 property.

import fs from 'node:fs';
import { Ga4Client } from '../dist/connectors/ga4/client.js';
import { Ga4Connector } from '../dist/connectors/ga4/connector.js';

const keyPath = process.env.GA4_KEY_PATH;
const propertyId = process.env.GA4_PROPERTY_ID;
if (!keyPath || !propertyId) { console.error('Set GA4_KEY_PATH and GA4_PROPERTY_ID'); process.exit(2); }

const client = new Ga4Client({ propertyId, serviceAccountKey: fs.readFileSync(keyPath, 'utf8') });
const conn = new Ga4Connector({ client });
const listEvents = conn.tools.find((t) => t.name === 'ga4.list_events');
const runReport = conn.tools.find((t) => t.name === 'ga4.run_report');

async function call(tool, raw) { return tool.execute(tool.schema.parse(raw)); }

console.log('\n=== ga4.list_events — last 30 days, top 50 ===');
const t0 = Date.now();
const events = await call(listEvents, { dateRange: 'last_30_days', limit: 50 });
console.log(`elapsed ${Date.now() - t0}ms · rowCount ${events.rowCount}`);
console.log(events.rows.slice(0, 25));

console.log('\n=== ga4.run_report with dimensionFilter (page_view + scroll only) ===');
const t1 = Date.now();
const filtered = await call(runReport, {
  dateRange: 'last_30_days',
  dimensions: ['pagePath', 'eventName'],
  metrics: ['eventCount'],
  dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['page_view', 'scroll'] } } },
  limit: 5000,
});
console.log(`elapsed ${Date.now() - t1}ms · rowCount ${filtered.rowCount}`);
console.log('first 6 rows:');
console.log(filtered.rows.slice(0, 6));

console.log('\nOK — list_events + dimensionFilter both work');
