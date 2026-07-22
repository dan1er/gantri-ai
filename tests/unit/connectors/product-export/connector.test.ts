import { describe, it, expect, vi } from 'vitest';
import Papa from 'papaparse';
import {
  ProductExportConnector,
  buildCatalogSql,
  parseProductRow,
  expandRows,
  parsePgJsonArray,
  splitPgArrayLiteral,
  ensureObject,
  dollars,
  listPrice,
  productUrl,
  escapeSql,
  decodeBulb,
  certification,
  imageEntries,
  hyperlinkCell,
  cutSheetUrl,
  instructionUrls,
  fullProductName,
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
  'colors', 'size', 'specs', 'downloads', 'skuPrices', 'skuAssets',
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
    { '10018-cm-carbon': 26800 },
    {
      // snow has a cached cut-sheet PDF filename; carbon does not (→ sibling fallback).
      '10018-cm-snow': {
        selectedWhiteBackgroundPhoto: '10018-cm-snow--product-photos-abc.jpg',
        cutSheet: '10018-cm-snow-cut-sheet_1779271198808.pdf',
      },
      '10018-cm-carbon': { whiteBackgroundPhotos: ['10018-cm-carbon--product-photos-def.jpg'] },
    },
  ];
}

function giftCardRow(): unknown[] {
  return [
    99, 'Gift Card', null, null, null, 'Active', 'Gift Card',
    null, null, null, null,
    '{}', // no colors
    null, null, null, null, null,
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
    null,
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
    null,
  ];
}

