import { describe, it, expect, vi } from 'vitest';
import Papa from 'papaparse';
import { createHash } from 'node:crypto';
import {
  ProductExportConnector,
  buildCatalogSql,
  parseProductRow,
  expandRows,
  productColorOptions,
  swapSkuColor,
  toBool,
  parsePgJsonArray,
  splitPgArrayLiteral,
  ensureObject,
  dollars,
  listPrice,
  productUrl,
  escapeSql,
  decodeBulb,
  certification,
  cutSheetUrl,
  instructionUrls,
  fullProductName,
  productImagesArchiveUrl,
  productHasPhotos,
  WHOLESALE_DEFAULTS,
  type CatalogProduct,
} from '../../../../src/connectors/product-export/product-export-connector.js';
import type { GrafanaConnector } from '../../../../src/connectors/grafana/grafana-connector.js';

// ---------------------------------------------------------------------------
// Helpers — reproduce how Postgres serializes a text[] of JSON strings (the
// `colors` column) so the parser is exercised against the real wire shape.
// ---------------------------------------------------------------------------

function pgColorsLiteral(colors: Record<string, unknown>[]): string {
  const elems = colors.map((c) => `"${JSON.stringify(c).replace(/"/g, '\\"')}"`);
  return `{${elems.join(',')}}`;
}

const FIELDS = [
  'id', 'name', 'category', 'subCategory', 'designerName', 'status', 'type',
  'summary', 'description', 'leadTime', 'leadTimeOption',
  'colors', 'size', 'specs', 'downloads', 'skuAssets', 'isPainted',
];

function lagoRow(): unknown[] {
  return [
    10018,
    'Lago Compact',
    'Table Light',
    'Area',
    'Temporal Studio',
    'Active',
    'Marketplace',
    'A compact lamp',
    'Line one\nLine two, with a comma and a "quote"',
    47,
    '7-8 weeks',
    pgColorsLiteral([
      { code: 'snow', name: 'Snow', defaultSku: '10018-cm-snow' },
      { code: 'carbon', name: 'Carbon', defaultSku: '10018-cm-carbon' },
    ]),
    { code: 'cm', name: 'Compact' },
    {
      price: 24800,
      manufacturerPrice: 18216,
      royalty: 5,
      weight: 2.5,
      cableLength: 90,
      material: 'Translucent diffuser,\nOpaque body',
      bulb: 'E26, T8, 94mm',
      compatibleWith: ['Philips Hue White and Color, E26, A19, 1100lm', 'E26, T8, 94mm'],
      dimensions: { height: 10, width: 4.5, depth: 4.5 },
      footPrint: { width: 4.5, height: 0, depth: 4.5 },
      backplate: { width: 0, height: 0 },
    },
    // `downloads` mirrors the raw already-parsed object Grafana hands back for
    // the json column (nested cutSheet.data, per-type arrays). The cut-sheet PDF
    // filename does NOT live here — Porter caches it in skuAssets[sku].cutSheet,
    // so the marker-only fixture the old test used could never have produced a
    // real URL.
    {
      instructions: ['10018-install-instructions_1740000000000.pdf'],
      cutSheet: {
        isConfigured: true,
        data: {
          frontViewPhoto: '10018-cut-sheet-2d-drawing-front-view_1769817919223.png',
          firstLifestyleViewPhoto: '10018--lifestyle-photos-abc_1765420178863.jpg',
        },
      },
      models2D: [],
      models3D: [],
    },
    {
      // snow has a cached cut-sheet PDF filename; carbon does not (→ sibling fallback).
      '10018-cm-snow': {
        selectedWhiteBackgroundPhoto: '10018-cm-snow--product-photos-abc.jpg',
        cutSheet: '10018-cm-snow-cut-sheet_1779271198808.pdf',
      },
      '10018-cm-carbon': { whiteBackgroundPhotos: ['10018-cm-carbon--product-photos-def.jpg'] },
    },
    // isPainted: false → color options fall back to the designer subset
    // (snow/carbon), keeping this fixture's assertions focused. The full
    // all-available-colors path is covered by paintedRow()/product-colors tests.
    false,
  ];
}

function giftCardRow(): unknown[] {
  return [
    99, 'Gift Card', null, null, null, 'Active', 'Gift Card',
    null, null, null, null,
    '{}', // no colors
    null, null, null, null,
    false, // isPainted
  ];
}

function wirelessRow(): unknown[] {
  return [
    10500,
    'Nova Portable',
    'Wireless Table Light',
    null,
    'Studio Nova',
    'Active',
    'Marketplace',
    null,
    null,
    47,
    '7-8 weeks',
    pgColorsLiteral([{ code: 'snow', name: 'Snow', defaultSku: '10500-st-snow' }]),
    { code: 'st', name: 'Standard' },
    { price: 19800, bulb: 'LED PANEL, 130mm' },
    null,
    null,
    false, // isPainted
  ];
}

function wirelessTaskRow(): unknown[] {
  return [
    10600,
    'Beam Task',
    'Wireless Task Light',
    null,
    'Studio Beam',
    'Active',
    'Marketplace',
    null,
    null,
    47,
    '7-8 weeks',
    pgColorsLiteral([{ code: 'carbon', name: 'Carbon', defaultSku: '10600-st-carbon' }]),
    { code: 'st', name: 'Standard' },
    { price: 14800, bulb: 'LED PANEL, 110mm' },
    null,
    null,
    false, // isPainted
  ];
}

// Mirrors a REAL wireless product row (Drift, id 10501): bulb is the free-form
// "Integrated LED" label (NOT in BULB_NAME_MAPPINGS) and the Helia performance
// fields live in specs — the shape the wireless collection actually has in
// Porter prod.
function wirelessIntegratedRow(): unknown[] {
  return [
    10501,
    'Drift',
    'Wireless Mini Light',
    null,
    'Gantri Studio',
    'Active',
    'Marketplace',
    null,
    null,
    47,
    '7-8 weeks',
    pgColorsLiteral([{ code: 'lichen', name: 'Lichen', defaultSku: '10501-0-lichen' }]),
    null,
    {
      price: 24800,
      bulb: 'Integrated LED',
      maxBrightnessInBoostModeLumens: 400,
      engine: 'H1',
      batteryLifeBrightModeHours: 16,
      batteryCapacity: 47,
    },
    null,
    null,
    false, // isPainted (keeps the fixture on the designer-subset color path)
  ];
}

