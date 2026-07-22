import Papa from 'papaparse';
import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import { normalizeFilename, type ReportAttachment } from '../reports/reports-connector.js';
import type { GrafanaConnector } from '../grafana/grafana-connector.js';
import { logger } from '../../logger.js';

/**
 * `products.export_catalog` — builds a wholesale-partner product CSV straight
 * from the Porter prod read-replica (via the Grafana SQL proxy) and returns it
 * as a downloadable Slack attachment.
 *
 * Background: Sales needs to hand wholesale partners an up-to-date
 * spec sheet of our products during onboarding. This tool covers everything
 * Porter stores TODAY (name, SKUs, dimensions, materials, list price, lead
 * time, bulb info, product/image URLs, and browser-clickable cut-sheet +
 * install-instruction PDF URLs). The richer per-spec columns
 * the ticket asks for (structured wattage/lumens/CRI/color-temp, dimmable,
 * UL/ADA ratings, canopy dims, Google Drive photo link) require Porter schema
 * additions + manual data entry in FactoryOS and light up automatically once
 * those columns exist.
 *
 * Output is ONE row per product by default: the SKU, Color and Images columns
 * each aggregate every variant into a single "; "-joined cell (all SKUs, all
 * colors, and every product photo filename we have). `granularity: 'sku'` instead
 * emits one row per color/SKU variant.
 *
 * Why one tool (not `grafana.sql` + `reports.attach_file`): the SKU/color/image
 * aggregation (Postgres `colors` text[] of JSON strings), the nested `specs`
 * JSON extraction, the cents→dollars price conversion, and the exact
 * partner-safe column ordering are all deterministic and easy to get subtly
 * wrong if left to the LLM. Keeping it server-side guarantees a stable,
 * correct CSV every time.
 *
 * Cost/royalty fields (`specs.manufacturerPrice`, `specs.royalty`) are INTERNAL
 * and excluded by default — they must never leak to a wholesale partner. They
 * are only included when `includeInternalCost: true` is set explicitly for an
 * internal pull.
 */
export interface ProductExportConnectorDeps {
  grafana: GrafanaConnector;
}

// ---------------------------------------------------------------------------
// Company-standard policy values. These are uniform across the catalog and
// match the NOT-NULL defaults Porter PR #4954 backfills onto every product
// (returnPolicy / warranty / countryOfOrigin). Emitting them as constants
// lets the wholesale CSV be complete today; when the per-product columns land
// in Porter the connector can switch to reading them per row.
// ---------------------------------------------------------------------------
export const WHOLESALE_DEFAULTS = {
  returnPolicy: 'Free returns within 30 days of delivery',
  warranty: 'Standard 3 year',
  countryOfOrigin: 'USA',
  // Company-standard electrical defaults provided by Sales. Uniform across the
  // catalog today; emitted only for products where they apply (see BASE_COLUMNS).
  cri: '90',
  voltage: '120V',
  dimmerType: 'Triac Dimmer',
} as const;

const PRODUCT_URL_BASE = 'https://www.gantri.com/products';
/** Public Cloudinary base for product assets — photos, cut-sheet PDFs and
 *  download PDFs all live under this prefix (PDFs are served via image/upload).
 *  Verified against the live PDP + Porter's cut-sheet output. */
const IMAGE_URL_BASE = 'https://res.cloudinary.com/gantri/image/upload/dynamic-assets/gantri/products';
/** Hard ceiling on the generated CSV — matches the `reports.attach_file`
 *  content cap (reports-connector.ts). At ~121 active products this is moot,
 *  but a `status:'all'` pull on a much larger catalog could approach it. */
const MAX_CSV_BYTES = 1_900_000;
const MAX_ROWS = 5000;

// Categories that ship with integrated/installed power (no plug-in cord-set).
// Ported from mantle (src/constants/{wireless,hardwired}-categories.ts) — used
// to derive Certification the same way the PDP does.
const WIRELESS_CATEGORIES = new Set([
  'Wireless Floor Lantern',
  'Wireless Mini Light',
  'Wireless Table Light',
  'Wireless Task Light',
]);
const HARDWIRED_CATEGORIES = new Set(['Flush Mount', 'Pendant Light', 'Wall Sconce']);

/**
 * Decodes the `specs.bulb` SKU-format code (e.g. "E26, T8, 94mm") into the
 * human bulb description shown on the PDP. Ported verbatim from mantle's
 * `BULB_NAME_MAPPINGS` (src/modules/shop/product/sections/details/details.constants.ts).
 * KEEP IN SYNC with mantle — when a new bulb code ships there, mirror it here.
 */