function makeConnector(runSqlImpl: () => Promise<{ fields: string[]; rows: unknown[][] }>) {
  const grafana = { runSql: vi.fn(runSqlImpl) } as unknown as GrafanaConnector;
  return { connector: new ProductExportConnector({ grafana }), grafana };
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
        'SKU', 'List Price (USD)', 'Product URL', 'Return Policy', 'Bulb Type', 'Certification', 'Image',
        'CRI', 'Voltage', 'Dimmer Type', 'Cut Sheet URL', 'Install Instructions URLs',
      ]),
    );
    // Every fixture SKU here has exactly one photo → a single "Image" column.
    expect(headers).toContain('Image');
    expect(headers).not.toContain('Image URL');
    // Old availability markers are gone — replaced by URL-bearing columns.
    expect(headers).not.toContain('Cut Sheet');
    expect(headers).not.toContain('Install Instructions');

    const snow = rows.find((r) => r.SKU === '10018-cm-snow')!;
    const carbon = rows.find((r) => r.SKU === '10018-cm-carbon')!;
    expect(snow).toBeTruthy();
    expect(carbon).toBeTruthy();

    // specs.price (24800c → 248.00) for the base SKU…
    expect(snow['List Price (USD)']).toBe('248.00');
    // …and the per-SKU skuPrices override (26800c → 268.00) for carbon.
    expect(carbon['List Price (USD)']).toBe('268.00');

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
    // Image cell = a clickable HYPERLINK showing the filename, linking to the
    // Cloudinary photo built from skuAssets (no manual Google Drive link).
    expect(snow.Image).toBe(
      '=HYPERLINK("https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/10018/10018-cm-snow/product-photos/10018-cm-snow--product-photos-abc.jpg","10018-cm-snow--product-photos-abc.jpg")',
    );
    expect(carbon.Image).toBe(
      '=HYPERLINK("https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/10018/10018-cm-carbon/product-photos/10018-cm-carbon--product-photos-def.jpg","10018-cm-carbon--product-photos-def.jpg")',
    );
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

  it('defaults to one row per product, aggregating all SKUs, colors and images', async () => {
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
    // Two photos (snow + carbon) → two Image columns.
    expect(result.imageColumns).toBe(2);

    const rows = parseCsv(result.attachment.content);
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // Every SKU and color aggregated into single "; "-joined cells.
    expect(row.SKU).toBe('10018-cm-snow; 10018-cm-carbon');
    expect(row.Color).toBe('Snow; Carbon');
    // Every image we have — both SKUs' photos — one clickable name link per
    // "Image N" column (a cell holds at most one link, so one column per image).
    expect(row['Image 1']).toBe(
      '=HYPERLINK("https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/10018/10018-cm-snow/product-photos/10018-cm-snow--product-photos-abc.jpg","10018-cm-snow--product-photos-abc.jpg")',
    );
    expect(row['Image 2']).toBe(
      '=HYPERLINK("https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/10018/10018-cm-carbon/product-photos/10018-cm-carbon--product-photos-def.jpg","10018-cm-carbon--product-photos-def.jpg")',
    );
    // Product-level fields stay singular: base list price + bare product URL
    // (no per-SKU override, no ?sku= query).
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

  it('colorless products still export as one product row (empty SKU/Color cells)', async () => {
    const { connector } = makeConnector(async () => ({ fields: FIELDS, rows: [giftCardRow()] }));
    const result: any = await connector.tools[0].execute({
      status: 'Active',
      granularity: 'product',
      includeInternalCost: false,
    });
    expect(result.rowsExported).toBe(1);
    // No photos anywhere → still exactly one (empty) Image column.
    expect(result.imageColumns).toBe(1);
    const row = parseCsv(result.attachment.content)[0];
    expect(row['Product Name']).toBe('Gift Card');
    expect(row.SKU).toBe('');
    expect(row.Color).toBe('');
    expect(row.Image).toBe('');
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
    expect(sql).toContain('"skuPrices"');
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

  it('listPrice prefers a positive skuPrices override over specs.price', () => {
    const p = {
      specs: { price: 24800 },
      skuPrices: { '10018-cm-carbon': 26800, '10018-cm-zero': 0 },
    } as unknown as CatalogProduct;
    expect(listPrice(p, '10018-cm-snow')).toBe('248.00'); // no override → base
    expect(listPrice(p, '10018-cm-carbon')).toBe('268.00'); // override
    expect(listPrice(p, '10018-cm-zero')).toBe('248.00'); // zero override ignored

    // No price set (e.g. accessories with specs.price 0 / null) → blank.
    expect(listPrice({ specs: { price: 0 }, skuPrices: null } as unknown as CatalogProduct, 'x')).toBe('');
    expect(listPrice({ specs: {}, skuPrices: null } as unknown as CatalogProduct, 'x')).toBe('');
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

  it('hyperlinkCell renders a HYPERLINK formula and strips quotes', () => {
    expect(hyperlinkCell('https://x/y.jpg', 'y.jpg')).toBe('=HYPERLINK("https://x/y.jpg","y.jpg")');
    // Stray quotes in url/text are stripped so they can't break the formula.
    expect(hyperlinkCell('https://x/a"b.jpg', 'a"b.jpg')).toBe('=HYPERLINK("https://x/ab.jpg","ab.jpg")');
  });

  it('imageEntries returns the single SKU photo at sku granularity', () => {
    const product = {
      id: 10018,
      skuAssets: {
        '10018-cm-snow': { selectedWhiteBackgroundPhoto: 'x.jpg' },
        '10018-cm-fog': { whiteBackgroundPhotos: ['y.jpg'] },
        '10018-cm-bare': {},
      },
    } as unknown as CatalogProduct;
    // sku granularity: ctx.skus undefined → only the ctx.sku's photos.
    expect(imageEntries({ product, sku: '10018-cm-snow' } as any)).toEqual([
      {
        url: 'https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/10018/10018-cm-snow/product-photos/x.jpg',
        name: 'x.jpg',
      },
    ]);
    expect(imageEntries({ product, sku: '10018-cm-fog' } as any)[0].name).toBe('y.jpg');
    expect(imageEntries({ product, sku: '10018-cm-bare' } as any)).toEqual([]);
    expect(imageEntries({ product, sku: '' } as any)).toEqual([]);
  });

  it('imageEntries unions every SKU photo at product granularity, deduped and order-stable', () => {
    const product = {
      id: 10018,
      skuAssets: {
        // selected also appears in the gallery → deduped to one entry.
        '10018-cm-snow': { selectedWhiteBackgroundPhoto: 'a.jpg', whiteBackgroundPhotos: ['a.jpg', 'b.jpg'] },
        '10018-cm-fog': { whiteBackgroundPhotos: ['c.jpg'] },
        '10018-cm-bare': {}, // no photos → contributes nothing
      },
    } as unknown as CatalogProduct;
    // product granularity is signalled by ctx.skus being present (any array).
    const entries = imageEntries({ product, sku: '', skus: [] } as any);
    expect(entries.map((e) => e.name)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(entries[0].url).toBe(
      'https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/10018/10018-cm-snow/product-photos/a.jpg',
    );
    // No skuAssets → no entries.
    expect(imageEntries({ product: { id: 1, skuAssets: null }, sku: '', skus: [] } as any)).toEqual([]);
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
    expect(p.skuPrices).toEqual({ '10018-cm-carbon': 26800 });
    // Regression guard: the json `downloads`/`skuAssets` columns come back from
    // Grafana as already-parsed nested objects — ensureObject must pass them
    // through intact so the URL builders can read instructions + cached cut
    // sheets (the field the old marker code never touched).
    expect(p.downloads?.instructions).toEqual(['10018-install-instructions_1740000000000.pdf']);
    expect(p.skuAssets?.['10018-cm-snow']?.cutSheet).toBe('10018-cm-snow-cut-sheet_1779271198808.pdf');
  });
});
