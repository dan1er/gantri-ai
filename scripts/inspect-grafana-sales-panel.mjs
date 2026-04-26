// Pull the Grafana Sales dashboard JSON to see what SQL the "Full Total" /
// revenue-by-type panel actually runs.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';

const supabase = getSupabase();
const [grafanaUrl, grafanaToken] = await Promise.all([
  readVaultSecret(supabase, 'GRAFANA_URL'),
  readVaultSecret(supabase, 'GRAFANA_TOKEN'),
]);

const headers = { Authorization: `Bearer ${grafanaToken}` };

// Search all dashboards, look for any panel whose SQL groups by t.type or
// mentions Trade explicitly.
const search = await fetch(`${grafanaUrl}/api/search?type=dash-db`, { headers }).then((r) => r.json());
console.log(`scanning ${search.length} dashboards for Trade/type panels…`);
for (const d of search) {
  const dash = await fetch(`${grafanaUrl}/api/dashboards/uid/${d.uid}`, { headers }).then((r) => r.json()).catch(() => null);
  if (!dash?.dashboard?.panels) continue;
  for (const p of dash.dashboard.panels) {
    const sqls = (p.targets ?? []).map((t) => t.rawSql).filter(Boolean);
    for (const sql of sqls) {
      if (/\bt\.type\s*=\s*'Trade'/i.test(sql) || /GROUP BY[^,]*\bt\.type\b/i.test(sql) || /AS\s*"?Type"?\b/i.test(sql)) {
        console.log(`\n=== dash="${dash.dashboard.title}" panel="${p.title}" (uid=${d.uid}) ===`);
        console.log(sql);
      }
    }
  }
}
