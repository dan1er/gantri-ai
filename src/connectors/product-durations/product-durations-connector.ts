import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import type { GrafanaConnector } from '../grafana/grafana-connector.js';

/**
 * `gantri.product_durations` — labor-minute breakdown per product, sourced
 * from `ProductJobBlocks` (the canonical store, covers ~211 active products)
 * instead of `JobTemplates` (legacy, only covers 167).
 *
 * Two row shapes live in `ProductJobBlocks` per product version:
 *   - type='Part'  → one per part, joined via productPartTemplateId →
 *                    ProductPartTemplates.versionId → Versions.productId.
 *                    Carries `finishBlock` JSON and `printBlock` (text[] of
 *                    JSON strings with `estimatedPrintDuration`).
 *   - type='Stock' → one per product, joined via versionId → Versions directly.
 *                    Carries `stockBlock` JSON (assemble/stage/pack/qcDuration).
 *
 * Single-product mode returns the full per-part breakdown + stockJobs + totals.
 * List mode returns one row per product, sorted by total labor minutes DESC.
 *
 * Caveat surfaced on every payload: these are base template durations only —
 * per-SKU variant overrides (e.g. rod-finish color) are NOT applied. Cost-tab
 * style answers diverge here.
 */
export interface ProductDurationsConnectorDeps {
  grafana: GrafanaConnector;
}

// ---------------------------------------------------------------------------
// Tool args
// ---------------------------------------------------------------------------

const ProductStatus = z.enum(['Active', 'In preparation', 'Off Market', 'Ready']);
const VersionStatus = z.enum(['Published', 'Draft', 'Archived']);

const Args = z.object({
  productId: z.number().int().positive().optional(),
  productName: z.string().min(1).max(100).optional(),
  status: ProductStatus.default('Active'),
  category: z.string().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  versionStatus: VersionStatus.default('Published'),
});
type Args = z.infer<typeof Args>;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

interface PartBreakdown {
  partName: string | null;
  sandRawMin: number | null;
  sandPrimedMin: number | null;
  primeMin: number | null;
  paintMin: number | null;
  finishQcMin: number | null;
  finishStageMin: number | null;
  estimatedPrintDurationMin: number | null;
  printBlockCount: number;
}

interface StockJobs {
  assembleMin: number | null;
  stageMin: number | null;
  packMin: number | null;
  qaQcMin: number | null;
}

interface Totals {
  finishSandRawMin: number;
  finishSandPrimedMin: number;
  finishPrimeMin: number;
  finishPaintMin: number;
  finishQcMin: number;
  finishStageMin: number;
  estimatedPrintDurationMin: number;
  assembleMin: number;
  stageMin: number;
  packMin: number;
  qaQcMin: number;
  grandTotalLaborMin: number;
}

interface SingleResult {
  productId: number;
  productName: string;
  category: string | null;
  productStatus: string;
  versionId: number;
  versionStatus: string;
  parts: PartBreakdown[];
  stockJobs: StockJobs | null;
  totals: Totals;
  source: string;
  caveats: string[];
}

interface ListRow {
  productId: number;
  productName: string;
  category: string | null;
  partCount: number;
  assembleMin: number | null;
  packMin: number | null;
  qaQcMin: number | null;
  finishSandRawMinSum: number;
  finishSandPrimedMinSum: number;
  totalLaborMin: number;
}

interface ListResult {
  scope: string;
  count: number;
  rows: ListRow[];
  caveats: string[];
}

interface ErrorResult {
  error: {
    code: 'AMBIGUOUS_ARGS' | 'AMBIGUOUS_NAME' | 'PRODUCT_NOT_FOUND' | 'NO_TEMPLATES';
    message?: string;
    candidates?: Array<{ id: number; name: string; category: string | null; status: string }>;
  };
}

type Result = SingleResult | ListResult | ErrorResult;

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

const CAVEATS = [
  'Per-SKU variant overrides (rod-finish color, alternate paint paths, etc.) are NOT applied — these are base template durations.',
  'estimatedPrintDurationMin is derived from gcode estimates and reflects machine time, not human labor.',
];

const SOURCE = 'ProductJobBlocks (Published version)';