const BULB_NAME_MAPPINGS: Record<string, string[]> = {
  '2x E12, T6, 65mm': ['2x E12 LED Dimmable Bulb (included)', '2700K Color Temperature', '600 Lumens, 6.4W'],
  'E12, T13, 42mm': ['E12 LED Dimmable Bulb (included)', '2700K Color Temperature', '802 Lumens, 7W'],
  'E12, T6, 65mm': ['E12 LED Dimmable Bulb (included)', '2700K Color Temperature', '600 Lumens, 6.4W'],
  'E12, T8, 94mm': ['E12 LED Dimmable Bulb (included)', '2700K Color Temperature', '850 Lumens, 8.5W'],
  'E26, A15': ['E26 LED Dimmable Bulb (included)', '2700K Color Temperature'],
  'E26, A19': ['E26 LED Dimmable Bulb (included)', '2700K Color Temperature'],
  'E26, A19, 109mm, 10W': ['E26 LED Dimmable Bulb (included)', '2700K Color Temperature', '800 Lumens, 10W'],
  'E26, A19, 112mm, 13W': ['E26 LED Dimmable Bulb (included)', '2700K Color Temperature', '1100 Lumens, 13W'],
  'E26, A21': ['E26 LED Dimmable Bulb (included)', '2700K Color Temperature'],
  'E26, BR20': ['E26 LED Dimmable Bulb (included)', '2700K Color Temperature', '525 Lumens, 7W'],
  'E26, BR30': ['E26 LED Dimmable Bulb (included)', '2700K Color Temperature', '650 Lumens, 8W'],
  'E26, G25': ['E26 LED Dimmable Bulb (included)', '2700K Color Temperature', '800 Lumens, 10W'],
  'E26, T8, 112mm': ['E26 LED Dimmable Bulb (included)', '2700K Color Temperature', '950 Lumens, 9.5W'],
  'E26, T8, 94mm': ['E26 LED Dimmable Bulb (included)', '2700K Color Temperature', '850 Lumens, 8.5W'],
  'LED PANEL, 110mm': ['Integrated LED Panel, Dimmable', '2700K-5000K Color Temperature', '1500 Lumens, 15W', '', 'Bulb not replaceable for integrated LED.'],
  'LED PANEL, 130mm': ['Integrated LED Panel, Dimmable', '2700K Color Temperature', '1500 Lumens, 15W', '', 'Bulb not replaceable for integrated LED.'],
};

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const Args = z.object({
  status: z
    .enum(['Active', 'all'])
    .default('Active')
    .describe('Which products to include. "Active" (default) = currently-sold catalog; "all" = every product regardless of status.'),
  category: z
    .union([z.string().min(1).max(60), z.array(z.string().min(1).max(60)).min(1).max(20)])
    .optional()
    .describe(
      'Optional category filter — either a single category name OR an array of them, all exported into ONE CSV. ' +
        'Valid categories: Accessory, Clamp Light, Floor Light, Gift Card, Pendant Light, Table Light, Wall Light, Wall Sconce, ' +
        'Flush Mount, Wireless Floor Lantern, Wireless Mini Light, Wireless Table Light, Wireless Task Light. ' +
        '"Wireless lights" is not one category — it spans four (Wireless Floor Lantern / Wireless Mini Light / Wireless Table Light / Wireless Task Light); pass them together as an array in a single call.',
    ),
  productIds: z
    .array(z.number().int().positive())
    .max(2000)
    .optional()
    .describe('Optional explicit product-id allow-list. When set, only these products are exported (status/category still apply).'),
  productNameContains: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('Optional case-insensitive substring match on product name.'),
  granularity: z
    .enum(['sku', 'product'])
    .default('product')
    .describe(
      '"product" (default) = ONE row per product, with every SKU, every color and every image URL aggregated into single "; "-joined cells. ' +
        '"sku" = one row per color/SKU variant (a separate row for each color).',
    ),
  includeInternalCost: z
    .boolean()
    .default(false)
    .describe('INTERNAL ONLY. When true, appends Manufacturer Price + Royalty columns. NEVER enable for a CSV shared with a wholesale partner.'),
});
type Args = z.infer<typeof Args>;

// ---------------------------------------------------------------------------
// Parsed shapes
// ---------------------------------------------------------------------------

interface ColorShape {
  code?: string;
  name?: string;
  defaultSku?: string;
}

interface SpecsShape {
  /** Canonical retail price in CENTS (team-verified source — see prompts.ts).
   *  Top-level `Products.price` is a legacy field set on only ~6 products. */
  price?: number | null;
  bulb?: string | null;
  compatibleWith?: string[] | null;
  material?: string | null;
  weight?: number | null;
  cableLength?: number | null;
  manufacturerPrice?: number | null;
  royalty?: number | null;
  dimensions?: { width?: number; height?: number; depth?: number } | null;
  footPrint?: { width?: number; height?: number; depth?: number } | null;
  backplate?: { width?: number; height?: number } | null;
}

interface DownloadsShape {
  cutSheet?: { isConfigured?: boolean } | null;
  instructions?: unknown[] | null;
  models2D?: unknown[] | null;
  models3D?: unknown[] | null;
}

