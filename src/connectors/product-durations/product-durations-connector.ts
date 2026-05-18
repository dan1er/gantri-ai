import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import type { GrafanaConnector } from '../grafana/grafana-connector.js';

/**
 * `gantri.product_durations` — labor-minute breakdown per product, sourced
 * from a 3-table chain so the answer matches what the running system would
 * use when it creates Jobs:
 *
 *   1. `DefaultJobTemplates`    — system-wide fallback defaults, keyed by
 *      `groupType` (e.g. `stock-job-flush_mount`, `stock-job-floor`) + step + type.
 *      Used when a per-product duration is missing on `ProductJobBlocks`.
 *
 *   2. `ProductPartTemplates`   — per-product part metadata, joined into the
 *      chain via `productPartTemplateId → versionId → Versions.productId`
 *      for the Part rows.
 *
 *   3. `ProductJobBlocks`       — per-product overrides. Two row shapes:
 *        - type='Part'   → carries `finishBlock` JSON (sandRaw, sandPrimed) +
 *                          `printBlock` (text[] of JSON strings with
 *                          `estimatedPrintDuration`).
 *        - type='Stock'  → carries `stockBlock` JSON (assemble/stage/pack/qc +
 *                          `groupType`).
 *
 * Resolution order per duration field:
 *     final = ProductJobBlocks.<field> ?? DefaultJobTemplates(groupType,step,type).duration ?? null
 *
 * The output exposes a `*MinSource` companion field for each resolved duration
 * (`'product'` | `'default'` | `'unset'`) so callers can attribute numbers
 * accurately.
 *
 * Stock-side fallback is wired (groupType is explicit in `stockBlock`).
 *
 * Finish-side fallback is NOT wired: `finishBlock` only ever stores
 * `sandRawDuration` + `sandPrimedDuration` per part — prime/paint/qc/stage
 * keys are not present in the JSON, and `ProductJobBlocks` does not carry a
 * finish-side `groupType` that we can use to pick a `DefaultJobTemplates` row
 * unambiguously. Porter computes finish-side defaults at runtime from
 * `paintedStatus` + `hasBondo` + `material`, business logic this tool does
 * not replicate. Finish-side prime/paint/qc/stage therefore appear as null
 * with `source='unset'`.
 *
 * Caveat surfaced on every payload: per-SKU variant overrides (e.g.
 * rod-finish color) are NOT applied. The admin Cost tab may diverge.
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

/** Where a resolved duration value came from. */
export type DurationSource = 'product' | 'default' | 'unset';

interface PartBreakdown {
  partName: string | null;
  sandRawMin: number | null;
  sandRawMinSource: DurationSource;
  sandPrimedMin: number | null;
  sandPrimedMinSource: DurationSource;
  primeMin: number | null;
  primeMinSource: DurationSource;
  paintMin: number | null;
  paintMinSource: DurationSource;
  finishQcMin: number | null;
  finishQcMinSource: DurationSource;
  finishStageMin: number | null;
  finishStageMinSource: DurationSource;
  estimatedPrintDurationMin: number | null;
  printBlockCount: number;
}