// A painted product (Table Light) — exercises the all-available-colors path:
// getColorsByProduct returns the full storefront palette for the category.
function paintedTableRow(): unknown[] {
  return [
    10018,
    'Lago Compact',
    'Table Light',
    'Area',
    'Temporal Studio',
    'Active',
    'Marketplace',
    null,
    null,
    47,
    '7-8 weeks',
    pgColorsLiteral([{ code: 'snow', name: 'Snow', defaultSku: '10018-cm-snow' }]), // designer subset
    { code: 'cm', name: 'Compact' },
    { price: 24800, bulb: 'E26, T8, 94mm' },
    null,
    { '10018-cm-snow': { selectedWhiteBackgroundPhoto: '10018-cm-snow--abc.jpg' } },
    true, // isPainted → all available colors
  ];
}

function makeConnector(
  runSqlImpl: () => Promise<{ fields: string[]; rows: unknown[][] }>,
  cloudinary?: { apiKey: string; apiSecret: string } | null,
) {
  const grafana = { runSql: vi.fn(runSqlImpl) } as unknown as GrafanaConnector;
  return { connector: new ProductExportConnector({ grafana, cloudinary }), grafana };
}

function parseCsv(content: string): Record<string, string>[] {
  return Papa.parse<Record<string, string>>(content, { header: true, skipEmptyLines: true }).data;
}

