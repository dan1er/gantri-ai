import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);

const r = await fetch('https://api.northbeam.io/v2/orders?start_date=2026-02-01&end_date=2026-02-28', {
  headers: { Authorization: apiKey, 'Data-Client-ID': dataClientId },
});
const text = await r.text();
console.log('status:', r.status);
console.log('content-type:', r.headers.get('content-type'));
console.log('byte length:', text.length);
console.log('first 500 chars:', text.slice(0, 500));
console.log('---');
console.log('last 100 chars:', text.slice(-100));
console.log('---');
console.log('first char code:', text.charCodeAt(0), '(', JSON.stringify(text[0]), ')');
console.log('last char code:', text.charCodeAt(text.length - 1), '(', JSON.stringify(text[text.length - 1]), ')');
console.log('---');
let parseErr = null;
try { JSON.parse(text); console.log('json.parse SUCCESS'); }
catch (e) { parseErr = e; console.log('json.parse FAILED:', e.message); }

// Try NDJSON
console.log('---');
const lines = text.split('\n').filter((l) => l.trim());
console.log(`split by newline: ${lines.length} non-empty lines`);
let ndjsonOk = 0, ndjsonErr = 0;
for (const l of lines.slice(0, 5)) {
  try { JSON.parse(l); ndjsonOk++; } catch { ndjsonErr++; }
}
console.log(`first 5 lines: ${ndjsonOk} parseable, ${ndjsonErr} not`);
