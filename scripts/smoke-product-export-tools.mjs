// End-to-end smoke for products.export_catalog against the LIVE Porter
// read-replica (via Grafana). Per docs/process/adding-a-connector.md (H2),
// unit tests only check shape — this catches wrong column names, bad casts,
// and wrong price magnitudes on real data.
//
// Usage:
//   GRAFANA_URL=... GRAFANA_TOKEN=... GRAFANA_POSTGRES_DS_UID=... \
//     node scripts/smoke-product-export-tools.mjs
//
// Imports the COMPILED dist build, so run `npm run build` first.

import Papa from 'papaparse';
import { GrafanaConnector } from '../dist/connectors/grafana/grafana-connector.js';
import { ProductExportConnector } from '../dist/connectors/product-export/product-export-connector.js';

const { GRAFANA_URL, GRAFANA_TOKEN, GRAFANA_POSTGRES_DS_UID } = process.env;
if (!GRAFANA_URL || !GRAFANA_TOKEN || !GRAFANA_POSTGRES_DS_UID) {
  console.error('Missing GRAFANA_URL / GRAFANA_TOKEN / GRAFANA_POSTGRES_DS_UID env vars.');
  process.exit(1);
}

const grafana = new GrafanaConnector({
  baseUrl: GRAFANA_URL,
  token: GRAFANA_TOKEN,
  postgresDsUid: GRAFANA_POSTGRES_DS_UID,
});
const connector = new ProductExportConnector({ grafana });
const tool = connector.tools[0];

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

async function run(label, args) {
  console.log(`\n=== ${label} :: ${JSON.stringify(args)} ===`);
  const res = await tool.execute(args);
  if (res?.ok === false) {
    console.log(`tool returned error:`, res.error);
    return res;
  }
  const rows = Papa.parse(res.attachment.content, { header: true, skipEmptyLines: true }).data;
  console.log(`products=${res.productsExported} rows=${res.rowsExported} bytes=${res.attachment.content.length} truncated=${res.truncated}`);
  console.log(`headers: ${Object.keys(rows[0] ?? {}).join(' | ')}`);
  console.log('first 3 rows:');
  for (const r of rows.slice(0, 3)) {
    console.log(`  ${r['Product Name']} [${r.SKU}] $${r['List Price (USD)']} | ${r.Category} | ${r.Wattage}/${r.Lumens}lm/${r['Color Temperature']} dimm=${r.Dimmable} | cert=${r.Certification} | img=${r['Image URL'] ? 'Y' : '-'} cut=${r['Cut Sheet URL'] ? 'Y' : '-'} inst=${r['Install Instructions URLs'] ? 'Y' : '-'}`);
  }
  return { res, rows };
}

