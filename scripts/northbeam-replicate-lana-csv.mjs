// Verify the official API can replicate the weekly CSV export Lana described:
//   Source: Sales Attribution tab
//   Breakdown: Forecast (Gantri's internal channel naming)
//   Accounting Mode: Cash Snapshot
//   Attribution Model: Click + Modeled Views
//   Metrics: Revenue, Spend, Orders (formerly Transactions)
//   Grouping: by date, aggregated-only
//
// Steps:
//  1. List attribution-models catalog → find IDs for "Cash Snapshot" + "Click + Modeled Views"
//  2. Search metrics catalog → find IDs for Revenue / Spend / Orders
//  3. Submit a /data-export with the exact parameters and a 7-day window
//  4. Poll, fetch the signed CSV, print the first 20 rows for visual confirm

import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';

const supabase = getSupabase();
const [apiKey, clientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);

const BASE = 'https://api.northbeam.io';
const headers = { Authorization: apiKey, 'Data-Client-ID': clientId, 'Content-Type': 'application/json' };

const getJson = async (path) => {
  const r = await fetch(`${BASE}${path}`, { headers });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const postJson = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// 1) attribution-models catalog
const am = await getJson('/v1/exports/attribution-models');
console.log('=== attribution-models ===');
console.log(JSON.stringify(am.body, null, 2).slice(0, 4000));

// 2) metrics catalog — find the three Lana wants
const metrics = await getJson('/v1/exports/metrics');
const list = metrics.body && metrics.body.metrics ? metrics.body.metrics : [];
console.log(`\n=== metrics catalog: ${list.length} entries ===`);
const interesting = list.filter((m) => /^(rev|revenue|spend|order|transaction)/i.test(m.id) || /^(rev|revenue|spend|order|transaction)/i.test(m.label || ''));
console.log('candidates for revenue/spend/orders:');
for (const m of interesting.slice(0, 30)) console.log(`  ${m.id.padEnd(34)} ${m.label}`);
