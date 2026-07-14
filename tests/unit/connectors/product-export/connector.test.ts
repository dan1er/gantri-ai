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
  primaryImageUrl,
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
    { cutSheet: { isConfigured: true }, instructions: [], models2D: [], models3D: [] },
    { '10018-cm-carbon': 26800 },
    {
      '10018-cm-snow': { selectedWhiteBackgroundPhoto: '10018-cm-snow--product-photos-abc.jpg' },
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
        'SKU', 'List Price (USD)', 'Product URL', 'Return Policy', 'Bulb Type', 'Certification', 'Image URL',
        'CRI', 'Voltage', 'Dimmer Type',
      ]),
    );

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
    expect(snow['Cut Sheet']).toBe('Available');

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
    // Image URL built from existing skuAssets photo (no manual Google Drive link).
    expect(snow['Image URL']).toBe(
      'https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/10018/10018-cm-snow/product-photos/10018-cm-snow--product-photos-abc.jpg',
    );
    expect(carbon['Image URL']).toBe(
      'https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/10018/10018-cm-carbon/product-photos/10018-cm-carbon--product-photos-def.jpg',
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

  it('collapses to one row per product at product granularity', async () => {
    const { connector } = makeConnector(async () => ({ fields: FIELDS, rows: [lagoRow()] }));
    const result: any = await connector.tools[0].execute({
      status: 'Active',
      granularity: 'product',
      includeInternalCost: false,
    });
    expect(result.rowsExported).toBe(1);
    const rows = parseCsv(result.attachment.content);
    expect(rows).toHaveLength(1);
    expect(rows[0].SKU).toBe('');
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

  it('primaryImageUrl builds a Cloudinary URL from skuAssets, blank when absent', () => {
    const p = {
      id: 10018,
      skuAssets: {
        '10018-cm-snow': { selectedWhiteBackgroundPhoto: 'x.jpg' },
        '10018-cm-fog': { whiteBackgroundPhotos: ['y.jpg'] },
        '10018-cm-bare': {},
      },
    } as unknown as CatalogProduct;
    expect(primaryImageUrl(p, '10018-cm-snow')).toBe(
      'https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products/10018/10018-cm-snow/product-photos/x.jpg',
    );
    expect(primaryImageUrl(p, '10018-cm-fog')).toContain('/10018-cm-fog/product-photos/y.jpg');
    expect(primaryImageUrl(p, '10018-cm-bare')).toBe('');
    expect(primaryImageUrl(p, '')).toBe('');
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
  });
});
