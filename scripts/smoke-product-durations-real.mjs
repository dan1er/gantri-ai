// Real-API smoke for gantri.product_durations against prod data via Grafana.
// Verifies:
//   - DefaultJobTemplates fallback wires correctly for stock-side durations
//   - *MinSource fields show 'product' | 'default' | 'unset' as expected
//   - Single mode for Canopy (10337) returns a non-empty payload
//   - List mode top 3 rows have expected shape with sources
//
// Run:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/smoke-product-durations-real.mjs
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { GrafanaConnector } from '../dist/connectors/grafana/grafana-connector.js';
import { ProductDurationsConnector } from '../dist/connectors/product-durations/product-durations-connector.js';

const supabase = getSupabase();
const [grafanaUrl, grafanaToken, grafanaPgUid] = await Promise.all([
  readVaultSecret(supabase, 'GRAFANA_URL'),
  readVaultSecret(supabase, 'GRAFANA_TOKEN'),
  readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
]);
const grafana = new GrafanaConnector({ baseUrl: grafanaUrl, token: grafanaToken, postgresDsUid: grafanaPgUid });
const conn = new ProductDurationsConnector({ grafana });
const tool = conn.tools.find((t) => t.name === 'gantri.product_durations');

console.log('=== Single mode: Canopy (10337) ===');
const single = await tool.execute(tool.schema.parse({ productId: 10337 }));
console.log(JSON.stringify(single, null, 2));

console.log('\n=== List mode (top 3) ===');
const list = await tool.execute(tool.schema.parse({ limit: 3 }));
console.log(JSON.stringify(list, null, 2));

console.log('\n=== Single mode: Marea (any version with null defaults expected) ===');
// Search for a product whose stockBlock has a null value somewhere — query directly.
const probeSql = `
SELECT v."productId", p.name,
  (pjb."stockBlock"->>'assembleDuration') AS asm,
  (pjb."stockBlock"->>'packDuration')     AS pck,
  (pjb."stockBlock"->>'stageDuration')    AS stg,
  (pjb."stockBlock"->>'qcDuration')       AS qc,
  pjb."stockBlock"->>'groupType'          AS grp
FROM "ProductJobBlocks" pjb
JOIN "Versions" v ON v.id = pjb."versionId"
JOIN "Products" p ON p.id = v."productId"
WHERE pjb.type = 'Stock'
  AND v.status = 'Published'
  AND p.status = 'Active'
  AND (
    (pjb."stockBlock"->>'assembleDuration') IS NULL
    OR (pjb."stockBlock"->>'packDuration')     IS NULL
    OR (pjb."stockBlock"->>'stageDuration')    IS NULL
    OR (pjb."stockBlock"->>'qcDuration')       IS NULL
  )
LIMIT 5
`;
const probe = await grafana.runSql({ sql: probeSql, fromMs: Date.now() - 86400000, toMs: Date.now() + 86400000, maxRows: 10 });
console.log('Products with at least one null stock-side duration (looking for source=default):');
for (const row of probe.rows) {
  const obj = {};
  probe.fields.forEach((f, i) => { obj[f] = row[i]; });
  console.log(' ', JSON.stringify(obj));
}
