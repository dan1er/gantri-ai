// Spike: probe the official Northbeam REST API to see if it can replace our
// reverse-engineered dashboard scraping. Specifically:
//
//   1. GET /v2/orders        → does it return per-order touchpoints / first-time
//                              flag / attribution metadata? (the only thing the
//                              aggregate /data-export can't give us)
//   2. GET /v1/exports/metrics       → metrics catalog
//   3. GET /v1/exports/breakdowns    → breakdowns catalog (subset, just to validate)
//   4. POST /v1/exports/data-export  → minimal aggregate, then poll result
//
// Run via fly ssh — needs env access to Vault.

import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';

const supabase = getSupabase();
const [apiKey, clientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);

const BASE = 'https://api.northbeam.io';
const headers = {
  Authorization: apiKey,
  'Data-Client-ID': clientId,
  'Content-Type': 'application/json',
};

const dump = (label, val) => console.log(`\n===== ${label} =====\n${typeof val === 'string' ? val : JSON.stringify(val, null, 2)}`);

async function getJson(path) {
  const r = await fetch(`${BASE}${path}`, { headers });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

async function postJson(path, payload) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

// ---------- 1) GET /v2/orders ----------
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
const ordersRes = await getJson(`/v2/orders?start_date=${twoDaysAgo}&end_date=${yesterday}`);
dump(`GET /v2/orders?start_date=${twoDaysAgo}&end_date=${yesterday} -> ${ordersRes.status}`, ordersRes.body);
if (ordersRes.body && Array.isArray(ordersRes.body) && ordersRes.body[0]) {
  dump('orders[0] keys', Object.keys(ordersRes.body[0]));
} else if (ordersRes.body && ordersRes.body.data && ordersRes.body.data[0]) {
  dump('orders[0] keys', Object.keys(ordersRes.body.data[0]));
}

// ---------- 2) GET /v1/exports/metrics ----------
const metricsRes = await getJson('/v1/exports/metrics');
dump(`GET /v1/exports/metrics -> ${metricsRes.status}`, Array.isArray(metricsRes.body) ? `array(${metricsRes.body.length}); first 5: ${JSON.stringify(metricsRes.body.slice(0,5), null, 2)}` : metricsRes.body);

// ---------- 3) GET /v1/exports/breakdowns ----------
const breakdownsRes = await getJson('/v1/exports/breakdowns');
dump(`GET /v1/exports/breakdowns -> ${breakdownsRes.status}`, Array.isArray(breakdownsRes.body) ? `array(${breakdownsRes.body.length}); first 5: ${JSON.stringify(breakdownsRes.body.slice(0,5), null, 2)}` : breakdownsRes.body);

// ---------- 4) POST /v1/exports/data-export + poll ----------
const exportPayload = {
  level: 'platform',
  time_granularity: 'DAILY',
  period_type: 'YESTERDAY',
  attribution_options: {
    attribution_models: ['northbeam_custom'],
    accounting_modes: ['accrual'],
    attribution_windows: ['1'],
  },
  metrics: [{ id: 'spend' }, { id: 'rev' }],
};
const createRes = await postJson('/v1/exports/data-export', exportPayload);
dump(`POST /v1/exports/data-export (yesterday, platform-level) -> ${createRes.status}`, createRes.body);

const exportId = createRes.body && (createRes.body.id || (createRes.body.data && createRes.body.data.id));
if (exportId) {
  console.log(`polling result for export id ${exportId}…`);
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const pollRes = await getJson(`/v1/exports/data-export/result/${exportId}`);
    const status = pollRes.body && pollRes.body.status;
    console.log(`  t+${Date.now() - t0}ms status=${status}`);
    if (status && status !== 'PENDING' && status !== 'RUNNING') {
      dump(`final result`, pollRes.body);
      break;
    }
  }
}