interface StockJobs {
  groupType: string | null;
  assembleMin: number | null;
  assembleMinSource: DurationSource;
  stageMin: number | null;
  stageMinSource: DurationSource;
  packMin: number | null;
  packMinSource: DurationSource;
  qaQcMin: number | null;
  qaQcMinSource: DurationSource;
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
  groupType: string | null;
  partCount: number;
  assembleMin: number | null;
  assembleMinSource: DurationSource;
  packMin: number | null;
  packMinSource: DurationSource;
  qaQcMin: number | null;
  qaQcMinSource: DurationSource;
  stageMin: number | null;
  stageMinSource: DurationSource;
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
// DefaultJobTemplates cache shape
// ---------------------------------------------------------------------------

/**
 * Composite key: `${groupType}|${step}|${type}` → duration (or null).
 *
 * `null` here means the row exists in `DefaultJobTemplates` but its duration
 * column is NULL (e.g. Assemble for stock-job-*, where the system expects a
 * per-product override). A missing key means the (groupType, step, type)
 * combination has no row at all.
 */
export type DefaultJobTemplatesMap = Map<string, number | null>;

/**
 * Encode the composite key used by `DefaultJobTemplatesMap`. Exposed for
 * tests so they can populate the map directly without going through SQL.
 */
export function djtKey(groupType: string | null | undefined, step: string, type: string): string {
  return `${groupType ?? ''}|${step}|${type}`;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

const CAVEATS = [
  'Durations resolve from per-product templates first (`ProductJobBlocks`), falling back to system defaults (`DefaultJobTemplates`) indexed by groupType. The `*MinSource` fields tell you which layer each value came from: `product` (per-product override), `default` (system default), or `unset` (no template duration set; the system applies runtime defaults at job creation).',
  'Stock-side fallback (assemble/stage/pack/qc) IS wired against `DefaultJobTemplates` because `stockBlock.groupType` is explicit. Finish-side prime/paint/qc/stage are NOT in `ProductJobBlocks.finishBlock` and have no per-product groupType key — Porter computes those at runtime from `paintedStatus`+`material`. This tool reports them as null with `source=unset` rather than guessing.',
  'Per-SKU variant overrides (rod-finish color, alternate paint paths, etc.) are NOT applied — these are base template durations.',
  'estimatedPrintDurationMin is derived from gcode estimates and reflects machine time, not human labor.',
];

const SOURCE = 'ProductJobBlocks (Published version) + DefaultJobTemplates (system defaults)';

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
        'Labor-minute breakdown per product. Resolves each duration through the canonical 3-table chain (`DefaultJobTemplates` ← `ProductPartTemplates` ← `ProductJobBlocks`): per-product overrides first, falling back to system defaults keyed by stockBlock `groupType`. Covers assemble, pack, qc, sand-raw, sand-primed, stage, plus machine print time.',
        '',
        'Each duration in the response is paired with a `*MinSource` field: `product` | `default` | `unset` — so the LLM can phrase the answer correctly ("per the product template" vs "per system defaults").',
        '',
        'Two modes:',
        '  - Single-product mode: pass `productId` (preferred) OR `productName` (case-insensitive exact match). Returns per-part finishBlock + product-level stockBlock + summed totals.',
        '  - List mode: pass neither, get one row per product (sorted by totalLaborMin DESC) for the active catalog. Filters: `status` (default Active), `category`, `limit` (default 50, cap 200).',
        '',
        'Use for: "how long does it take to assemble Canopy", "expected job duration for Lune", "labor minutes for X", "cuánto se tarda en ensamblar X", "duración esperada de Y", "labor breakdown for Marea".',
        '',
        '**DO NOT use `grafana.sql` to read these tables directly.** The two-path join (Part rows via `ProductPartTemplates.versionId`, Stock rows via `pjb.versionId`, COALESCE-merged into `Versions`), the JSON path extraction across finishBlock / stockBlock / printBlock (which is a text[] of JSON strings), the per-part roll-up, AND the `DefaultJobTemplates` fallback by `(groupType, step, type)` are all non-trivial and the LLM gets the join wrong every time. Always use this tool.',
        '',
        'Coverage caveat: this returns base template durations. Per-SKU variant overrides (rod-finish color, alternate paint paths) are NOT applied — the Cost tab in admin shows variant-specific numbers that may differ.',
        '',
        'Finish-side caveat: prime/paint/finishQc/finishStage are not stored in `ProductJobBlocks.finishBlock` and Porter resolves them at runtime from `paintedStatus`+`hasBondo`+`material`. This tool reports them as null with `source=unset` rather than replicating that branching logic incorrectly.',
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

    // Load DefaultJobTemplates once per invocation. The table is small (~80
    // rows in prod) and the fallback layer needs every (groupType, step, type)
    // combination, so a single SELECT is cheaper than per-product lookups.
    const defaults = await this.loadDefaults(fromMs, toMs);

    if (args.productId == null && args.productName == null) {
      return this.runList(args, fromMs, toMs, defaults);
    }
    return this.runSingle(args, fromMs, toMs, defaults);
  }

