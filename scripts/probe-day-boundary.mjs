import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);
const headers = { Authorization: apiKey, 'Data-Client-ID': dataClientId };

async function p(label, qs) {
  const r = await fetch(`https://api.northbeam.io/v2/orders?${qs}`, { headers });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); if (typeof body === 'string') body = JSON.parse(body); } catch {}
  const len = Array.isArray(body) ? body.length : 'NOT_ARRAY';
  console.log(`${label.padEnd(50)} status=${r.status} len=${len}`);
}

console.log('=== Boundary tests for yesterday (2026-04-25) ===');
await p('start=04-25 end=04-25 (same day)',     'start_date=2026-04-25&end_date=2026-04-25');
await p('start=04-25 end=04-26 (end+1)',         'start_date=2026-04-25&end_date=2026-04-26');
await p('start=04-24 end=04-26 (2 days span)',   'start_date=2026-04-24&end_date=2026-04-26');
await p('start=04-24 end=04-25 (yesterday only)', 'start_date=2026-04-24&end_date=2026-04-25');
await p('start=04-25 end=04-27 (yesterday + today)', 'start_date=2026-04-25&end_date=2026-04-27');