export class ProductDurationsConnector implements Connector {
  readonly name = 'product-durations';
  readonly tools: readonly ToolDef[];

  constructor(private readonly deps: ProductDurationsConnectorDeps) {
    this.tools = this.buildTools();
  }

  async healthCheck() {
    return { ok: true };
  }

  private buildTools(): ToolDef[] {
    const tool: ToolDef<Args, Result> = {
      name: 'gantri.product_durations',
      description: [
        'Labor-minute breakdown per product from `ProductJobBlocks` — the canonical source of expected job durations (assemble, pack, qc, sand-raw, sand-primed, prime, paint, stage, print).',
        '',
        'Two modes:',
        '  - Single-product mode: pass `productId` (preferred) OR `productName` (case-insensitive exact match). Returns per-part finishBlock + product-level stockBlock + summed totals.',
        '  - List mode: pass neither, get one row per product (sorted by totalLaborMin DESC) for the active catalog. Filters: `status` (default Active), `category`, `limit` (default 50, cap 200).',
        '',
        'Use for: "how long does it take to assemble Canopy", "expected job duration for Lune", "labor minutes for X", "cuánto se tarda en ensamblar X", "duración esperada de Y", "labor breakdown for Marea".',
        '',
        '**DO NOT use `grafana.sql` to read ProductJobBlocks directly.** The two-path join (Part rows via ProductPartTemplates.versionId, Stock rows via pjb.versionId, COALESCE-merged into Versions), the JSON path extraction across finishBlock / stockBlock / printBlock (which is a text[] of JSON strings), and the per-part roll-up are non-trivial and the LLM gets the join wrong every time. Always use this tool.',
        '',
        'Coverage caveat: this returns base template durations. Per-SKU variant overrides (rod-finish color, alternate paint paths) are NOT applied — the Cost tab in admin shows variant-specific numbers that may differ.',
        '',
        'Error codes returned via `{ error: { code, message?, candidates? } }`:',
        '  - AMBIGUOUS_ARGS — both productId AND productName were passed.',
        '  - AMBIGUOUS_NAME — multiple products match the name (e.g. "Noah" exists in Table/Wall/Floor/Flush). `candidates` lists them; ask user to pick id or pass `category`.',
        '  - PRODUCT_NOT_FOUND — no product matches the supplied id/name.',
        '  - NO_TEMPLATES — product exists but has no Published ProductJobBlocks rows.',
      ].join('\n'),
      schema: Args as z.ZodType<Args>,
      jsonSchema: zodToJsonSchema(Args),
      execute: (args) => this.run(args),
    };
    return [tool];
  }

  private async run(args: Args): Promise<Result> {
    // Reject impossible arg combos before going near the DB.
    if (args.productId != null && args.productName != null) {
      return {
        error: {
          code: 'AMBIGUOUS_ARGS',
          message: 'Pass productId OR productName, not both.',
        },
      };
    }

    // The query is current-state; no historical date range. Pick a wide ms
    // window so the Grafana proxy doesn't complain about from/to absence.
    const fromMs = Date.now() - 86_400_000;
    const toMs = Date.now() + 86_400_000;

    if (args.productId == null && args.productName == null) {
      return this.runList(args, fromMs, toMs);
    }
    return this.runSingle(args, fromMs, toMs);
  }

  private async runSingle(args: Args, fromMs: number, toMs: number): Promise<Result> {
    let productId: number;
    if (args.productId != null) {
      productId = args.productId;
    } else {
      // Resolve productName → productId via case-insensitive exact match.
      const resolved = await this.resolveByName(args.productName!, args.category, fromMs, toMs);
      if ('error' in resolved) return resolved;
      productId = resolved.id;
    }

    const sql = buildSingleSql(productId, args.versionStatus);
    const { fields, rows } = await this.deps.grafana.runSql({
      sql,
      fromMs,
      toMs,
      maxRows: 500,
    });

    if (rows.length === 0) {
      // Distinguish "product doesn't exist" from "exists but no templates".
      const productCheck = await this.deps.grafana.runSql({
        sql: `SELECT id, name, category, status FROM "Products" WHERE id = ${productId} LIMIT 1`,
        fromMs,
        toMs,
        maxRows: 1,
      });
      if (productCheck.rows.length === 0) {
        return { error: { code: 'PRODUCT_NOT_FOUND', message: `No product with id ${productId}.` } };
      }
      return {
        error: {
          code: 'NO_TEMPLATES',
          message: `Product ${productId} has no ${args.versionStatus} ProductJobBlocks rows.`,
        },
      };
    }

    return rowsToSingle(fields, rows, args.versionStatus);
  }