export interface CatalogProduct {
  id: number;
  name: string;
  category: string | null;
  subCategory: string | null;
  designerName: string | null;
  status: string;
  type: string | null;
  summary: string | null;
  description: string | null;
  leadTime: number | null;
  leadTimeOption: string | null;
  size: { code?: string; name?: string } | null;
  specs: SpecsShape | null;
  downloads: DownloadsShape | null;
  /** Per-SKU asset filenames (photos), keyed by sku. Used to build image URLs. */
  skuAssets: Record<string, SkuAssetShape> | null;
  colors: ColorShape[];
}

interface SkuAssetShape {
  selectedWhiteBackgroundPhoto?: string | null;
  whiteBackgroundPhotos?: string[] | null;
  /** Cached cut-sheet PDF filename. Porter generates the cut-sheet PDF lazily
   *  (on first PDP download) and writes its Cloudinary filename here; it is the
   *  read-only source for the browser-clickable Cut Sheet URL. */
  cutSheet?: string | null;
}

/** Structured bulb specs decoded from `specs.bulb` (mirrors the PDP). */
export interface BulbInfo {
  type: string;
  base: string;
  quantity: string;
  wattage: string;
  lumens: string;
  colorTemp: string;
  dimmable: string;
  included: string;
}

/** One expanded export row. In 'sku' granularity it is a single product×sku
 *  pair; in 'product' granularity it is one product with `skus`/`colorNames`
 *  carrying every variant, aggregated into single cells by the columns. */
interface RowContext {
  product: CatalogProduct;
  sku: string;
  colorName: string;
  bulb: BulbInfo;
  /** Present only at 'product' granularity: every SKU / color of the product,
   *  in catalog order. Their presence is what flips the SKU/Color/Image columns
   *  from single-value to aggregated. */
  skus?: string[];
  colorNames?: string[];
}

// ---------------------------------------------------------------------------
// Column definitions — ordered. Each value extractor returns a plain string;
// papaparse handles quoting/escaping (incl. the newlines inside `material`).
// ---------------------------------------------------------------------------

interface ColumnDef {
  header: string;
  value: (ctx: RowContext) => string;
}

const BASE_COLUMNS: ColumnDef[] = [
  { header: 'Product ID', value: (c) => String(c.product.id) },
  { header: 'Product Name', value: (c) => fullProductName(c.product) },
  { header: 'Designer', value: (c) => c.product.designerName ?? '' },
  { header: 'Category', value: (c) => c.product.category ?? '' },
  { header: 'Sub Category', value: (c) => c.product.subCategory ?? '' },
  { header: 'Size', value: (c) => c.product.size?.name ?? '' },
  // At 'product' granularity these hold every SKU / color of the product,
  // "; "-joined into one cell; at 'sku' granularity, the single variant.
  { header: 'SKU', value: (c) => (c.skus ? c.skus.join('; ') : c.sku) },
  { header: 'Color', value: (c) => (c.colorNames ? c.colorNames.join('; ') : c.colorName) },
  { header: 'Status', value: (c) => c.product.status ?? '' },
  { header: 'List Price (USD)', value: (c) => listPrice(c.product) },
  { header: 'Lead Time', value: (c) => leadTime(c.product) },
  { header: 'Summary', value: (c) => c.product.summary ?? '' },
  { header: 'Description', value: (c) => c.product.description ?? '' },
  { header: 'Material', value: (c) => c.product.specs?.material ?? '' },
  { header: 'Bulb Code', value: (c) => c.product.specs?.bulb ?? '' },
  { header: 'Bulb Type', value: (c) => c.bulb.type },
  { header: 'Bulb Base', value: (c) => c.bulb.base },
  { header: 'Bulb Quantity', value: (c) => c.bulb.quantity },
  { header: 'Wattage', value: (c) => c.bulb.wattage },
  { header: 'Lumens', value: (c) => c.bulb.lumens },
  { header: 'Color Temperature', value: (c) => c.bulb.colorTemp },
  // Company-standard default: every Gantri light source is CRI 90. Applies to
  // any product with a bulb code; blank for accessories / gift cards.
  { header: 'CRI', value: (c) => (c.product.specs?.bulb ? WHOLESALE_DEFAULTS.cri : '') },
  { header: 'Dimmable', value: (c) => c.bulb.dimmable },
  // Wall-dimmer compatibility. Wireless lights dim via integrated touch/app
  // control, not a wall Triac dimmer, so they are excluded.
  {
    header: 'Dimmer Type',
    value: (c) =>
      c.bulb.dimmable === 'Yes' && !WIRELESS_CATEGORIES.has(c.product.category ?? '')
        ? WHOLESALE_DEFAULTS.dimmerType
        : '',
  },
  { header: 'Bulb Included', value: (c) => c.bulb.included },
  {
    header: 'Compatible Bulbs',
    value: (c) => (c.product.specs?.compatibleWith ?? []).filter(Boolean).join('; '),
  },
  { header: 'Certification', value: (c) => certification(c.product.category) },
  // Company-standard default: corded/hardwired lights run on 120V US mains.
  // Wireless fixtures are battery-powered, so no line voltage applies.
  {
    header: 'Voltage',
    value: (c) =>
      c.product.specs?.bulb && !WIRELESS_CATEGORIES.has(c.product.category ?? '')
        ? WHOLESALE_DEFAULTS.voltage
        : '',
  },
  { header: 'Dimensions (in, H x W x D)', value: (c) => dimsHWD(c.product.specs?.dimensions) },
  { header: 'Footprint (in, W x D)', value: (c) => footprintWD(c.product.specs?.footPrint) },
  { header: 'Backplate (in, W x H)', value: (c) => backplateWH(c.product.specs?.backplate) },
  // No data source yet for the columns below — they exist so the CSV template
  // matches the requested wholesale field list; they export blank until the
  // data is captured in FactoryOS.
  { header: 'Backplate Shape', value: () => '' },
  { header: 'Backplate Material', value: () => '' },
  // Pendant/hardwired-only fields, no source yet.
  { header: 'Canopy Dimensions', value: () => '' },
  { header: 'Canopy Shape', value: () => '' },
  { header: 'Canopy Material', value: () => '' },
  { header: 'Hanging Dimensions', value: () => '' },
  { header: 'Cord Length (in)', value: (c) => numOrBlank(c.product.specs?.cableLength) },
  { header: 'Weight (lb)', value: (c) => numOrBlank(c.product.specs?.weight) },
  // No source anywhere yet for shipping-box specs.
  { header: 'Shipping Box Dimensions (in, L x W x H)', value: () => '' },
  { header: 'Shipping Box Weight (lb)', value: () => '' },
  { header: 'Return Policy', value: () => WHOLESALE_DEFAULTS.returnPolicy },
  { header: 'Warranty', value: () => WHOLESALE_DEFAULTS.warranty },
  { header: 'Country of Origin', value: () => WHOLESALE_DEFAULTS.countryOfOrigin },
  { header: 'Product URL', value: (c) => productUrl(c.product.id, c.sku) },
  // Image filenames, "; "-joined. At 'product' granularity: every photo across
  // all of the product's SKUs; at 'sku' granularity: the single SKU's photo(s).
  { header: 'Images', value: (c) => imageNames(c) },
  { header: 'Cut Sheet URL', value: (c) => cutSheetUrl(c.product, c.sku) },
  { header: 'Install Instructions URLs', value: (c) => instructionUrls(c.product) },
];