  private async loadDefaults(fromMs: number, toMs: number): Promise<DefaultJobTemplatesMap> {
    const sql = `
SELECT "groupType", step, type, duration
FROM "DefaultJobTemplates"
WHERE "groupType" IS NOT NULL
  AND step IS NOT NULL
  AND type IS NOT NULL
`;
    const { fields, rows } = await this.deps.grafana.runSql({ sql, fromMs, toMs, maxRows: 1000 });
    return parseDefaultJobTemplatesRows(fields, rows);
  }

  private async runSingle(
    args: Args,
    fromMs: number,
    toMs: number,
    defaults: DefaultJobTemplatesMap,
  ): Promise<Result> {
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

    return rowsToSingle(fields, rows, args.versionStatus, defaults);
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

  private async runList(
    args: Args,
    fromMs: number,
    toMs: number,
    defaults: DefaultJobTemplatesMap,
  ): Promise<ListResult> {
    const sql = buildListSql(args);
    const { fields, rows } = await this.deps.grafana.runSql({
      sql,
      fromMs,
      toMs,
      maxRows: args.limit + 5,
    });
    const out = rowsToList(fields, rows, defaults);
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
  (pjb."finishBlock"->>'sandRawDuration')::numeric     AS sand_raw_min,
  (pjb."finishBlock"->>'sandPrimedDuration')::numeric  AS sand_primed_min,
  (pjb."finishBlock"->>'primeDuration')::numeric       AS prime_min,
  (pjb."finishBlock"->>'paintDuration')::numeric       AS paint_min,
  (pjb."finishBlock"->>'qcDuration')::numeric          AS finish_qc_min,
  (pjb."finishBlock"->>'stageDuration')::numeric       AS finish_stage_min,
  pjb."printBlock"                                     AS print_block_raw,
  pjb."stockBlock"->>'groupType'                       AS stock_group_type,
  (pjb."stockBlock"->>'assembleDuration')::numeric     AS assemble_min,
  (pjb."stockBlock"->>'stageDuration')::numeric        AS stock_stage_min,
  (pjb."stockBlock"->>'packDuration')::numeric         AS pack_min,
  (pjb."stockBlock"->>'qcDuration')::numeric           AS qa_qc_min
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
  //
  // We also expose the stock-side groupType (string column) so the JS layer
  // can apply the DefaultJobTemplates fallback for any stock-side duration
  // that comes back null from `stockBlock`.
  return `
WITH per_block AS (
  SELECT
    v."productId"                                      AS product_id,
    p.name                                             AS product_name,
    p.category                                         AS category,
    pjb.type                                           AS block_type,
    pjb."stockBlock"->>'groupType'                     AS stock_group_type,
    -- Finish (per part) — summed across parts in the outer query.
    COALESCE((pjb."finishBlock"->>'sandRawDuration')::numeric, 0)    AS sand_raw_min,
    COALESCE((pjb."finishBlock"->>'sandPrimedDuration')::numeric, 0) AS sand_primed_min,
    COALESCE((pjb."finishBlock"->>'primeDuration')::numeric, 0)      AS prime_min,
    COALESCE((pjb."finishBlock"->>'paintDuration')::numeric, 0)      AS paint_min,
    COALESCE((pjb."finishBlock"->>'qcDuration')::numeric, 0)         AS finish_qc_min,
    COALESCE((pjb."finishBlock"->>'stageDuration')::numeric, 0)      AS finish_stage_min,
    -- Stock (per product — same value duplicated onto each Part row would
    -- double-count, so we tag with block_type and aggregate conditionally).
    -- Cast to numeric (not int) so we don't truncate fractional defaults
    -- like the 1.5-min "stage" duration in DefaultJobTemplates.
    (pjb."stockBlock"->>'assembleDuration')::numeric   AS assemble_min,
    (pjb."stockBlock"->>'stageDuration')::numeric      AS stock_stage_min,
    (pjb."stockBlock"->>'packDuration')::numeric       AS pack_min,
    (pjb."stockBlock"->>'qcDuration')::numeric         AS qa_qc_min
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
  MAX(stock_group_type) FILTER (WHERE block_type = 'Stock')   AS stock_group_type,
  COUNT(*) FILTER (WHERE block_type = 'Part')::int            AS part_count,
  COALESCE(SUM(sand_raw_min)     FILTER (WHERE block_type = 'Part'), 0)::numeric AS finish_sand_raw_sum,
  COALESCE(SUM(sand_primed_min)  FILTER (WHERE block_type = 'Part'), 0)::numeric AS finish_sand_primed_sum,
  COALESCE(SUM(prime_min)        FILTER (WHERE block_type = 'Part'), 0)::numeric AS finish_prime_sum,
  COALESCE(SUM(paint_min)        FILTER (WHERE block_type = 'Part'), 0)::numeric AS finish_paint_sum,
  COALESCE(SUM(finish_qc_min)    FILTER (WHERE block_type = 'Part'), 0)::numeric AS finish_qc_sum,
  COALESCE(SUM(finish_stage_min) FILTER (WHERE block_type = 'Part'), 0)::numeric AS finish_stage_sum,
  MAX(assemble_min)    FILTER (WHERE block_type = 'Stock') AS assemble_min,
  MAX(stock_stage_min) FILTER (WHERE block_type = 'Stock') AS stock_stage_min,
  MAX(pack_min)        FILTER (WHERE block_type = 'Stock') AS pack_min,
  MAX(qa_qc_min)       FILTER (WHERE block_type = 'Stock') AS qa_qc_min
FROM per_block
GROUP BY product_id, product_name, category
-- The DefaultJobTemplates fallback happens in JS post-aggregation (we'd need
-- a second LEFT JOIN keyed by groupType+step+type, but the underlying values
-- are still NULL-able and we'd duplicate the resolution logic between SQL and
-- the single-mode JS path). Sort by the raw per-product total here; the JS
-- mapper re-sorts after applying the fallback so the final ordering reflects
-- resolved totals.
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
// DefaultJobTemplates parsing + resolution
// ---------------------------------------------------------------------------

/**
 * Convert the raw `DefaultJobTemplates` SELECT rows into the composite-key map
 * the connector uses for fallback lookups.
 *
 * Each map entry preserves the row's `duration` column verbatim — including
 * the case where it is NULL (e.g. Assemble for stock-job-flush_mount, where
 * the system expects a per-product override and has no global default). A
 * missing key means the (groupType, step, type) combination has no row.
 */
export function parseDefaultJobTemplatesRows(
  fields: string[],
  rows: unknown[][],
): DefaultJobTemplatesMap {
  const map: DefaultJobTemplatesMap = new Map();
  const gIdx = fields.indexOf('groupType');
  const sIdx = fields.indexOf('step');
  const tIdx = fields.indexOf('type');
  const dIdx = fields.indexOf('duration');
  for (const row of rows) {
    const groupType = row[gIdx] != null ? String(row[gIdx]) : null;
    const step = row[sIdx] != null ? String(row[sIdx]) : '';
    const type = row[tIdx] != null ? String(row[tIdx]) : '';
    if (!groupType || !step || !type) continue;
    const rawDur = row[dIdx];
    const duration = rawDur == null ? null : Number(rawDur);
    const dedupedDuration = duration != null && Number.isFinite(duration) ? duration : null;
    const key = djtKey(groupType, step, type);
    // If the same (groupType, step, type) appears multiple times (e.g. per-material
    // duplicates with identical duration), keep the first non-null we see;
    // null wins only if we never see a real value.
    const prior = map.get(key);
    if (prior === undefined) {
      map.set(key, dedupedDuration);
    } else if (prior == null && dedupedDuration != null) {
      map.set(key, dedupedDuration);
    }
  }
  return map;
}

/**
 * Resolve a stock-side duration through the 3-table fallback chain:
 *   1. product override (from `stockBlock`) — returns `{value, source:'product'}`
 *   2. DefaultJobTemplates row for (groupType, step, type) with a non-null
 *      duration — returns `{value, source:'default'}`
 *   3. neither has a value — returns `{value:null, source:'unset'}`
 */
export function resolveStockDuration(
  productValue: number | null,
  defaults: DefaultJobTemplatesMap,
  groupType: string | null,
  step: string,
  type: string,
): { value: number | null; source: DurationSource } {
  if (productValue != null) return { value: productValue, source: 'product' };
  if (groupType) {
    const fallback = defaults.get(djtKey(groupType, step, type));
    if (fallback != null) return { value: fallback, source: 'default' };
  }
  return { value: null, source: 'unset' };
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

function toNumberOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function rowsToSingle(
  fields: string[],
  rows: unknown[][],
  versionStatus: string,
  defaults: DefaultJobTemplatesMap,
): SingleResult {
  const idx = (name: string) => fields.indexOf(name);
  const parts: PartBreakdown[] = [];
  let rawStock: {
    groupType: string | null;
    assemble: number | null;
    stockStage: number | null;
    pack: number | null;
    qaQc: number | null;
  } | null = null;
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

      // Finish-side values come from finishBlock only. We do NOT fall back to
      // DefaultJobTemplates here because (a) finishBlock has no groupType key
      // and (b) Porter's runtime mapping (paintedStatus + hasBondo + material →
      // finish groupType) is business logic we can't reliably replicate here.
      const sandRaw = toNumberOrNull(row[idx('sand_raw_min')]);
      const sandPrimed = toNumberOrNull(row[idx('sand_primed_min')]);
      const prime = toNumberOrNull(row[idx('prime_min')]);
      const paint = toNumberOrNull(row[idx('paint_min')]);
      const finishQc = toNumberOrNull(row[idx('finish_qc_min')]);
      const finishStage = toNumberOrNull(row[idx('finish_stage_min')]);

      parts.push({
        partName: row[idx('part_name')] != null ? String(row[idx('part_name')]) : null,
        sandRawMin: sandRaw,
        sandRawMinSource: sandRaw != null ? 'product' : 'unset',
        sandPrimedMin: sandPrimed,
        sandPrimedMinSource: sandPrimed != null ? 'product' : 'unset',
        primeMin: prime,
        primeMinSource: prime != null ? 'product' : 'unset',
        paintMin: paint,
        paintMinSource: paint != null ? 'product' : 'unset',
        finishQcMin: finishQc,
        finishQcMinSource: finishQc != null ? 'product' : 'unset',
        finishStageMin: finishStage,
        finishStageMinSource: finishStage != null ? 'product' : 'unset',
        estimatedPrintDurationMin: print.totalMin > 0 || print.count > 0 ? print.totalMin : null,
        printBlockCount: print.count,
      });
    } else if (blockType === 'Stock') {
      rawStock = {
        groupType: row[idx('stock_group_type')] != null ? String(row[idx('stock_group_type')]) : null,
        assemble: toNumberOrNull(row[idx('assemble_min')]),
        stockStage: toNumberOrNull(row[idx('stock_stage_min')]),
        pack: toNumberOrNull(row[idx('pack_min')]),
        qaQc: toNumberOrNull(row[idx('qa_qc_min')]),
      };
    }
  }

  // Apply the DefaultJobTemplates fallback to the stock-side fields. The
  // canonical mapping (matches Porter's job-creation logic):
  //   - assemble  → step='Assemble', type='Assemble'
  //   - stage     → step='Assemble', type='Stage'
  //   - pack      → step='Pack',     type='Pack'
  //   - qa qc     → step='QA',       type='QC'
  let stockJobs: StockJobs | null = null;
  if (rawStock) {
    const groupType = rawStock.groupType;
    const assemble = resolveStockDuration(rawStock.assemble, defaults, groupType, 'Assemble', 'Assemble');
    const stage = resolveStockDuration(rawStock.stockStage, defaults, groupType, 'Assemble', 'Stage');
    const pack = resolveStockDuration(rawStock.pack, defaults, groupType, 'Pack', 'Pack');
    const qaQc = resolveStockDuration(rawStock.qaQc, defaults, groupType, 'QA', 'QC');
    stockJobs = {
      groupType,
      assembleMin: assemble.value,
      assembleMinSource: assemble.source,
      stageMin: stage.value,
      stageMinSource: stage.source,
      packMin: pack.value,
      packMinSource: pack.source,
      qaQcMin: qaQc.value,
      qaQcMinSource: qaQc.source,
    };
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

export function rowsToList(
  fields: string[],
  rows: unknown[][],
  defaults: DefaultJobTemplatesMap,
): ListRow[] {
  const idx = (name: string) => fields.indexOf(name);
  const mapped = rows.map((row): ListRow => {
    const sandRaw = Number(row[idx('finish_sand_raw_sum')] ?? 0);
    const sandPrimed = Number(row[idx('finish_sand_primed_sum')] ?? 0);
    const prime = Number(row[idx('finish_prime_sum')] ?? 0);
    const paint = Number(row[idx('finish_paint_sum')] ?? 0);
    const finishQc = Number(row[idx('finish_qc_sum')] ?? 0);
    const finishStage = Number(row[idx('finish_stage_sum')] ?? 0);

    const rawAssemble = toNumberOrNull(row[idx('assemble_min')]);
    const rawStockStage = toNumberOrNull(row[idx('stock_stage_min')]);
    const rawPack = toNumberOrNull(row[idx('pack_min')]);
    const rawQaQc = toNumberOrNull(row[idx('qa_qc_min')]);
    const groupType =
      row[idx('stock_group_type')] != null ? String(row[idx('stock_group_type')]) : null;

    const assemble = resolveStockDuration(rawAssemble, defaults, groupType, 'Assemble', 'Assemble');
    const stage = resolveStockDuration(rawStockStage, defaults, groupType, 'Assemble', 'Stage');
    const pack = resolveStockDuration(rawPack, defaults, groupType, 'Pack', 'Pack');
    const qaQc = resolveStockDuration(rawQaQc, defaults, groupType, 'QA', 'QC');

    const totalLaborMin =
      sandRaw + sandPrimed + prime + paint + finishQc + finishStage +
      (assemble.value ?? 0) + (stage.value ?? 0) + (pack.value ?? 0) + (qaQc.value ?? 0);
    return {
      productId: Number(row[idx('product_id')]),
      productName: String(row[idx('product_name')] ?? ''),
      category: row[idx('category')] != null ? String(row[idx('category')]) : null,
      groupType,
      partCount: Number(row[idx('part_count')] ?? 0),
      assembleMin: assemble.value,
      assembleMinSource: assemble.source,
      packMin: pack.value,
      packMinSource: pack.source,
      qaQcMin: qaQc.value,
      qaQcMinSource: qaQc.source,
      stageMin: stage.value,
      stageMinSource: stage.source,
      finishSandRawMinSum: sandRaw,
      finishSandPrimedMinSum: sandPrimed,
      totalLaborMin,
    };
  });
  // Re-sort by post-fallback total — the SQL ordered by raw per-product
  // totals, but a product whose stock-side values came in null and got
  // replaced by DefaultJobTemplates would otherwise show up lower than
  // it should.
  mapped.sort((a, b) => b.totalLaborMin - a.totalLaborMin);
  return mapped;
}