  private async resolveByName(
    name: string,
    category: string | undefined,
    fromMs: number,
    toMs: number,
  ): Promise<{ id: number } | ErrorResult> {
    const safeName = escapeSql(name.toLowerCase());
    const categoryClause = category ? `AND category = '${escapeSql(category)}'` : '';
    const sql = `
SELECT id, name, category, status
FROM "Products"
WHERE LOWER(name) = '${safeName}'
  ${categoryClause}
ORDER BY id
LIMIT 50
`;
    const { fields, rows } = await this.deps.grafana.runSql({ sql, fromMs, toMs, maxRows: 50 });
    if (rows.length === 0) {
      return {
        error: {
          code: 'PRODUCT_NOT_FOUND',
          message: `No product matches name "${name}"${category ? ` in category "${category}"` : ''}.`,
        },
      };
    }
    if (rows.length === 1) {
      const idIdx = fields.indexOf('id');
      return { id: Number(rows[0][idIdx]) };
    }
    // Multiple matches → AMBIGUOUS_NAME with candidates.
    const idIdx = fields.indexOf('id');
    const nameIdx = fields.indexOf('name');
    const categoryIdx = fields.indexOf('category');
    const statusIdx = fields.indexOf('status');
    return {
      error: {
        code: 'AMBIGUOUS_NAME',
        message: `Multiple products named "${name}". Pass productId or include category.`,
        candidates: rows.map((r) => ({
          id: Number(r[idIdx]),
          name: String(r[nameIdx] ?? ''),
          category: r[categoryIdx] != null ? String(r[categoryIdx]) : null,
          status: String(r[statusIdx] ?? ''),
        })),
      },
    };
  }

  private async runList(args: Args, fromMs: number, toMs: number): Promise<ListResult> {
    const sql = buildListSql(args);
    const { fields, rows } = await this.deps.grafana.runSql({
      sql,
      fromMs,
      toMs,
      maxRows: args.limit + 5,
    });
    const out = rowsToList(fields, rows);
    return {
      scope: `${args.status} products with ${args.versionStatus} templates${args.category ? ` in category "${args.category}"` : ''}`,
      count: out.length,
      rows: out,
      caveats: CAVEATS,
    };
  }
}

// ---------------------------------------------------------------------------
// SQL builders
// ---------------------------------------------------------------------------

/** Escape single quotes in a SQL string literal. We don't have parameterized
 *  queries through the Grafana proxy, so we double the quotes Postgres-style. */
