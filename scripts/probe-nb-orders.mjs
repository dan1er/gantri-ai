// Probe Northbeam /v2/orders for various date ranges to figure out why
// February 2026 returns empty when other days don't.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);

const headers = { Authorization: apiKey, 'Data-Client-ID': dataClientId };

async function probe(label, qs) {
  const r = await fetch(`https://api.northbeam.io/v2/orders?${qs}`, { headers });
  const ct = r.headers.get('content-type') ?? '';
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  const len = Array.isArray(body) ? body.length : (body?.data?.length ?? null);
  console.log(`${label.padEnd(50)} status=${r.status} ctype=${ct.split(';')[0].padEnd(20)} len=${len}`);
  if (Array.isArray(body) && body.length > 0) {
    const first = body[0];
    const last = body[body.length - 1];
    console.log(`  range: ${first.time_of_purchase} → ${last.time_of_purchase}`);
  } else if (body && typeof body === 'object' && !Array.isArray(body)) {
    console.log(`  body keys: ${Object.keys(body).join(', ')}`);
  } else if (typeof body === 'string') {
    console.log(`  body: ${body.slice(0, 200)}`);
  }
}

console.log('=== Probing /v2/orders for various windows ===\n');
await probe('1 day in Feb 2026 (2026-02-15)',  'start_date=2026-02-15&end_date=2026-02-16');
await probe('full Feb 2026',                    'start_date=2026-02-01&end_date=2026-02-28');
await probe('full Mar 2026',                    'start_date=2026-03-01&end_date=2026-03-31');
await probe('full Apr 2026 (current month)',    'start_date=2026-04-01&end_date=2026-04-26');
await probe('last 3 days',                       'start_date=2026-04-23&end_date=2026-04-26');
await probe('Jan 2025 (way back)',              'start_date=2025-01-01&end_date=2025-01-31');
await probe('big window 2026-01-01 to 2026-04-26 (4 months)', 'start_date=2026-01-01&end_date=2026-04-26');

console.log('\n=== Try ISO datetime format ===');
await probe('Feb 2026 ISO datetimes',
  'start_date=2026-02-01T00:00:00Z&end_date=2026-02-28T23:59:59Z');

console.log('\n=== Try with limit/page params ===');
await probe('Feb 2026 + limit=1000', 'start_date=2026-02-01&end_date=2026-02-28&limit=1000');
await probe('Feb 2026 + page=1',     'start_date=2026-02-01&end_date=2026-02-28&page=1');
await probe('Feb 2026 + cursor=0',   'start_date=2026-02-01&end_date=2026-02-28&cursor=0');