try {
  // 1. Active Table Lights, per-SKU, partner-safe.
  const { res, rows } = await run('Active Table Lights (partner-safe)', {
    status: 'Active',
    category: 'Table Light',
    granularity: 'sku',
    includeInternalCost: false,
  });
  check('returned at least one product', res.productsExported > 0);
  check('returned at least one SKU row', rows.length > 0);
  const headers = Object.keys(rows[0] ?? {});
  check('NO internal cost columns leaked', !headers.includes('Manufacturer Price (USD)') && !headers.includes('Royalty (%)'));
  check('has SKU + List Price + Product URL columns', ['SKU', 'List Price (USD)', 'Product URL'].every((h) => headers.includes(h)));

  // Price sanity — should look like real retail dollars ($50–$3000), not cents
  // ($16800) or raw fractions. Confirms the (specs.price)/100 cents→dollars cast.
  const prices = rows.map((r) => Number(r['List Price (USD)'])).filter((n) => Number.isFinite(n) && n > 0);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  check('prices look like dollars (10–5000 range)', prices.length > 0 && minP >= 10 && maxP <= 5000, `min=$${minP} max=$${maxP} n=${prices.length}`);

  // SKU format sanity — id-size-color (e.g. 10018-cm-snow).
  const skus = rows.map((r) => r.SKU).filter(Boolean);
  // id-size-color, optionally with extra variant segments (e.g. clamp finish):
  // 10018-cm-snow, 10102-sm-snow-white_clamp_finish.
  check('SKUs start with id-size-color', skus.length > 0 && skus.every((s) => /^\d+-[\w-]+$/.test(s)), `sample=${skus.slice(0, 3).join(', ')}`);

  // Product URL reachability — bare /products/{id} should 200/redirect.
  const sampleUrl = rows[0]['Product URL'].split('?')[0];
  const urlRes = await fetch(sampleUrl, { method: 'HEAD', redirect: 'manual' });
  check('product URL resolves (2xx/3xx)', urlRes.status >= 200 && urlRes.status < 400, `${sampleUrl} → ${urlRes.status}`);

  // Bulb specs derived from specs.bulb — at least some rows should have lumens/wattage.
  const withBulb = rows.filter((r) => r.Lumens || r.Wattage);
  check('bulb specs derived for some rows (lumens/wattage)', withBulb.length > 0, `${withBulb.length}/${rows.length} rows`);
  check('certification populated for all rows', rows.every((r) => r.Certification), `e.g. "${rows[0].Certification}"`);

  // Image URLs built from skuAssets — sample one and confirm it resolves (200).
  const withImg = rows.find((r) => r['Image URL']);
  check('at least one Image URL built from skuAssets', !!withImg, withImg ? `${withImg.SKU}` : 'none');
  if (withImg) {
    const imgRes = await fetch(withImg['Image URL'], { method: 'HEAD' });
    check('sample Image URL resolves (200)', imgRes.status === 200, `${imgRes.status} ${withImg['Image URL'].slice(0, 90)}…`);
  }

  // CSV round-trips with multiline material intact (no row corruption).
  check('row count matches rowsExported', rows.length === res.rowsExported, `${rows.length} vs ${res.rowsExported}`);

  // 2. Internal pull toggles cost columns ON.
  const internal = await tool.execute({ status: 'Active', category: 'Table Light', granularity: 'sku', includeInternalCost: true });
  const intHeaders = Object.keys(Papa.parse(internal.attachment.content, { header: true, skipEmptyLines: true }).data[0] ?? {});
  check('internal pull includes Manufacturer Price + Royalty', intHeaders.includes('Manufacturer Price (USD)') && intHeaders.includes('Royalty (%)'));

  // 3. Full active catalog (the real "export everything" case).
  const all = await run('All Active products', { status: 'Active', granularity: 'sku', includeInternalCost: false });
  check('full catalog exported >50 products', all.res.productsExported > 50, `${all.res.productsExported} products`);
  check('full catalog CSV under 2MB cap', all.res.attachment.content.length < 1_900_000, `${all.res.attachment.content.length} bytes`);

  // Cut-sheet + install-instruction PDF URLs — the whole point of this fix. Cut
  // sheets are lazily cached per SKU, so we assert a conservative coverage floor
  // (Phase-1: ~29% of active SKU rows carry one) and that a sample link actually
  // resolves to a PDF in the browser — a marker like "Available" never would.
  const allRows = all.rows;
  const cutRows = allRows.filter((r) => r['Cut Sheet URL']);
  const cutPct = (100 * cutRows.length) / allRows.length;
  check('≥15% of active SKU rows carry a Cut Sheet URL', cutPct >= 15, `${cutPct.toFixed(1)}% (${cutRows.length}/${allRows.length})`);
  const instRows = allRows.filter((r) => r['Install Instructions URLs']);
  check('some active SKU rows carry Install Instructions URLs', instRows.length > 0, `${instRows.length} rows`);

  // Every emitted URL must be a real, partner-clickable asset (200 + PDF).
  if (cutRows.length) {
    const url = cutRows[0]['Cut Sheet URL'];
    const res = await fetch(url, { method: 'HEAD' });
    const ct = res.headers.get('content-type') || '';
    check('sample Cut Sheet URL resolves (200 PDF)', res.status === 200 && ct.includes('pdf'), `${res.status} ${ct} ${url.slice(0, 80)}…`);
  }
  if (instRows.length) {
    const url = instRows[0]['Install Instructions URLs'].split('; ')[0];
    const res = await fetch(url, { method: 'HEAD' });
    check('sample Install Instructions URL resolves (200)', res.status === 200, `${res.status} ${url.slice(0, 80)}…`);
  }

  console.log(`\n${failures === 0 ? '✅ ALL SMOKE CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error('SMOKE THREW:', err);
  process.exit(1);
}