function escapeSql(input: string): string {
  return input.replace(/'/g, "''");
}

export function buildSingleSql(productId: number, versionStatus: string): string {
  return `
SELECT
  v."productId"                                        AS product_id,
  p.name                                               AS product_name,
  p.category                                           AS category,
  p.status                                             AS product_status,
  v.id                                                 AS version_id,
  v.status                                             AS version_status,
  pjb.type                                             AS block_type,
  ppt.name                                             AS part_name,
  (pjb."finishBlock"->>'sandRawDuration')::int         AS sand_raw_min,
  (pjb."finishBlock"->>'sandPrimedDuration')::int      AS sand_primed_min,
  (pjb."finishBlock"->>'primeDuration')::int           AS prime_min,
  (pjb."finishBlock"->>'paintDuration')::int           AS paint_min,
  (pjb."finishBlock"->>'qcDuration')::int              AS finish_qc_min,
  (pjb."finishBlock"->>'stageDuration')::int           AS finish_stage_min,
  pjb."printBlock"                                     AS print_block_raw,
  (pjb."stockBlock"->>'assembleDuration')::int         AS assemble_min,
  (pjb."stockBlock"->>'stageDuration')::int            AS stock_stage_min,
  (pjb."stockBlock"->>'packDuration')::int             AS pack_min,
  (pjb."stockBlock"->>'qcDuration')::int               AS qa_qc_min
FROM "ProductJobBlocks" pjb
LEFT JOIN "ProductPartTemplates" ppt ON ppt.id = pjb."productPartTemplateId"
JOIN "Versions" v ON v.id = COALESCE(pjb."versionId", ppt."versionId")
JOIN "Products" p ON p.id = v."productId"
WHERE v."productId" = ${productId}
  AND v.status = '${escapeSql(versionStatus)}'
ORDER BY pjb.type DESC, ppt.name NULLS LAST
`;
}

export function buildListSql(args: Args): string {
  const statusClause = `p.status = '${escapeSql(args.status)}'`;
  const categoryClause = args.category ? `AND p.category = '${escapeSql(args.category)}'` : '';
  const versionClause = `v.status = '${escapeSql(args.versionStatus)}'`;
  const limit = Math.min(args.limit, 200);
  // The aggregate sums per part fields (since they apply once per part), and
  // takes MAX of stock fields (each product has only one Stock row, so MAX
  // and MIN produce the same value — MAX is just convenient under GROUP BY).
  return `
WITH per_block AS (
  SELECT
    v."productId"                                      AS product_id,
    p.name                                             AS product_name,
    p.category                                         AS category,
    pjb.type                                           AS block_type,
    -- Finish (per part) — summed across parts in the outer query.
    COALESCE((pjb."finishBlock"->>'sandRawDuration')::int, 0)    AS sand_raw_min,
    COALESCE((pjb."finishBlock"->>'sandPrimedDuration')::int, 0) AS sand_primed_min,
    COALESCE((pjb."finishBlock"->>'primeDuration')::int, 0)      AS prime_min,
    COALESCE((pjb."finishBlock"->>'paintDuration')::int, 0)      AS paint_min,
    COALESCE((pjb."finishBlock"->>'qcDuration')::int, 0)         AS finish_qc_min,
    COALESCE((pjb."finishBlock"->>'stageDuration')::int, 0)      AS finish_stage_min,
    -- Stock (per product — same value duplicated onto each Part row would
    -- double-count, so we tag with block_type and aggregate conditionally).
    (pjb."stockBlock"->>'assembleDuration')::int       AS assemble_min,
    (pjb."stockBlock"->>'stageDuration')::int          AS stock_stage_min,
    (pjb."stockBlock"->>'packDuration')::int           AS pack_min,
    (pjb."stockBlock"->>'qcDuration')::int             AS qa_qc_min
  FROM "ProductJobBlocks" pjb
  LEFT JOIN "ProductPartTemplates" ppt ON ppt.id = pjb."productPartTemplateId"
  JOIN "Versions" v ON v.id = COALESCE(pjb."versionId", ppt."versionId")
  JOIN "Products" p ON p.id = v."productId"
  WHERE ${statusClause}
    ${categoryClause}
    AND ${versionClause}
)
SELECT
  product_id,
  product_name,
  category,
  COUNT(*) FILTER (WHERE block_type = 'Part')::int    AS part_count,
  COALESCE(SUM(sand_raw_min)     FILTER (WHERE block_type = 'Part'), 0)::int AS finish_sand_raw_sum,
  COALESCE(SUM(sand_primed_min)  FILTER (WHERE block_type = 'Part'), 0)::int AS finish_sand_primed_sum,
  COALESCE(SUM(prime_min)        FILTER (WHERE block_type = 'Part'), 0)::int AS finish_prime_sum,
  COALESCE(SUM(paint_min)        FILTER (WHERE block_type = 'Part'), 0)::int AS finish_paint_sum,
  COALESCE(SUM(finish_qc_min)    FILTER (WHERE block_type = 'Part'), 0)::int AS finish_qc_sum,
  COALESCE(SUM(finish_stage_min) FILTER (WHERE block_type = 'Part'), 0)::int AS finish_stage_sum,
  MAX(assemble_min)    FILTER (WHERE block_type = 'Stock') AS assemble_min,
  MAX(stock_stage_min) FILTER (WHERE block_type = 'Stock') AS stock_stage_min,
  MAX(pack_min)        FILTER (WHERE block_type = 'Stock') AS pack_min,
  MAX(qa_qc_min)       FILTER (WHERE block_type = 'Stock') AS qa_qc_min
FROM per_block
GROUP BY product_id, product_name, category
ORDER BY
  (COALESCE(SUM(sand_raw_min)     FILTER (WHERE block_type = 'Part'), 0)
 + COALESCE(SUM(sand_primed_min)  FILTER (WHERE block_type = 'Part'), 0)
 + COALESCE(SUM(prime_min)        FILTER (WHERE block_type = 'Part'), 0)
 + COALESCE(SUM(paint_min)        FILTER (WHERE block_type = 'Part'), 0)
 + COALESCE(SUM(finish_qc_min)    FILTER (WHERE block_type = 'Part'), 0)
 + COALESCE(SUM(finish_stage_min) FILTER (WHERE block_type = 'Part'), 0)
 + COALESCE(MAX(assemble_min)    FILTER (WHERE block_type = 'Stock'), 0)
 + COALESCE(MAX(stock_stage_min) FILTER (WHERE block_type = 'Stock'), 0)
 + COALESCE(MAX(pack_min)        FILTER (WHERE block_type = 'Stock'), 0)
 + COALESCE(MAX(qa_qc_min)       FILTER (WHERE block_type = 'Stock'), 0)
  ) DESC
LIMIT ${limit}
`;
}

// ---------------------------------------------------------------------------
// Row → output mappers
// ---------------------------------------------------------------------------

/**
 * Parse the `printBlock` column. In Postgres the column is `text[]` where each
 * element is a JSON-encoded string with shape `{ estimatedPrintDuration: N, ... }`.
 * The Grafana proxy can return arrays as either native JS arrays (when the
 * postgres-datasource decodes them) or as the raw Postgres array literal
 * `{"json1","json2"}` (when it doesn't) — handle both.
 */
export function parsePrintBlock(value: unknown): { count: number; totalMin: number } {
  const elements = extractTextArray(value);
  let total = 0;
  for (const el of elements) {
    try {
      const parsed = JSON.parse(el);
      const dur = Number(parsed?.estimatedPrintDuration);
      if (Number.isFinite(dur)) total += dur;
    } catch {
      // Element is not valid JSON. Skip — print durations are best-effort.
    }
  }
  return { count: elements.length, totalMin: total };
}

function extractTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return [];
  const inner = trimmed.slice(1, -1);
  if (!inner) return [];
  // Postgres text-array literal. Elements are quoted with double-quotes when
  // they contain commas; embedded double-quotes are escaped as `\"`. JSON
  // payloads will always be quoted because they contain commas + braces.
  return splitPgArrayLiteral(inner);
}