const INTERNAL_COST_COLUMNS: ColumnDef[] = [
  { header: 'Manufacturer Price (USD)', value: (c) => dollars(c.product.specs?.manufacturerPrice ?? null) },
  { header: 'Royalty (%)', value: (c) => numOrBlank(c.product.specs?.royalty) },
];

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class ProductExportConnector implements Connector {
  readonly name = 'products';
  readonly tools: readonly ToolDef[];

  constructor(private readonly deps: ProductExportConnectorDeps) {
    this.tools = this.buildTools();
  }

  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  private buildTools(): ToolDef[] {
    const exportCatalog: ToolDef<Args> = {
      name: 'products.export_catalog',
      description: [
        'Export Gantri product catalog data as a downloadable CSV attachment. Use this whenever the user asks for a product spec sheet / catalog / price list / "product data to share with a wholesale partner" / "export our products as a CSV".',
        '',
        'ONE row per product by default — the SKU, Color and Images columns each aggregate ALL of the product\'s variants into a single "; "-joined cell (every SKU, every color, and every product photo filename we have). Columns: product name, designer, category, size, SKU(s), color(s), status, list price (USD), lead time, summary, description, material, recommended + compatible bulbs, dimensions, footprint, backplate, cord length, weight, return policy, warranty, country of origin, product URL, image filenames, and browser-clickable cut-sheet + install-instruction PDF URLs.',
        '',
        'Filters: `status` (Active default, or "all"), `category` (single name or array — see below), `productIds` (explicit allow-list), `productNameContains`, `granularity` ("product" default = one row per product | "sku" = one row per color/SKU variant).',
        '',
        'CATEGORIES: `category` accepts a single category name OR an array of names — all exported into ONE CSV. Valid categories: Accessory, Clamp Light, Floor Light, Gift Card, Pendant Light, Table Light, Wall Light, Wall Sconce, Flush Mount, Wireless Floor Lantern, Wireless Mini Light, Wireless Table Light, Wireless Task Light. "Wireless lights" is NOT a single category — it spans four; export them together, e.g. "our wireless lights" → ONE call with category: ["Wireless Floor Lantern","Wireless Mini Light","Wireless Table Light","Wireless Task Light"].',
        '',
        '⚠️ ALWAYS make exactly ONE export_catalog call per export request — pass multiple categories as an array. NEVER call it once per category: every call produces a separate CSV file in Slack.',
        '',
        'PARTNER-SAFE BY DEFAULT: internal cost fields (manufacturer price, royalty) are EXCLUDED. Only set `includeInternalCost:true` for an internal pull, never for a partner-facing export.',
        '',
        'Source: Porter prod read-replica (current/live data). CRI, voltage and dimmer type emit company-standard defaults (90 / 120V / Triac Dimmer), gated to the products they apply to (bulb-equipped, non-wireless where relevant). Canopy dimensions/shape/material, backplate shape/material, hanging dimensions and shipping-box dimensions/weight columns exist in the CSV but export blank until that data is captured in FactoryOS.',
        '',
        'Triggers: "export the product catalog as CSV", "give me a product price list", "wholesale product data for a partner", "dame el catálogo de productos en CSV", "exporta los SKUs de las lámparas de mesa".',
      ].join('\n'),
      schema: Args as z.ZodType<Args>,
      jsonSchema: zodToJsonSchema(Args),
      execute: (args) => this.run(args),
    };
    return [exportCatalog];
  }

  private async run(args: Args): Promise<unknown> {
    // Products are current-state (no time filter in the SQL) but the Grafana
    // proxy still requires a from/to window — pass a wide one.
    const now = Date.now();
    const fromMs = now - 86_400_000;
    const toMs = now + 86_400_000;

    const sql = buildCatalogSql(args);
    let fields: string[];
    let rows: unknown[][];
    try {
      const res = await this.deps.grafana.runSql({ sql, fromMs, toMs, maxRows: MAX_ROWS });
      fields = res.fields;
      rows = res.rows;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message }, 'products.export_catalog SQL failed');
      return { ok: false, error: { code: 'QUERY_FAILED', message } };
    }

    const products = rows.map((r) => parseProductRow(fields, r));
    if (products.length === 0) {
      const categories = normalizeCategories(args.category);
      return {
        ok: false,
        error: {
          code: 'NO_PRODUCTS',
          message: `No products matched the filter (status=${args.status}${categories ? `, category=${categories.join(', ')}` : ''}).`,
        },
      };
    }

    const contexts = expandRows(products, args.granularity);
    const columns = args.includeInternalCost ? [...BASE_COLUMNS, ...INTERNAL_COST_COLUMNS] : BASE_COLUMNS;
    const headers = columns.map((c) => c.header);
    const data = contexts.map((ctx) => columns.map((col) => col.value(ctx)));
    const content = Papa.unparse({ fields: headers, data });

    if (content.length > MAX_CSV_BYTES) {
      return {
        ok: false,
        error: {
          code: 'CSV_TOO_LARGE',
          message: `Generated CSV is ${content.length} bytes (cap ${MAX_CSV_BYTES}). Narrow the export with a category or productIds filter.`,
        },
      };
    }

    const filename = exportFilename(args);
    const attachment: ReportAttachment = {
      format: 'csv',
      filename,
      title: 'Gantri product catalog export',
      content,
      normalizedFilename: normalizeFilename(filename, 'csv'),
    };

    const truncated = rows.length >= MAX_ROWS;
    return {
      attachment,
      productsExported: products.length,
      rowsExported: contexts.length,
      granularity: args.granularity,
      includedInternalCost: args.includeInternalCost,
      truncated,
      note: truncated
        ? `Hit the ${MAX_ROWS}-product cap; some products may be missing. Filter by category to be exhaustive.`
        : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/** Escape single quotes for a Postgres string literal. The Grafana proxy has
 *  no parameterized-query path, so literals are escaped Postgres-style. */
export function escapeSql(input: string): string {
  return input.replace(/'/g, "''");
}

/**
 * Normalize the optional `category` arg (a single string, an array of strings,
 * or undefined) into a clean array of category names, or `undefined` when no
 * category filter was supplied. Trims and drops empty entries so a stray blank
 * never produces a `category = ''` clause.
 */
export function normalizeCategories(category: string | string[] | undefined): string[] | undefined {
  if (category == null) return undefined;
  const list = Array.isArray(category) ? category : [category];
  const cleaned = list.map((c) => c.trim()).filter((c) => c.length > 0);
  return cleaned.length ? cleaned : undefined;
}

export function buildCatalogSql(args: Args): string {
  const conds: string[] = [];
  if (args.status !== 'all') {
    conds.push(`status = '${escapeSql(args.status)}'`);
  }
  const categories = normalizeCategories(args.category);
  if (categories) {
    conds.push(
      categories.length === 1
        ? `category = '${escapeSql(categories[0])}'`
        : `category IN (${categories.map((c) => `'${escapeSql(c)}'`).join(', ')})`,
    );
  }
  if (args.productIds?.length) {
    // ints, validated by zod — safe to inline.
    conds.push(`id IN (${args.productIds.join(', ')})`);
  }
  if (args.productNameContains) {
    conds.push(`name ILIKE '%${escapeSql(args.productNameContains)}%'`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return `
SELECT
  id, name, category, "subCategory", "designerName", status, type,
  summary, description, "leadTime", "leadTimeOption",
  colors, size, specs, downloads, "skuAssets"
FROM "Products"
${where}
ORDER BY category NULLS LAST, name
`;
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

export function parseProductRow(fields: string[], row: unknown[]): CatalogProduct {
  const idx = (name: string) => fields.indexOf(name);
  const at = (name: string) => {
    const i = idx(name);
    return i >= 0 ? row[i] : undefined;
  };
  return {
    id: Number(at('id')),
    name: str(at('name')) ?? '',
    category: str(at('category')),
    subCategory: str(at('subCategory')),
    designerName: str(at('designerName')),
    status: str(at('status')) ?? '',
    type: str(at('type')),
    summary: str(at('summary')),
    description: str(at('description')),
    leadTime: numOrNull(at('leadTime')),
    leadTimeOption: str(at('leadTimeOption')),
    size: ensureObject(at('size')) as CatalogProduct['size'],
    specs: ensureObject(at('specs')) as SpecsShape | null,
    downloads: ensureObject(at('downloads')) as DownloadsShape | null,
    skuAssets: ensureObject(at('skuAssets')) as Record<string, SkuAssetShape> | null,
    colors: parsePgJsonArray(at('colors')) as ColorShape[],
  };
}

/** Expand products into export rows per the requested granularity. */
export function expandRows(products: CatalogProduct[], granularity: 'sku' | 'product'): RowContext[] {
  const out: RowContext[] = [];
  for (const product of products) {
    const bulb = decodeBulb(product.specs?.bulb);
    const colors = product.colors.filter((c) => c && (c.defaultSku || c.code));

    if (granularity === 'product') {
      // One row per product. Aggregate every SKU and color into the row so the
      // SKU/Color columns render them all (the Image column pulls every photo
      // straight from skuAssets). `skus`/`colorNames` are always set here — even
      // empty for colorless products (gift cards) — so the columns switch to
      // aggregate mode. sku/colorName stay '' so price/URL helpers use the
      // product-level (base) values.
      const skus = colors.map((color) => color.defaultSku ?? deriveSku(product, color));
      const colorNames = colors.map((color) => color.name ?? color.code ?? '').filter((n) => n !== '');
      out.push({ product, sku: '', colorName: '', bulb, skus, colorNames });
      continue;
    }

    // 'sku' granularity: one row per color/SKU variant.
    if (colors.length === 0) {
      // No color variants (gift cards, some accessories) — still emit the
      // product as a single row rather than dropping it.
      out.push({ product, sku: '', colorName: '', bulb });
      continue;
    }
    for (const color of colors) {
      const sku = color.defaultSku ?? deriveSku(product, color);
      out.push({ product, sku, colorName: color.name ?? color.code ?? '', bulb });
    }
  }
  return out;
}

function deriveSku(product: CatalogProduct, color: ColorShape): string {
  const sizeCode = product.size?.code;
  const parts = [String(product.id), sizeCode, color.code].filter((p) => p != null && p !== '');
  return parts.join('-');
}

// ---------------------------------------------------------------------------
// Value formatting helpers
// ---------------------------------------------------------------------------

/** Cents (integer) → plain dollar string with 2 decimals, no currency symbol
 *  (spreadsheet-friendly). Blank when null. */
export function dollars(cents: number | null): string {
  if (cents == null || !Number.isFinite(cents)) return '';
  return (cents / 100).toFixed(2);
}

/**
 * Resolve a product's retail list price (USD string) from `specs.price` (cents),
 * the team-verified canonical retail price. Top-level `Products.price` is
 * intentionally NOT used (legacy field, populated on only ~6 products), and
 * per-SKU price overrides are deprecated (they no longer exist) — price is
 * uniform across a product's colors. Blank when no price is set (null or 0 —
 * e.g. accessories), never "0.00".
 */
export function listPrice(p: CatalogProduct): string {
  const cents = numOrNull(p.specs?.price ?? null);
  if (cents == null || cents <= 0) return '';
  return dollars(cents);
}

function leadTime(p: CatalogProduct): string {
  if (p.leadTimeOption) return p.leadTimeOption;
  if (p.leadTime != null) return `${p.leadTime} days`;
  return '';
}

function numOrBlank(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  return String(n);
}

function dimsHWD(d: SpecsShape['dimensions']): string {
  if (!d) return '';
  const h = d.height ?? 0;
  const w = d.width ?? 0;
  const dp = d.depth ?? 0;
  if (!h && !w && !dp) return '';
  return `${h} x ${w} x ${dp}`;
}

function footprintWD(f: SpecsShape['footPrint']): string {
  if (!f) return '';
  const w = f.width ?? 0;
  const dp = f.depth ?? 0;
  if (!w && !dp) return '';
  return `${w} x ${dp}`;
}

function backplateWH(b: SpecsShape['backplate']): string {
  if (!b) return '';
  const w = b.width ?? 0;
  const h = b.height ?? 0;
  if (!w && !h) return '';
  return `${w} x ${h}`;
}

/**
 * Decode the `specs.bulb` code into structured bulb specs, mirroring the PDP's
 * `BULB_NAME_MAPPINGS` lookup. Returns blanks for fields not derivable from the
 * code (CRI is never encoded → always blank). For codes not in the mapping we
 * still read base + quantity straight from the code string.
 */
export function decodeBulb(code: string | null | undefined): BulbInfo {
  const empty: BulbInfo = { type: '', base: '', quantity: '', wattage: '', lumens: '', colorTemp: '', dimmable: '', included: '' };
  if (!code) return empty;

  const baseMatch = code.match(/\bE\d+\b/i);
  const base = baseMatch ? baseMatch[0].toUpperCase() : /led panel/i.test(code) ? 'Integrated LED' : '';
  const qtyMatch = code.match(/^(\d+)\s*x\b/i);
  const quantity = qtyMatch ? qtyMatch[1] : '1';

  const lines = BULB_NAME_MAPPINGS[code];
  if (!lines || lines.length === 0) {
    // Unmapped code: surface only what we can read from the string itself.
    return { ...empty, type: code, base, quantity, dimmable: /led/i.test(code) ? 'Yes' : '' };
  }

  const joined = lines.join(' ');
  const ct = joined.match(/(\d+K(?:-\d+K)?)/);
  const lw = joined.match(/([\d,]+)\s*Lumens,\s*([\d.]+)\s*W/i);
  return {
    type: lines[0] ?? '',
    base,
    quantity,
    wattage: lw ? `${lw[2]}W` : '',
    lumens: lw ? lw[1].replace(/,/g, '') : '',
    colorTemp: ct ? ct[1] : '',
    dimmable: /dimmable/i.test(joined) ? 'Yes' : '',
    included: /\(included\)/i.test(joined) ? 'Yes' : '',
  };
}

/**
 * Compose the customer-facing product display name, mirroring Porter's
 * product-naming helper (getBaseProductName / getFullProductName, which populate
 * the `fullProductName` field the PDP and listings render). Gantri shows the
 * qualified `name + category` form as the product title (e.g. "Lago Compact
 * Table Light") — the bare `name` is ambiguous because the same name recurs
 * across categories (e.g. "Cantilever" exists as Table / Wall / Floor lights).
 * The designer is intentionally NOT part of the title: the PDP renders it
 * separately ("<fullProductName> by <designer>"), so we keep Designer in its own
 * column. Falls back to the bare name when category is missing (gift cards, some
 * accessories) and never emits "null"/"undefined".
 */
export function fullProductName(product: Pick<CatalogProduct, 'name' | 'category'>): string {
  const name = (product.name ?? '').trim();
  if (!name) return '';
  const category = (product.category ?? '').trim();
  return category ? `${name} ${category}` : name;
}

/**
 * Certification mark by category, mirroring the PDP. Plug-in lights (Table /
 * Floor / Wall / Clamp) ship the SGS-certified cord-set; wireless and hardwired
 * fixtures carry the standard UL mark.
 */
export function certification(category: string | null): string {
  if (!category) return '';
  return WIRELESS_CATEGORIES.has(category) || HARDWIRED_CATEGORIES.has(category)
    ? 'UL Listed for US and Canada'
    : 'SGS for UL and CSA';
}

/** One product photo: its Cloudinary `url` and its `name` (the raw filename,
 *  shown as the clickable link text). */
/**
 * The white-background photo filenames for a row, in order and deduped. Read
 * from the existing `skuAssets` (selected photo plus the gallery).
 *
 * - 'product' granularity (ctx.skus present): EVERY photo across ALL of the
 *   product's SKUs — "all the images we have".
 * - 'sku' granularity: just the given SKU's photo(s).
 */
export function imageFileNames(ctx: RowContext): string[] {
  const assets = ctx.product.skuAssets;
  if (!assets) return [];
  const aggregate = ctx.skus != null; // product granularity → every SKU's photos
  const skus = aggregate ? Object.keys(assets) : ctx.sku ? [ctx.sku] : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const sku of skus) {
    const asset = assets[sku];
    if (!asset) continue;
    const fileNames: string[] = [];
    if (asset.selectedWhiteBackgroundPhoto) fileNames.push(asset.selectedWhiteBackgroundPhoto);
    if (Array.isArray(asset.whiteBackgroundPhotos)) {
      for (const f of asset.whiteBackgroundPhotos) {
        if (typeof f === 'string' && f.length > 0) fileNames.push(f);
      }
    }
    for (const name of fileNames) {
      if (!seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

/** The image filenames for a row, "; "-joined (order-stable, deduped). Blank
 *  when the product has no photos. */
export function imageNames(ctx: RowContext): string {
  return imageFileNames(ctx).join('; ');
}

export function productUrl(id: number, sku: string): string {
  // gantri.com 301-redirects /products/{id} to the full slug URL, preserving
  // the ?sku query — so the bare id form is robust and needs no slug logic.
  const base = `${PRODUCT_URL_BASE}/${id}`;
  return sku ? `${base}?sku=${encodeURIComponent(sku)}` : base;
}

/**
 * Browser-clickable cut-sheet PDF URL for a SKU.
 *
 * Porter renders the cut-sheet PDF lazily — the first PDP download triggers
 * generation + a Cloudinary upload, and the resulting filename is cached in
 * `skuAssets[sku].cutSheet`. That public download endpoint ALSO writes the
 * product row (`product.update`), so it is NOT read-only and we never call it
 * from the export. Instead we rebuild the exact same Cloudinary URL directly
 * from the cached filename (a pure read), which resolves to the real PDF.
 *
 * The cut sheet is a product-level spec document (only the white-background
 * photo differs by color), so when the requested SKU has no cached PDF yet we
 * fall back to any sibling SKU's cached cut sheet for the same product — every
 * such link resolves and points at the right document. Blank only when no SKU
 * of the product has a cached cut sheet.
 */
export function cutSheetUrl(product: CatalogProduct, sku: string): string {
  const assets = product.skuAssets;
  if (!assets) return '';
  // Prefer the exact SKU's cached cut sheet.
  const exact = sku ? cutSheetFileName(assets[sku]) : null;
  if (exact) return `${IMAGE_URL_BASE}/${product.id}/${sku}/${exact}`;
  // Fall back to the first sibling SKU that has a cached cut sheet.
  for (const [assetSku, asset] of Object.entries(assets)) {
    const fileName = cutSheetFileName(asset);
    if (fileName) return `${IMAGE_URL_BASE}/${product.id}/${assetSku}/${fileName}`;
  }
  return '';
}

function cutSheetFileName(asset: SkuAssetShape | undefined): string | null {
  const fileName = asset?.cutSheet;
  return typeof fileName === 'string' && fileName.length > 0 ? fileName : null;
}

/**
 * Browser-clickable install-instruction PDF URLs for a product, `; `-joined.
 *
 * `downloads.instructions` holds one or more instruction PDF filenames, stored
 * per product (not per SKU) under `products/{id}/downloads/`. Verified form:
 * Cloudinary image/upload + the `dynamic-assets` prefix resolves to the PDF
 * (raw/upload and the prefix-less variants 404). Blank when there are none.
 */
export function instructionUrls(product: CatalogProduct): string {
  const files = (product.downloads?.instructions ?? []).filter(
    (f): f is string => typeof f === 'string' && f.length > 0,
  );
  if (files.length === 0) return '';
  return files.map((f) => `${IMAGE_URL_BASE}/${product.id}/downloads/${f}`).join('; ');
}

function exportFilename(args: Args): string {
  const parts = ['gantri-product-catalog'];
  const categories = normalizeCategories(args.category);
  if (categories) {
    // Single category → slug it; multiple → a stable, neutral label so the
    // filename stays short and doesn't misleadingly name just one category.
    parts.push(categories.length === 1 ? slugify(categories[0]) : 'multi-category');
  }
  if (args.status === 'all') parts.push('all');
  return `${parts.join('-')}.csv`;
}

/** Lowercase, non-alphanumerics → single dashes, trimmed — for filenames. */
function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Low-level coercion
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  if (v == null) return null;
  return String(v);
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a Grafana `json`-typed cell into an object. The proxy usually
 *  returns it pre-parsed, but tolerate a JSON string just in case. */
export function ensureObject(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Parse a Postgres `text[]` column whose elements are JSON object strings
 * (e.g. the `colors` column: `{"{\"code\":\"snow\",...}", "{...}"}`).
 *
 * The Grafana proxy may hand this back either as a native JS array (already
 * decoded) or as the raw Postgres array literal string — handle both, then
 * JSON.parse each element into an object. Non-JSON / unparseable elements are
 * skipped.
 */
export function parsePgJsonArray(value: unknown): Record<string, unknown>[] {
  const elements = extractTextArray(value);
  const out: Record<string, unknown>[] = [];
  for (const el of elements) {
    if (el && typeof el === 'object') {
      out.push(el as Record<string, unknown>);
      continue;
    }
    if (typeof el !== 'string') continue;
    try {
      const parsed = JSON.parse(el);
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>);
    } catch {
      // Not JSON — skip.
    }
  }
  return out;
}

function extractTextArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return [];
  const inner = trimmed.slice(1, -1);
  if (!inner) return [];
  return splitPgArrayLiteral(inner);
}

/** Split a Postgres array-literal body into its (double-quoted) elements,
 *  honoring `\"`-escaped quotes inside JSON payloads. Mirrors the helper used
 *  by product-durations for `printBlock`. */
export function splitPgArrayLiteral(inner: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuotes = false;
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (inQuotes) {
      if (ch === '\\' && i + 1 < inner.length) {
        buf += inner[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        i++;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      out.push(buf);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}