describe('products.export_catalog', () => {
  it('exports one row per SKU with partner-safe columns and correct pricing', async () => {
    const { connector } = makeConnector(async () => ({ fields: FIELDS, rows: [lagoRow(), giftCardRow()] }));
    const tool = connector.tools[0];

    const result: any = await tool.execute({
      status: 'Active',
      granularity: 'sku',
      includeInternalCost: false,
    });

    expect(result.attachment.format).toBe('csv');
    expect(result.attachment.normalizedFilename).toMatch(/\.csv$/);
    expect(result.productsExported).toBe(2);
    // 2 SKUs for Lago + 1 fallback row for the colorless gift card.
    expect(result.rowsExported).toBe(3);

    const rows = parseCsv(result.attachment.content);
    expect(rows).toHaveLength(3);

    const headers = Object.keys(rows[0]);
    // Internal cost columns must NOT be present by default.
    expect(headers).not.toContain('Manufacturer Price (USD)');
    expect(headers).not.toContain('Royalty (%)');
    expect(headers).toEqual(
      expect.arrayContaining([
        'SKU', 'List Price (USD)', 'Product URL', 'Return Policy', 'Bulb Type', 'Certification', 'Product Images (ZIP)',
        'CRI', 'Voltage', 'Dimmer Type', 'Cut Sheet URL', 'Install Instructions URLs',
      ]),
    );
    // The per-image "Image URLs" column is gone — images ship as ONE ZIP link
    // per product (Product Images (ZIP)) at marketing's request.
    expect(headers).not.toContain('Image URLs');
    // Old availability markers are gone — replaced by URL-bearing columns.
    expect(headers).not.toContain('Cut Sheet');
    expect(headers).not.toContain('Install Instructions');

    const snow = rows.find((r) => r.SKU === '10018-cm-snow')!;
    const carbon = rows.find((r) => r.SKU === '10018-cm-carbon')!;
    expect(snow).toBeTruthy();
    expect(carbon).toBeTruthy();

    // specs.price (24800c → 248.00) — uniform across colors (no per-SKU override).
    expect(snow['List Price (USD)']).toBe('248.00');
    expect(carbon['List Price (USD)']).toBe('248.00');

    // Composed display name = `name + " " + category` (Porter's fullProductName),
    // not the bare `Products.name`. Designer stays in its own column.
    expect(snow['Product Name']).toBe('Lago Compact Table Light');
    expect(snow.Color).toBe('Snow');
    expect(snow.Designer).toBe('Temporal Studio');
    expect(snow['Compatible Bulbs']).toBe('Philips Hue White and Color, E26, A19, 1100lm; E26, T8, 94mm');
    expect(snow['Dimensions (in, H x W x D)']).toBe('10 x 4.5 x 4.5');
    expect(snow['Cord Length (in)']).toBe('90');
    expect(snow['Weight (lb)']).toBe('2.5');
    expect(snow['Return Policy']).toBe(WHOLESALE_DEFAULTS.returnPolicy);
    expect(snow['Country of Origin']).toBe('USA');
    expect(snow['Product URL']).toBe('https://www.gantri.com/products/10018?sku=10018-cm-snow');
    // Cut Sheet URL: real, browser-clickable Cloudinary PDF built from the
    // cached skuAssets[sku].cutSheet filename (NOT the old "Available" marker).
    expect(snow['Cut Sheet URL']).toBe(
      'https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/10018/10018-cm-snow/10018-cm-snow-cut-sheet_1779271198808.pdf',
    );
    // carbon has no cached cut sheet of its own → sibling fallback to snow's
    // (the cut sheet is a product-level doc, so the link still resolves).
    expect(carbon['Cut Sheet URL']).toBe(snow['Cut Sheet URL']);
    // Install instruction PDF URL built from downloads.instructions[] filenames,
    // stored per product under /downloads/. Same for every SKU of the product.
    expect(snow['Install Instructions URLs']).toBe(
      'https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/10018/downloads/10018-install-instructions_1740000000000.pdf',
    );
    expect(carbon['Install Instructions URLs']).toBe(snow['Install Instructions URLs']);

    // Bulb specs decoded from specs.bulb ("E26, T8, 94mm") via BULB_NAME_MAPPINGS.
    expect(snow['Bulb Code']).toBe('E26, T8, 94mm');
    expect(snow['Bulb Type']).toBe('E26 LED Dimmable Bulb (included)');
    expect(snow['Bulb Base']).toBe('E26');
    expect(snow['Bulb Quantity']).toBe('1');
    expect(snow.Wattage).toBe('8.5W');
    expect(snow.Lumens).toBe('850');
    expect(snow['Color Temperature']).toBe('2700K');
    expect(snow.Dimmable).toBe('Yes');
    expect(snow['Bulb Included']).toBe('Yes');
    // Company-standard defaults apply: bulb-equipped, non-wireless product.
    expect(snow.CRI).toBe('90');
    expect(snow.Voltage).toBe('120V');
    expect(snow['Dimmer Type']).toBe('Triac Dimmer');
    // Placeholder columns exist in the template but have no data source yet.
    expect(snow['Backplate Shape']).toBe('');
    expect(snow['Backplate Material']).toBe('');
    expect(snow['Canopy Dimensions']).toBe('');
    expect(snow['Canopy Shape']).toBe('');
    expect(snow['Canopy Material']).toBe('');
    expect(snow['Hanging Dimensions']).toBe('');
    expect(snow['Shipping Box Dimensions (in, L x W x H)']).toBe('');
    expect(snow['Shipping Box Weight (lb)']).toBe('');
    // Certification derived from category (Table Light = plug-in).
    expect(snow.Certification).toBe('SGS for UL and CSA');
    // Material with embedded comma + newline survives the CSV round-trip.
    expect(snow.Material).toBe('Translucent diffuser,\nOpaque body');
    // Backplate is all-zero → blank, not "0 x 0".
    expect(snow['Backplate (in, W x H)']).toBe('');

    // Colorless product still exported once. Null category → graceful fallback
    // to the bare name (no "null"/"undefined" leaking into the display name).
    const gift = rows.find((r) => r['Product Name'] === 'Gift Card')!;
    expect(gift).toBeTruthy();
    expect(gift['Product Name']).toBe('Gift Card');
    expect(gift['Product Name']).not.toMatch(/null|undefined/);
    expect(gift.SKU).toBe('');
    // No bulb code → electrical defaults do not apply.
    expect(gift.CRI).toBe('');
    expect(gift.Voltage).toBe('');
    expect(gift['Dimmer Type']).toBe('');
    // No downloads / skuAssets → both PDF URL columns blank (never a marker).
    expect(gift['Cut Sheet URL']).toBe('');
    expect(gift['Install Instructions URLs']).toBe('');
  });

  it('keeps CRI but blanks voltage and dimmer type for wireless lights', async () => {
    const { connector } = makeConnector(async () => ({ fields: FIELDS, rows: [wirelessRow()] }));
    const result: any = await connector.tools[0].execute({
      status: 'Active',
      granularity: 'sku',
      includeInternalCost: false,
    });
    const rows = parseCsv(result.attachment.content);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // Composed display name includes the (already-qualified) wireless category.
    expect(row['Product Name']).toBe('Nova Portable Wireless Table Light');
    // Integrated LED panel decodes as dimmable...
    expect(row.Dimmable).toBe('Yes');
    // ...and still gets the CRI default...
    expect(row.CRI).toBe('90');
    // ...but battery-powered wireless fixtures have no line voltage and dim
    // via integrated touch/app control, not a wall Triac dimmer.
    expect(row.Voltage).toBe('');
    expect(row['Dimmer Type']).toBe('');
  });

  it('exports the wireless performance specs for an Integrated LED product, mirroring the PDP', async () => {
    const { connector } = makeConnector(async () => ({
      fields: FIELDS,
      rows: [wirelessIntegratedRow(), lagoRow()],
    }));
    const result: any = await connector.tools[0].execute({
      status: 'Active',
      granularity: 'sku',
      includeInternalCost: false,
    });
    const rows = parseCsv(result.attachment.content);
    const drift = rows.find((r) => r['Product Name'] === 'Drift Wireless Mini Light')!;
    expect(drift).toBeTruthy();

    // "Integrated LED" is not in BULB_NAME_MAPPINGS — the wireless path must
    // still surface the full light specs the PDP shows.
    expect(drift['Bulb Code']).toBe('Integrated LED');
    expect(drift['Bulb Type']).toBe('Integrated LED (rated for 50,000 hours)');
    expect(drift['Bulb Included']).toBe('Integrated (not replaceable)');
    expect(drift.Dimmable).toBe('Yes');
    // Lumens from specs.maxBrightnessInBoostModeLumens (the bulb code has none).
    expect(drift.Lumens).toBe('400');
    // Dual-mode color temp is a wireless-wide constant.
    expect(drift['Color Temperature']).toBe('2700K (Relax) and 3000K (Create)');
    // Performance block from specs + Wireless Launch brand copy.
    expect(drift['Light Engine']).toBe('Gantri Helia H1');
    expect(drift['Battery Life']).toBe('16 hours in Bright mode');
    expect(drift['Battery Capacity (Wh)']).toBe('47');
    expect(drift['Battery Longevity']).toBe('1,000 charge cycles; 8+ years of daily use, backed by 3-year warranty');
    expect(drift.Charging).toBe('Gantri Charging Base, included');
    expect(drift['Smart Home']).toBe('Works with Apple Home, Google Home, and Alexa via Matter — arriving Q1 2027');
    expect(drift.Durability).toBe('IP44 splash proof');
    // Electrical defaults still gated off for battery-powered fixtures.
    expect(drift.Voltage).toBe('');
    expect(drift['Dimmer Type']).toBe('');
    expect(drift.CRI).toBe('90');

    // Corded products leave the whole wireless block blank — and keep their
    // bulb-decode values untouched.
    const lago = rows.find((r) => r.SKU === '10018-cm-snow')!;
    expect(lago['Light Engine']).toBe('');
    expect(lago['Battery Life']).toBe('');
    expect(lago['Battery Capacity (Wh)']).toBe('');
    expect(lago['Battery Longevity']).toBe('');
    expect(lago.Charging).toBe('');
    expect(lago['Smart Home']).toBe('');
    expect(lago.Durability).toBe('');
    expect(lago['Bulb Type']).toBe('E26 LED Dimmable Bulb (included)');
    expect(lago['Bulb Included']).toBe('Yes');
    expect(lago['Color Temperature']).toBe('2700K');
  });

  it('includes internal cost columns only when includeInternalCost is true', async () => {
    const { connector } = makeConnector(async () => ({ fields: FIELDS, rows: [lagoRow()] }));
    const result: any = await connector.tools[0].execute({
      status: 'Active',
      granularity: 'sku',
      includeInternalCost: true,
    });
    const rows = parseCsv(result.attachment.content);
    expect(Object.keys(rows[0])).toContain('Manufacturer Price (USD)');
    expect(rows[0]['Manufacturer Price (USD)']).toBe('182.16');
    expect(rows[0]['Royalty (%)']).toBe('5');
    expect(result.includedInternalCost).toBe(true);
  });

  it('defaults to one row per product, aggregating SKUs, colors and images one-per-line', async () => {
    const { connector } = makeConnector(async () => ({ fields: FIELDS, rows: [lagoRow()] }));
    // granularity omitted → schema default kicks in ('product').
    const parsedDefault = connector.tools[0].schema.parse({});
    expect((parsedDefault as any).granularity).toBe('product');

    const result: any = await connector.tools[0].execute({
      status: 'Active',
      granularity: 'product',
      includeInternalCost: false,
    });
    expect(result.granularity).toBe('product');
    expect(result.rowsExported).toBe(1);

    const rows = parseCsv(result.attachment.content);
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // SKU / color aggregated into single cells, one value per line
    // (newline-separated). This fixture is non-painted → designer subset.
    expect(row.SKU).toBe('10018-cm-snow\n10018-cm-carbon');
    expect(row.Color).toBe('Snow\nCarbon');
    // Product-level fields stay singular: base list price + bare product URL
    // (no ?sku= query).
    expect(row['List Price (USD)']).toBe('248.00');
    expect(row['Product URL']).toBe('https://www.gantri.com/products/10018');
    // Cut sheet + install instructions are product-level docs → still one URL each.
    expect(row['Cut Sheet URL']).toBe(
      'https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/10018/10018-cm-snow/10018-cm-snow-cut-sheet_1779271198808.pdf',
    );
    expect(row['Install Instructions URLs']).toBe(
      'https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/10018/downloads/10018-install-instructions_1740000000000.pdf',
    );
  });

  it('a PAINTED product lists ALL available colors (full palette), not just the designer subset', async () => {
    const { connector } = makeConnector(async () => ({ fields: FIELDS, rows: [paintedTableRow()] }));
    const result: any = await connector.tools[0].execute({
      status: 'Active',
      granularity: 'product',
      includeInternalCost: false,
    });
    const row = parseCsv(result.attachment.content)[0];

    const colors = row.Color.split('\n');
    const skus = row.SKU.split('\n');
    // Every available color for a painted Table Light, from getColorsByProduct
    // (marketplace-parity set: trade included, gantri + archived excluded).
    expect(colors).toEqual([
      'Blossom', 'Canyon', 'Carbon', 'Cobalt', 'Meadow', 'Midnight', 'Mist', 'Mustard',
      'Olive', 'Peach', 'Persimmon', 'Poppy', 'Sage', 'Sand', 'Sedona', 'Smoke', 'Snow',
      'Spruce', 'Stone', 'Sunrise', 'Walnut',
    ]);
    // NOT just the designer subset (which was only Snow).
    expect(colors.length).toBeGreaterThan(1);
    // Archived + gantri-exclusive + wireless-only colors are excluded.
    expect(colors).not.toContain('Coral'); // archived
    expect(colors).not.toContain('Gantri Green'); // gantri-exclusive
    expect(colors).not.toContain('Lichen'); // wireless-only
    // One SKU per color, aligned; the designer color keeps its authoritative
    // defaultSku, the rest are derived {id}-{size}-{code}.
    expect(skus).toHaveLength(colors.length);
    expect(skus).toContain('10018-cm-snow'); // designer defaultSku
    expect(skus).toContain('10018-cm-carbon'); // derived
    expect(skus).toContain('10018-cm-blossompink'); // derived
  });

  it('colorless products still export as one product row (empty SKU/Color cells)', async () => {
    const { connector } = makeConnector(async () => ({ fields: FIELDS, rows: [giftCardRow()] }));
    const result: any = await connector.tools[0].execute({
      status: 'Active',
      granularity: 'product',
      includeInternalCost: false,
    });
    expect(result.rowsExported).toBe(1);
    const row = parseCsv(result.attachment.content)[0];
    expect(row['Product Name']).toBe('Gift Card');
    expect(row.SKU).toBe('');
    expect(row.Color).toBe('');
    expect(row['Product Images (ZIP)']).toBe('');
  });

  it('emits ONE signed images-ZIP link per product when Cloudinary creds are configured', async () => {
    const { connector } = makeConnector(
      async () => ({ fields: FIELDS, rows: [lagoRow(), giftCardRow()] }),
      { apiKey: 'test-key', apiSecret: 'test-secret' },
    );
    const result: any = await connector.tools[0].execute({
      status: 'Active',
      granularity: 'sku',
      includeInternalCost: false,
    });
    const rows = parseCsv(result.attachment.content);

    const snow = rows.find((r) => r.SKU === '10018-cm-snow')!;
    const carbon = rows.find((r) => r.SKU === '10018-cm-carbon')!;
    const zip = snow['Product Images (ZIP)'];
    // Signed archive-download URL over the product's folder, minted locally.
    expect(zip).toContain('https://api.cloudinary.com/v1_1/gantri/image/generate_archive?');
    expect(zip).toContain('mode=download');
    expect(zip).toContain(encodeURIComponent('dynamic-assets/gantri/products/10018/'));
    expect(zip).toContain('signature=');
    expect(zip).toContain('api_key=test-key');
    // The secret must NEVER leak into the URL.
    expect(zip).not.toContain('test-secret');
    // Product-level link: identical for every row of the product.
    expect(carbon['Product Images (ZIP)']).toBe(zip);
    // Products without photos get no link (an empty-folder archive would 404).
    const gift = rows.find((r) => r['Product Name'] === 'Gift Card')!;
    expect(gift['Product Images (ZIP)']).toBe('');
  });

  it('leaves the images-ZIP column blank when Cloudinary creds are absent', async () => {
    const { connector } = makeConnector(async () => ({ fields: FIELDS, rows: [lagoRow()] }));
    const result: any = await connector.tools[0].execute({
      status: 'Active',
      granularity: 'sku',
      includeInternalCost: false,
    });
    const rows = parseCsv(result.attachment.content);
    expect(Object.keys(rows[0])).toContain('Product Images (ZIP)');
    expect(rows[0]['Product Images (ZIP)']).toBe('');
  });

  it('returns NO_PRODUCTS when the filter matches nothing', async () => {
    const { connector } = makeConnector(async () => ({ fields: FIELDS, rows: [] }));
    const result: any = await connector.tools[0].execute({
      status: 'Active',
      category: 'Nonexistent',
      granularity: 'sku',
      includeInternalCost: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NO_PRODUCTS');
  });

  it('exports MULTIPLE categories in ONE attachment (no CSV-per-category fan-out)', async () => {
    // Regression: "our wireless lights" spans several categories. A single call
    // with a category array must yield ONE CSV containing rows from all of them,
    // never one attachment per category.
    const { connector } = makeConnector(async () => ({
      fields: FIELDS,
      rows: [wirelessRow(), wirelessTaskRow()],
    }));
    const result: any = await connector.tools[0].execute({
      status: 'Active',
      category: ['Wireless Table Light', 'Wireless Task Light'],
      granularity: 'sku',
      includeInternalCost: false,
    });

    // Exactly one file, covering both categories.
    expect(result.attachment).toBeTruthy();
    expect(result.attachment.format).toBe('csv');
    expect(result.productsExported).toBe(2);

    const rows = parseCsv(result.attachment.content);
    expect(rows).toHaveLength(2);
    expect(result.rowsExported).toBe(2);
    const categories = new Set(rows.map((r) => r.Category));
    expect(categories).toEqual(new Set(['Wireless Table Light', 'Wireless Task Light']));

    // Filename uses the neutral multi-category label, not just one category's name.
    expect(result.attachment.filename).toContain('multi-category');
  });

  it('NO_PRODUCTS message renders a category array as names, not "[object Object]"', async () => {
    const { connector } = makeConnector(async () => ({ fields: FIELDS, rows: [] }));
    const result: any = await connector.tools[0].execute({
      status: 'Active',
      category: ['Wireless Table Light', 'Wireless Task Light'],
      granularity: 'sku',
      includeInternalCost: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NO_PRODUCTS');
    expect(result.error.message).not.toMatch(/\[object Object\]|,\s*,/);
    expect(result.error.message).toContain('Wireless Table Light, Wireless Task Light');
  });

  it('surfaces a QUERY_FAILED error when the SQL proxy throws', async () => {
    const { connector } = makeConnector(async () => {
      throw new Error('boom');
    });
    const result: any = await connector.tools[0].execute({
      status: 'Active',
      granularity: 'sku',
      includeInternalCost: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('QUERY_FAILED');
  });
});

describe('SQL builder', () => {
  it('filters by status, category, ids, and name with escaping', () => {
    const sql = buildCatalogSql({
      status: 'Active',
      category: "O'Hare Light",
      productIds: [1, 2, 3],
      productNameContains: "Lu'a",
      granularity: 'sku',
      includeInternalCost: false,
    });
    expect(sql).toContain(`status = 'Active'`);
    expect(sql).toContain(`category = 'O''Hare Light'`);
    expect(sql).toContain('id IN (1, 2, 3)');
    expect(sql).toContain(`name ILIKE '%Lu''a%'`);
    expect(sql).toContain('"skuAssets"');
    // Deprecated per-SKU price overrides are no longer selected.
    expect(sql).not.toContain('skuPrices');
  });

  it('omits the status clause for status=all', () => {
    const sql = buildCatalogSql({ status: 'all', granularity: 'sku', includeInternalCost: false });
    expect(sql).not.toContain('status =');
    expect(sql).not.toContain('WHERE');
  });

  it('uses category = for a single category', () => {
    const sql = buildCatalogSql({ status: 'Active', category: 'Table Light', granularity: 'sku', includeInternalCost: false });
    expect(sql).toContain(`category = 'Table Light'`);
    expect(sql).not.toContain('category IN');
  });

  it('OR-joins multiple productNameContains terms in ONE query', () => {
    const sql = buildCatalogSql({
      status: 'Active',
      productNameContains: ['eave', 'pier', "dri'ft"],
      granularity: 'product',
      includeInternalCost: false,
    });
    expect(sql).toContain(`(name ILIKE '%eave%' OR name ILIKE '%pier%' OR name ILIKE '%dri''ft%')`);

    // Single term keeps the simple form (back-compat with the string arg).
    const single = buildCatalogSql({
      status: 'Active',
      productNameContains: 'eave',
      granularity: 'product',
      includeInternalCost: false,
    });
    expect(single).toContain(`name ILIKE '%eave%'`);
    expect(single).not.toContain(' OR ');
  });

  it('uses category IN for multiple categories, each escaped', () => {
    const sql = buildCatalogSql({
      status: 'Active',
      category: ['Wireless Table Light', 'Wireless Task Light'],
      granularity: 'sku',
      includeInternalCost: false,
    });
    expect(sql).toContain(`category IN ('Wireless Table Light', 'Wireless Task Light')`);
    expect(sql).not.toContain('category =');

    const escaped = buildCatalogSql({
      status: 'all',
      category: ["O'Hare Light", 'Table Light'],
      granularity: 'sku',
      includeInternalCost: false,
    });
    expect(escaped).toContain(`category IN ('O''Hare Light', 'Table Light')`);
  });
});

describe('parsing + formatting helpers', () => {
  it('parses a Postgres text[] of JSON-string colors', () => {
    const literal = pgColorsLiteral([
      { code: 'snow', name: 'Snow', defaultSku: '10018-cm-snow' },
      { code: 'carbon', name: 'Carbon', defaultSku: '10018-cm-carbon' },
    ]);
    const parsed = parsePgJsonArray(literal);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ code: 'snow', defaultSku: '10018-cm-snow' });
  });

  it('parsePgJsonArray tolerates an already-decoded array and empty literal', () => {
    expect(parsePgJsonArray([{ code: 'a' }])).toEqual([{ code: 'a' }]);
    expect(parsePgJsonArray('{}')).toEqual([]);
    expect(parsePgJsonArray(null)).toEqual([]);
  });

  it('splitPgArrayLiteral unescapes embedded quotes', () => {
    expect(splitPgArrayLiteral('"a","b"')).toEqual(['a', 'b']);
    expect(splitPgArrayLiteral('"{\\"x\\":1}"')).toEqual(['{"x":1}']);
  });

  it('ensureObject handles objects, JSON strings, and junk', () => {
    expect(ensureObject({ a: 1 })).toEqual({ a: 1 });
    expect(ensureObject('{"a":1}')).toEqual({ a: 1 });
    expect(ensureObject('not json')).toBeNull();
    expect(ensureObject(null)).toBeNull();
    expect(ensureObject([1, 2])).toBeNull();
  });

  it('dollars converts cents and blanks nulls', () => {
    expect(dollars(24800)).toBe('248.00');
    expect(dollars(0)).toBe('0.00');
    expect(dollars(null)).toBe('');
  });

  it('listPrice reads specs.price (uniform across colors), blank when unset', () => {
    expect(listPrice({ specs: { price: 24800 } } as unknown as CatalogProduct)).toBe('248.00');
    // No price set (e.g. accessories with specs.price 0 / null) → blank, not "0.00".
    expect(listPrice({ specs: { price: 0 } } as unknown as CatalogProduct)).toBe('');
    expect(listPrice({ specs: {} } as unknown as CatalogProduct)).toBe('');
    expect(listPrice({ specs: null } as unknown as CatalogProduct)).toBe('');
  });

  it('productUrl uses the bare id form with an optional sku query', () => {
    expect(productUrl(10018, '10018-cm-snow')).toBe('https://www.gantri.com/products/10018?sku=10018-cm-snow');
    expect(productUrl(10018, '')).toBe('https://www.gantri.com/products/10018');
  });

  it('escapeSql doubles single quotes', () => {
    expect(escapeSql("O'Hare")).toBe("O''Hare");
  });

  it('decodeBulb extracts structured specs from a mapped code', () => {
    const b = decodeBulb('E26, T8, 94mm');
    expect(b).toMatchObject({
      type: 'E26 LED Dimmable Bulb (included)',
      base: 'E26',
      quantity: '1',
      wattage: '8.5W',
      lumens: '850',
      colorTemp: '2700K',
      dimmable: 'Yes',
      included: 'Yes',
    });
  });

  it('decodeBulb reads quantity prefix and dual color-temp range', () => {
    expect(decodeBulb('2x E12, T6, 65mm')).toMatchObject({ quantity: '2', base: 'E12', lumens: '600', wattage: '6.4W' });
    expect(decodeBulb('LED PANEL, 110mm')).toMatchObject({ base: 'Integrated LED', colorTemp: '2700K-5000K', lumens: '1500', wattage: '15W' });
  });

  it('decodeBulb falls back gracefully for unmapped/empty codes', () => {
    expect(decodeBulb(null)).toMatchObject({ type: '', base: '', wattage: '', lumens: '' });
    const u = decodeBulb('E26, ZZ99'); // not in map
    expect(u.base).toBe('E26');
    expect(u.type).toBe('E26, ZZ99');
    expect(u.lumens).toBe(''); // unknown — blank, not guessed
  });

  it('fullProductName composes name + category, mirroring Porter', () => {
    // Standard product: qualified `name + category` title.
    expect(fullProductName({ name: 'Lago Compact', category: 'Table Light' })).toBe('Lago Compact Table Light');
    expect(fullProductName({ name: 'Cantilever', category: 'Wall Light' })).toBe('Cantilever Wall Light');
    // Post-migration wireless categories already encode the variant.
    expect(fullProductName({ name: 'Nova Portable', category: 'Wireless Table Light' })).toBe('Nova Portable Wireless Table Light');
    // Null / empty category → bare name, never "null"/"undefined".
    expect(fullProductName({ name: 'Gift Card', category: null })).toBe('Gift Card');
    expect(fullProductName({ name: 'Some Accessory', category: '' })).toBe('Some Accessory');
    // Designer is NOT part of the title (kept in its own column).
    expect(fullProductName({ name: 'Lago Compact', category: 'Table Light' })).not.toContain('by');
    // Empty name → empty string.
    expect(fullProductName({ name: '', category: 'Table Light' })).toBe('');
  });

  it('certification derives from category like the PDP', () => {
    expect(certification('Table Light')).toBe('SGS for UL and CSA'); // plug-in
    expect(certification('Floor Light')).toBe('SGS for UL and CSA');
    expect(certification('Pendant Light')).toBe('UL Listed for US and Canada'); // hardwired
    expect(certification('Wireless Table Light')).toBe('UL Listed for US and Canada');
    expect(certification(null)).toBe('');
  });

  it('cutSheetUrl builds a Cloudinary PDF URL from the cached filename, with sibling fallback', () => {
    const p = {
      id: 10258,
      skuAssets: {
        '10258-lg-sage-black': { cutSheet: '10258-lg-sage-black-cut-sheet_1778288503179.pdf' },
        '10258-lg-mist-white': { cutSheet: '10258-lg-mist-white-cut-sheet_1781821971769.pdf' },
        '10258-lg-olive-none': { whiteBackgroundPhotos: ['x.jpg'] }, // no cached cut sheet
      },
    } as unknown as CatalogProduct;
    // Exact SKU → its own cut sheet.
    expect(cutSheetUrl(p, '10258-lg-sage-black')).toBe(
      'https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/10258/10258-lg-sage-black/10258-lg-sage-black-cut-sheet_1778288503179.pdf',
    );
    // SKU with no cached cut sheet → falls back to a sibling SKU's cut sheet
    // (path points at the sibling's folder, where the asset actually lives).
    expect(cutSheetUrl(p, '10258-lg-olive-none')).toBe(
      'https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/10258/10258-lg-sage-black/10258-lg-sage-black-cut-sheet_1778288503179.pdf',
    );
    // Product granularity (empty sku) → first cached sibling.
    expect(cutSheetUrl(p, '')).toContain('/10258/10258-lg-sage-black/');
    // No cached cut sheet anywhere → blank, never a marker.
    const none = { id: 10018, skuAssets: { '10018-cm-snow': { whiteBackgroundPhotos: ['y.jpg'] } } } as unknown as CatalogProduct;
    expect(cutSheetUrl(none, '10018-cm-snow')).toBe('');
    expect(cutSheetUrl({ id: 99, skuAssets: null } as unknown as CatalogProduct, 'x')).toBe('');
  });

  it('instructionUrls joins per-product install-instruction PDF URLs, blank when none', () => {
    const one = {
      id: 10221,
      downloads: { instructions: ['2182025Fold-Wall-userassembly_1739921311106.pdf'] },
    } as unknown as CatalogProduct;
    expect(instructionUrls(one)).toBe(
      'https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/10221/downloads/2182025Fold-Wall-userassembly_1739921311106.pdf',
    );
    // Multiple files → `; `-joined, order preserved.
    const many = { id: 500, downloads: { instructions: ['a.pdf', 'b.pdf'] } } as unknown as CatalogProduct;
    expect(instructionUrls(many)).toBe(
      'https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/500/downloads/a.pdf; ' +
        'https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/500/downloads/b.pdf',
    );
    // Empty / missing / null → blank.
    expect(instructionUrls({ id: 1, downloads: { instructions: [] } } as unknown as CatalogProduct)).toBe('');
    expect(instructionUrls({ id: 1, downloads: null } as unknown as CatalogProduct)).toBe('');
  });

  it('expandRows derives a sku when defaultSku is missing', () => {
    const product = {
      id: 500,
      size: { code: 'lg' },
      colors: [{ code: 'red', name: 'Red' }],
    } as unknown as CatalogProduct;
    const rows = expandRows([product], 'sku');
    expect(rows).toHaveLength(1);
    expect(rows[0].sku).toBe('500-lg-red');
    expect(rows[0].colorName).toBe('Red');
  });

  it('parseProductRow maps fields by name', () => {
    const p = parseProductRow(FIELDS, lagoRow());
    expect(p.id).toBe(10018);
    expect(p.designerName).toBe('Temporal Studio');
    expect(p.colors).toHaveLength(2);
    expect(p.specs?.price).toBe(24800);
    // Regression guard: the json `downloads`/`skuAssets` columns come back from
    // Grafana as already-parsed nested objects — ensureObject must pass them
    // through intact so the URL builders can read instructions + cached cut
    // sheets (the field the old marker code never touched).
    expect(p.downloads?.instructions).toEqual(['10018-install-instructions_1740000000000.pdf']);
    expect(p.skuAssets?.['10018-cm-snow']?.cutSheet).toBe('10018-cm-snow-cut-sheet_1779271198808.pdf');
    expect(p.isPainted).toBe(false);
  });

  it('productColorOptions returns all available colors (painted) or the designer subset (fallback)', () => {
    // Painted → full palette for the category, each with a SKU (designer
    // defaultSku where known, else derived).
    const painted = {
      id: 10018,
      size: { code: 'cm' },
      category: 'Table Light',
      isPainted: true,
      colors: [{ code: 'snow', name: 'Snow', defaultSku: '10018-cm-snow' }],
    } as unknown as CatalogProduct;
    const opts = productColorOptions(painted);
    expect(opts.length).toBeGreaterThan(1);
    const snow = opts.find((o) => o.code === 'snow')!;
    expect(snow.sku).toBe('10018-cm-snow'); // authoritative defaultSku
    const carbon = opts.find((o) => o.code === 'carbon')!;
    expect(carbon.name).toBe('Carbon');
    expect(carbon.sku).toBe('10018-cm-carbon'); // derived
    expect(opts.some((o) => o.code === 'gantri')).toBe(false); // gantri excluded
    expect(opts.some((o) => o.code === 'coral')).toBe(false); // archived excluded

    // Non-painted → falls back to the designer subset, unchanged.
    const nonPainted = { ...painted, isPainted: false } as unknown as CatalogProduct;
    expect(productColorOptions(nonPainted)).toEqual([
      { code: 'snow', name: 'Snow', sku: '10018-cm-snow' },
    ]);
  });

  it('productColorOptions preserves cord/rod variant segments when deriving SKUs', () => {
    // A pendant whose default SKU carries a cord variant. Derived colors must
    // keep that suffix (only the color segment changes) — not collapse to
    // {id}-{size}-{color}.
    const pendant = {
      id: 10072,
      size: { code: 'sm' },
      category: 'Pendant Light',
      isPainted: true,
      colors: [{ code: 'canyon', name: 'Canyon', defaultSku: '10072-sm-canyon-white_cord_1_4_feet' }],
    } as unknown as CatalogProduct;
    const opts = productColorOptions(pendant);
    expect(opts.find((o) => o.code === 'canyon')!.sku).toBe('10072-sm-canyon-white_cord_1_4_feet');
    // carbon has no defaultSku → derived from the template, cord suffix intact.
    expect(opts.find((o) => o.code === 'carbon')!.sku).toBe('10072-sm-carbon-white_cord_1_4_feet');
    expect(opts.find((o) => o.code === 'sage')!.sku).toBe('10072-sm-sage-white_cord_1_4_feet');
  });

  it('productColorOptions encodes a missing size as "0" when there is no template SKU', () => {
    // Painted, colors have codes but no defaultSku (no template), no size code.
    const p = {
      id: 500,
      size: null,
      category: 'Table Light',
      isPainted: true,
      colors: [],
    } as unknown as CatalogProduct;
    const opts = productColorOptions(p);
    expect(opts.find((o) => o.code === 'snow')!.sku).toBe('500-0-snow');
  });

  it('swapSkuColor replaces only the color segment', () => {
    expect(swapSkuColor('10072-sm-canyon-white_cord_1_4_feet', 'carbon')).toBe('10072-sm-carbon-white_cord_1_4_feet');
    expect(swapSkuColor('123456-sm-carbon-chrome_rod_finish-white_cord_color', 'snow')).toBe(
      '123456-sm-snow-chrome_rod_finish-white_cord_color',
    );
    expect(swapSkuColor('10018-cm-snow', 'carbon')).toBe('10018-cm-carbon');
    // Malformed / unexpectedly-delimited templates (< 3 "-" segments) → null so
    // the caller falls back to deriveSku instead of emitting a bad SKU.
    expect(swapSkuColor('10018-snow', 'carbon')).toBeNull();
    expect(swapSkuColor('10072_sm_canyon_variant', 'carbon')).toBeNull();
  });

  it('productColorOptions falls back to deriveSku when the template SKU is malformed', () => {
    // Designer defaultSku is malformed (no size segment) → non-designer colors
    // must NOT inherit the bad shape; they fall back to {id}-{size}-{color}.
    const p = {
      id: 10018,
      size: { code: 'cm' },
      category: 'Table Light',
      isPainted: true,
      colors: [{ code: 'snow', name: 'Snow', defaultSku: '10018-snow' }], // malformed (2 segments)
    } as unknown as CatalogProduct;
    const opts = productColorOptions(p);
    expect(opts.find((o) => o.code === 'snow')!.sku).toBe('10018-snow'); // authoritative kept as-is
    expect(opts.find((o) => o.code === 'carbon')!.sku).toBe('10018-cm-carbon'); // safe fallback, not '10018-snow-carbon'
  });

  it('productImagesArchiveUrl signs the sorted params, excluding api_key and the secret', () => {
    const url = productImagesArchiveUrl({
      productId: 10501,
      apiKey: 'key123',
      apiSecret: 'secret456',
      timestamp: 1_700_000_000,
      expiresAt: 1_731_536_000,
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://api.cloudinary.com/v1_1/gantri/image/generate_archive');
    const q = parsed.searchParams;
    expect(q.get('mode')).toBe('download');
    expect(q.get('prefixes')).toBe('dynamic-assets/gantri/products/10501/');
    expect(q.get('expires_at')).toBe('1731536000');
    expect(q.get('timestamp')).toBe('1700000000');
    expect(q.get('transformations')).toBe('c_limit,w_2400,q_auto:good,f_jpg');
    expect(q.get('skip_transformation_name')).toBe('true');
    expect(q.get('target_public_id')).toBe('gantri-product-10501-images');
    expect(q.get('api_key')).toBe('key123');

    // Cloudinary signature: SHA-1 over sorted key=value params (WITHOUT
    // api_key/signature) + secret appended.
    const expected = createHash('sha1')
      .update(
        [
          'expires_at=1731536000',
          'mode=download',
          'prefixes=dynamic-assets/gantri/products/10501/',
          'skip_transformation_name=true',
          'target_public_id=gantri-product-10501-images',
          'timestamp=1700000000',
          'transformations=c_limit,w_2400,q_auto:good,f_jpg',
        ].join('&') + 'secret456',
      )
      .digest('hex');
    expect(q.get('signature')).toBe(expected);

    // Same params with a different api_key → same signature (api_key is not
    // part of the signed string).
    const other = new URL(
      productImagesArchiveUrl({
        productId: 10501,
        apiKey: 'DIFFERENT',
        apiSecret: 'secret456',
        timestamp: 1_700_000_000,
        expiresAt: 1_731_536_000,
      }),
    );
    expect(other.searchParams.get('signature')).toBe(expected);
  });

  it('productHasPhotos detects any white-background photo across SKUs', () => {
    expect(productHasPhotos({ skuAssets: { a: { selectedWhiteBackgroundPhoto: 'x.jpg' } } } as unknown as CatalogProduct)).toBe(true);
    expect(productHasPhotos({ skuAssets: { a: { whiteBackgroundPhotos: ['y.jpg'] } } } as unknown as CatalogProduct)).toBe(true);
    expect(productHasPhotos({ skuAssets: { a: { whiteBackgroundPhotos: [] } } } as unknown as CatalogProduct)).toBe(false);
    expect(productHasPhotos({ skuAssets: { a: {} } } as unknown as CatalogProduct)).toBe(false);
    expect(productHasPhotos({ skuAssets: null } as unknown as CatalogProduct)).toBe(false);
  });

  it('toBool coerces Postgres/Grafana booleans', () => {
    for (const t of [true, 't', 'true', 1, '1']) expect(toBool(t)).toBe(true);
    for (const f of [false, 'f', 'false', 0, '0', null, undefined, '']) expect(toBool(f)).toBe(false);
  });
});
