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
 * time, bulb info, spec/cut sheets, product URL). The richer per-spec columns
 * the ticket asks for (structured wattage/lumens/CRI/color-temp, dimmable,
 * UL/ADA ratings, canopy dims, Google Drive photo link) require Porter schema
 * additions + manual data entry in FactoryOS and light up automatically once
 * those columns exist.
 *
 * Why one tool (not `grafana.sql` + `reports.attach_file`): the SKU fan-out
 * (Postgres `colors` text[] of JSON strings → one row per color), the nested
 * `specs` JSON extraction, the cents→dollars price conversion, and the exact
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
} as const;

const PRODUCT_URL_BASE = 'https://www.gantri.com/products';
/** Hard ceiling on the generated CSV — matches the `reports.attach_file`
 *  content cap (reports-connector.ts). At ~121 active products this is moot,
 *  but a `status:'all'` pull on a much larger catalog could approach it. */
const MAX_CSV_BYTES = 1_900_000;
const MAX_ROWS = 5000;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const Args = z.object({
  status: z
    .enum(['Active', 'all'])
    .default('Active')
    .describe('Which products to include. "Active" (default) = currently-sold catalog; "all" = every product regardless of status.'),
  category: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe('Optional category filter, e.g. "Table Light", "Floor Light", "Wall Light", "Pendant Light".'),
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
    .default('sku')
    .describe('"sku" (default) = one row per color/SKU (matches "all SKUs per product"); "product" = one row per product.'),
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
  /** Per-SKU price overrides (cents), keyed by sku. Base price stays specs.price. */
  skuPrices: Record<string, number> | null;
  colors: ColorShape[];
}

/** One expanded export row (product × sku). */
interface RowContext {
  product: CatalogProduct;
  sku: string;
  colorName: string;
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
  { header: 'Product Name', value: (c) => c.product.name ?? '' },
  { header: 'Designer', value: (c) => c.product.designerName ?? '' },
  { header: 'Category', value: (c) => c.product.category ?? '' },
  { header: 'Sub Category', value: (c) => c.product.subCategory ?? '' },
  { header: 'Size', value: (c) => c.product.size?.name ?? '' },
  { header: 'SKU', value: (c) => c.sku },
  { header: 'Color', value: (c) => c.colorName },
  { header: 'Status', value: (c) => c.product.status ?? '' },
  { header: 'List Price (USD)', value: (c) => listPrice(c.product, c.sku) },
  { header: 'Lead Time', value: (c) => leadTime(c.product) },
  { header: 'Summary', value: (c) => c.product.summary ?? '' },
  { header: 'Description', value: (c) => c.product.description ?? '' },
  { header: 'Material', value: (c) => c.product.specs?.material ?? '' },
  { header: 'Recommended Bulb', value: (c) => c.product.specs?.bulb ?? '' },
  {
    header: 'Compatible Bulbs',
    value: (c) => (c.product.specs?.compatibleWith ?? []).filter(Boolean).join('; '),
  },
  { header: 'Dimensions (in, H x W x D)', value: (c) => dimsHWD(c.product.specs?.dimensions) },
  { header: 'Footprint (in, W x D)', value: (c) => footprintWD(c.product.specs?.footPrint) },
  { header: 'Backplate (in, W x H)', value: (c) => backplateWH(c.product.specs?.backplate) },
  { header: 'Cord Length (in)', value: (c) => numOrBlank(c.product.specs?.cableLength) },
  { header: 'Weight (lb)', value: (c) => numOrBlank(c.product.specs?.weight) },
  { header: 'Return Policy', value: () => WHOLESALE_DEFAULTS.returnPolicy },
  { header: 'Warranty', value: () => WHOLESALE_DEFAULTS.warranty },
  { header: 'Country of Origin', value: () => WHOLESALE_DEFAULTS.countryOfOrigin },
  { header: 'Product URL', value: (c) => productUrl(c.product.id, c.sku) },
  { header: 'Cut Sheet', value: (c) => (c.product.downloads?.cutSheet?.isConfigured ? 'Available' : '') },
  { header: 'Install Instructions', value: (c) => (hasItems(c.product.downloads?.instructions) ? 'Available' : '') },
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
        'Each row is one SKU (color variant) by default — i.e. "all SKUs per product". Columns: product name, designer, category, size, SKU, color, status, list price (USD), lead time, summary, description, material, recommended + compatible bulbs, dimensions, footprint, backplate, cord length, weight, return policy, warranty, country of origin, product URL, and cut-sheet / install-instruction availability.',
        '',
        'Filters: `status` (Active default, or "all"), `category` (e.g. "Table Light"), `productIds` (explicit allow-list), `productNameContains`, `granularity` ("sku" default | "product").',
        '',
        'PARTNER-SAFE BY DEFAULT: internal cost fields (manufacturer price, royalty) are EXCLUDED. Only set `includeInternalCost:true` for an internal pull, never for a partner-facing export.',
        '',
        'Source: Porter prod read-replica (current/live data). Structured per-bulb specs (wattage/lumens/CRI/color temperature), dimmable, UL/ADA ratings, canopy dims and a Google-Drive photo link are not yet stored in Porter and are therefore omitted until that data lands; the recommended/compatible bulb strings already carry much of the bulb info.',
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
      return {
        ok: false,
        error: {
          code: 'NO_PRODUCTS',
          message: `No products matched the filter (status=${args.status}${args.category ? `, category=${args.category}` : ''}).`,
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

export function buildCatalogSql(args: Args): string {
  const conds: string[] = [];
  if (args.status !== 'all') {
    conds.push(`status = '${escapeSql(args.status)}'`);
  }
  if (args.category) {
    conds.push(`category = '${escapeSql(args.category)}'`);
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
  colors, size, specs, downloads, "skuPrices"
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
    skuPrices: ensureObject(at('skuPrices')) as Record<string, number> | null,
    colors: parsePgJsonArray(at('colors')) as ColorShape[],
  };
}

/** Expand products into export rows per the requested granularity. */
export function expandRows(products: CatalogProduct[], granularity: 'sku' | 'product'): RowContext[] {
  const out: RowContext[] = [];
  for (const product of products) {
    if (granularity === 'product') {
      out.push({ product, sku: '', colorName: '' });
      continue;
    }
    const colors = product.colors.filter((c) => c && (c.defaultSku || c.code));
    if (colors.length === 0) {
      // No color variants (gift cards, some accessories) — still emit the
      // product as a single row rather than dropping it.
      out.push({ product, sku: '', colorName: '' });
      continue;
    }
    for (const color of colors) {
      const sku = color.defaultSku ?? deriveSku(product, color);
      out.push({ product, sku, colorName: color.name ?? color.code ?? '' });
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
 * Resolve a SKU's retail list price (USD string). Source of truth is
 * `specs.price` (cents) — the team-verified canonical retail price — with a
 * per-SKU override from `skuPrices[sku]` when present (size/color price
 * modifiers). Top-level `Products.price` is intentionally NOT used (legacy
 * field, populated on only ~6 products). See prompts.ts pricing note.
 */
export function listPrice(p: CatalogProduct, sku: string): string {
  const override = sku && p.skuPrices ? numOrNull(p.skuPrices[sku]) : null;
  const base = numOrNull(p.specs?.price ?? null);
  const cents = override != null && override > 0 ? override : base;
  // Treat null or 0 as "no price set" (e.g. accessories) — blank, not "0.00".
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

function hasItems(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}

export function productUrl(id: number, sku: string): string {
  // gantri.com 301-redirects /products/{id} to the full slug URL, preserving
  // the ?sku query — so the bare id form is robust and needs no slug logic.
  const base = `${PRODUCT_URL_BASE}/${id}`;
  return sku ? `${base}?sku=${encodeURIComponent(sku)}` : base;
}

function exportFilename(args: Args): string {
  const parts = ['gantri-product-catalog'];
  if (args.category) parts.push(args.category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  if (args.status === 'all') parts.push('all');
  return `${parts.join('-')}.csv`;
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
