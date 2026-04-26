// Time how long a NB data-export for "yesterday" actually takes right now
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);
const headers = { Authorization: apiKey, 'Data-Client-ID': dataClientId, 'Content-Type': 'application/json' };

const payload = {
  level: 'platform',
  time_granularity: 'DAILY',
  period_type: 'YESTERDAY',
  attribution_options: { attribution_models: ['northbeam_custom__va'], accounting_modes: ['cash'], attribution_windows: ['1'] },
  metrics: [{ id: 'txns' }],
};

const t0 = Date.now();
const cr = await fetch('https://api.northbeam.io/v1/exports/data-export', { method: 'POST', headers, body: JSON.stringify(payload) });
console.log(`POST ${Date.now() - t0}ms status=${cr.status}`);
if (cr.status !== 201) { console.log('body:', await cr.text()); process.exit(1); }
const { id } = await cr.json();
console.log('export id:', id);

let lastStatus = '';
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const pr = await fetch(`https://api.northbeam.io/v1/exports/data-export/result/${id}`, { headers });
  const pb = await pr.json();
  if (pb.status !== lastStatus) {
    console.log(`  t+${Date.now() - t0}ms status=${pb.status}`);
    lastStatus = pb.status;
  }
  if (pb.status !== 'PENDING' && pb.status !== 'RUNNING') {
    console.log(`final after ${Date.now() - t0}ms:`, JSON.stringify(pb).slice(0, 300));
    break;
  }
}