function splitPgArrayLiteral(inner: string): string[] {
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

function toIntOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function rowsToSingle(fields: string[], rows: unknown[][], versionStatus: string): SingleResult {
  const idx = (name: string) => fields.indexOf(name);
  const parts: PartBreakdown[] = [];
  let stockJobs: StockJobs | null = null;
  let productId = 0;
  let productName = '';
  let category: string | null = null;
  let productStatus = '';
  let versionId = 0;
  let resolvedVersionStatus = versionStatus;

  for (const row of rows) {
    if (productId === 0) {
      productId = Number(row[idx('product_id')]);
      productName = String(row[idx('product_name')] ?? '');
      const cat = row[idx('category')];
      category = cat != null ? String(cat) : null;
      productStatus = String(row[idx('product_status')] ?? '');
      versionId = Number(row[idx('version_id')]);
      resolvedVersionStatus = String(row[idx('version_status')] ?? versionStatus);
    }
    const blockType = String(row[idx('block_type')] ?? '');
    if (blockType === 'Part') {
      const printRaw = row[idx('print_block_raw')];
      const print = parsePrintBlock(printRaw);
      parts.push({
        partName: row[idx('part_name')] != null ? String(row[idx('part_name')]) : null,
        sandRawMin: toIntOrNull(row[idx('sand_raw_min')]),
        sandPrimedMin: toIntOrNull(row[idx('sand_primed_min')]),
        primeMin: toIntOrNull(row[idx('prime_min')]),
        paintMin: toIntOrNull(row[idx('paint_min')]),
        finishQcMin: toIntOrNull(row[idx('finish_qc_min')]),
        finishStageMin: toIntOrNull(row[idx('finish_stage_min')]),
        estimatedPrintDurationMin: print.totalMin > 0 || print.count > 0 ? print.totalMin : null,
        printBlockCount: print.count,
      });
    } else if (blockType === 'Stock') {
      stockJobs = {
        assembleMin: toIntOrNull(row[idx('assemble_min')]),
        stageMin: toIntOrNull(row[idx('stock_stage_min')]),
        packMin: toIntOrNull(row[idx('pack_min')]),
        qaQcMin: toIntOrNull(row[idx('qa_qc_min')]),
      };
    }
  }

  const totals = computeSingleTotals(parts, stockJobs);

  return {
    productId,
    productName,
    category,
    productStatus,
    versionId,
    versionStatus: resolvedVersionStatus,
    parts,
    stockJobs,
    totals,
    source: SOURCE,
    caveats: CAVEATS,
  };
}

export function computeSingleTotals(parts: PartBreakdown[], stock: StockJobs | null): Totals {
  const sum = (pick: (p: PartBreakdown) => number | null): number =>
    parts.reduce((acc, p) => acc + (pick(p) ?? 0), 0);
  const totals: Totals = {
    finishSandRawMin: sum((p) => p.sandRawMin),
    finishSandPrimedMin: sum((p) => p.sandPrimedMin),
    finishPrimeMin: sum((p) => p.primeMin),
    finishPaintMin: sum((p) => p.paintMin),
    finishQcMin: sum((p) => p.finishQcMin),
    finishStageMin: sum((p) => p.finishStageMin),
    estimatedPrintDurationMin: sum((p) => p.estimatedPrintDurationMin),
    assembleMin: stock?.assembleMin ?? 0,
    stageMin: stock?.stageMin ?? 0,
    packMin: stock?.packMin ?? 0,
    qaQcMin: stock?.qaQcMin ?? 0,
    grandTotalLaborMin: 0,
  };
  // Grand total = human labor only (excludes estimatedPrintDuration, which is
  // machine time). All finish-block fields + all stock-block fields.
  totals.grandTotalLaborMin =
    totals.finishSandRawMin +
    totals.finishSandPrimedMin +
    totals.finishPrimeMin +
    totals.finishPaintMin +
    totals.finishQcMin +
    totals.finishStageMin +
    totals.assembleMin +
    totals.stageMin +
    totals.packMin +
    totals.qaQcMin;
  return totals;
}

export function rowsToList(fields: string[], rows: unknown[][]): ListRow[] {
  const idx = (name: string) => fields.indexOf(name);
  return rows.map((row) => {
    const sandRaw = Number(row[idx('finish_sand_raw_sum')] ?? 0);
    const sandPrimed = Number(row[idx('finish_sand_primed_sum')] ?? 0);
    const prime = Number(row[idx('finish_prime_sum')] ?? 0);
    const paint = Number(row[idx('finish_paint_sum')] ?? 0);
    const finishQc = Number(row[idx('finish_qc_sum')] ?? 0);
    const finishStage = Number(row[idx('finish_stage_sum')] ?? 0);
    const assemble = toIntOrNull(row[idx('assemble_min')]);
    const stockStage = toIntOrNull(row[idx('stock_stage_min')]);
    const pack = toIntOrNull(row[idx('pack_min')]);
    const qaQc = toIntOrNull(row[idx('qa_qc_min')]);
    const totalLaborMin =
      sandRaw + sandPrimed + prime + paint + finishQc + finishStage +
      (assemble ?? 0) + (stockStage ?? 0) + (pack ?? 0) + (qaQc ?? 0);
    return {
      productId: Number(row[idx('product_id')]),
      productName: String(row[idx('product_name')] ?? ''),
      category: row[idx('category')] != null ? String(row[idx('category')]) : null,
      partCount: Number(row[idx('part_count')] ?? 0),
      assembleMin: assemble,
      packMin: pack,
      qaQcMin: qaQc,
      finishSandRawMinSum: sandRaw,
      finishSandPrimedMinSum: sandPrimed,
      totalLaborMin,
    };
  });
}
