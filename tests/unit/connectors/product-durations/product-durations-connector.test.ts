import { describe, it, expect, vi } from 'vitest';
import {
  ProductDurationsConnector,
  parsePrintBlock,
  computeSingleTotals,
  rowsToSingle,
  rowsToList,
  buildSingleSql,
  buildListSql,
  parseDefaultJobTemplatesRows,
  resolveStockDuration,
  djtKey,
  type DefaultJobTemplatesMap,
} from '../../../../src/connectors/product-durations/product-durations-connector.js';
import type { GrafanaConnector } from '../../../../src/connectors/grafana/grafana-connector.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SINGLE_FIELDS = [
  'product_id',
  'product_name',
  'category',
  'product_status',
  'version_id',
  'version_status',
  'block_type',
  'part_name',
  'sand_raw_min',
  'sand_primed_min',
  'prime_min',
  'paint_min',
  'finish_qc_min',
  'finish_stage_min',
  'print_block_raw',
  'stock_group_type',
  'assemble_min',
  'stock_stage_min',
  'pack_min',
  'qa_qc_min',
];

interface SingleRowOpts {
  productId?: number;
  productName?: string;
  category?: string | null;
  productStatus?: string;
  versionId?: number;
  versionStatus?: string;
  blockType: 'Part' | 'Stock';
  partName?: string | null;
  sandRaw?: number | null;
  sandPrimed?: number | null;
  prime?: number | null;
  paint?: number | null;
  finishQc?: number | null;
  finishStage?: number | null;
  printBlock?: unknown;
  stockGroupType?: string | null;
  assemble?: number | null;
  stockStage?: number | null;
  pack?: number | null;
  qaQc?: number | null;
}

function singleRow(opts: SingleRowOpts): unknown[] {
  return [
    opts.productId ?? 10337,
    opts.productName ?? 'Canopy',
    opts.category ?? 'Flush Mount',
    opts.productStatus ?? 'Active',
    opts.versionId ?? 15323,
    opts.versionStatus ?? 'Published',
    opts.blockType,
    opts.partName ?? null,
    opts.sandRaw ?? null,
    opts.sandPrimed ?? null,
    opts.prime ?? null,
    opts.paint ?? null,
    opts.finishQc ?? null,
    opts.finishStage ?? null,
    opts.printBlock ?? null,
    opts.stockGroupType ?? null,
    opts.assemble ?? null,
    opts.stockStage ?? null,
    opts.pack ?? null,
    opts.qaQc ?? null,
  ];
}

const LIST_FIELDS = [
  'product_id',
  'product_name',
  'category',
  'stock_group_type',
  'part_count',
  'finish_sand_raw_sum',
  'finish_sand_primed_sum',
  'finish_prime_sum',
  'finish_paint_sum',
  'finish_qc_sum',
  'finish_stage_sum',
  'assemble_min',
  'stock_stage_min',
  'pack_min',
  'qa_qc_min',
];

interface ListRowOpts {
  productId: number;
  productName: string;
  category?: string | null;
  groupType?: string | null;
  partCount?: number;
  sandRawSum?: number;
  sandPrimedSum?: number;
  primeSum?: number;
  paintSum?: number;
  finishQcSum?: number;
  finishStageSum?: number;
  assemble?: number | null;
  stockStage?: number | null;
  pack?: number | null;
  qaQc?: number | null;
}

function listRow(opts: ListRowOpts): unknown[] {
  return [
    opts.productId,
    opts.productName,
    opts.category ?? null,
    opts.groupType ?? null,
    opts.partCount ?? 0,
    opts.sandRawSum ?? 0,
    opts.sandPrimedSum ?? 0,
    opts.primeSum ?? 0,
    opts.paintSum ?? 0,
    opts.finishQcSum ?? 0,
    opts.finishStageSum ?? 0,
    opts.assemble ?? null,
    opts.stockStage ?? null,
    opts.pack ?? null,
    opts.qaQc ?? null,
  ];
}

const DJT_FIELDS = ['groupType', 'step', 'type', 'duration'];

/**
 * Build a `DefaultJobTemplatesMap` matching what `loadDefaults` would return
 * for the typical prod fixture (stock-job-flush_mount + stock-job-floor with
 * their canonical defaults).
 */
function defaultsFixture(): DefaultJobTemplatesMap {
  return parseDefaultJobTemplatesRows(DJT_FIELDS, [
    // stock-job-flush_mount: Assemble has null duration (per-product only),
    // Stage/Pack/QC have system defaults.
    ['stock-job-flush_mount', 'Assemble', 'Assemble', null],
    ['stock-job-flush_mount', 'Assemble', 'Stage', 1.5],
    ['stock-job-flush_mount', 'Pack', 'Pack', 10],
    ['stock-job-flush_mount', 'QA', 'QC', 3],
    // stock-job-floor
    ['stock-job-floor', 'Assemble', 'Assemble', null],
    ['stock-job-floor', 'Assemble', 'Stage', 1.5],
    ['stock-job-floor', 'Pack', 'Pack', 10],
    ['stock-job-floor', 'QA', 'QC', 3],
    // a finish-side row (we don't fall back to these — included to ensure the
    // map carries them but isn't asked to apply them)
    ['standard', 'Finish', 'Paint', 1.3],
  ]);
}

/**
 * Build a Grafana mock whose `runSql` returns a queued sequence of responses
 * keyed by the call index. Each tool call may issue 2+ SQL queries (defaults
 * load + main, or defaults load + lookup + main), so we accept the responses
 * in order. The FIRST response in the queue is always the DefaultJobTemplates
 * load (the connector always calls `loadDefaults` once per tool call before
 * branching into single/list mode).
 */
function makeGrafanaMock(responses: Array<{ fields: string[]; rows: unknown[][] }>): Pick<GrafanaConnector, 'runSql'> {
  let call = 0;
  return {
    runSql: vi.fn(async () => {
      const r = responses[call];
      call++;
      if (!r) throw new Error(`unexpected runSql call #${call} — no response queued`);
      return r;
    }),
  };
}

function defaultsResponse(rows: unknown[][] = [
  ['stock-job-flush_mount', 'Assemble', 'Assemble', null],
  ['stock-job-flush_mount', 'Assemble', 'Stage', 1.5],
  ['stock-job-flush_mount', 'Pack', 'Pack', 10],
  ['stock-job-flush_mount', 'QA', 'QC', 3],
]) {
  return { fields: DJT_FIELDS, rows };
}

function makeConnector(grafana: Pick<GrafanaConnector, 'runSql'>) {
  return new ProductDurationsConnector({ grafana: grafana as GrafanaConnector });
}

function getTool(conn: ProductDurationsConnector) {
  const tool = conn.tools.find((t) => t.name === 'gantri.product_durations');
  if (!tool) throw new Error('gantri.product_durations not registered');
  return tool;
}

// ---------------------------------------------------------------------------
// Pure-helper tests
// ---------------------------------------------------------------------------

describe('parsePrintBlock', () => {
  it('parses a JS array of JSON strings', () => {
    const r = parsePrintBlock(['{"estimatedPrintDuration": 1234, "anything": "else"}']);
    expect(r).toEqual({ count: 1, totalMin: 1234 });
  });

  it('sums multiple print durations', () => {
    const r = parsePrintBlock([
      '{"estimatedPrintDuration": 100}',
      '{"estimatedPrintDuration": 200}',
      '{"estimatedPrintDuration": 50}',
    ]);
    expect(r).toEqual({ count: 3, totalMin: 350 });
  });

  it('parses a Postgres text-array literal fallback', () => {
    const literal = '{"{\\"estimatedPrintDuration\\": 600}","{\\"estimatedPrintDuration\\": 400}"}';
    const r = parsePrintBlock(literal);
    expect(r.count).toBe(2);
    expect(r.totalMin).toBe(1000);
  });

  it('returns zeros for empty input', () => {
    expect(parsePrintBlock(null)).toEqual({ count: 0, totalMin: 0 });
    expect(parsePrintBlock([])).toEqual({ count: 0, totalMin: 0 });
    expect(parsePrintBlock('{}')).toEqual({ count: 0, totalMin: 0 });
  });

  it('skips non-JSON elements without throwing', () => {
    const r = parsePrintBlock(['not json', '{"estimatedPrintDuration": 42}']);
    expect(r.totalMin).toBe(42);
    expect(r.count).toBe(2);
  });
});

describe('computeSingleTotals', () => {
  it('sums finish fields across parts and uses stock fields directly', () => {
    const totals = computeSingleTotals(
      [
        {
          partName: 'A',
          sandRawMin: 10, sandRawMinSource: 'product',
          sandPrimedMin: 5, sandPrimedMinSource: 'product',
          primeMin: 2, primeMinSource: 'product',
          paintMin: 3, paintMinSource: 'product',
          finishQcMin: 1, finishQcMinSource: 'product',
          finishStageMin: 2, finishStageMinSource: 'product',
          estimatedPrintDurationMin: 1000, printBlockCount: 1,
        },
        {
          partName: 'B',
          sandRawMin: 4, sandRawMinSource: 'product',
          sandPrimedMin: null, sandPrimedMinSource: 'unset',
          primeMin: null, primeMinSource: 'unset',
          paintMin: null, paintMinSource: 'unset',
          finishQcMin: null, finishQcMinSource: 'unset',
          finishStageMin: null, finishStageMinSource: 'unset',
          estimatedPrintDurationMin: 500, printBlockCount: 1,
        },
      ],
      {
        groupType: 'stock-job-flush_mount',
        assembleMin: 20, assembleMinSource: 'product',
        stageMin: 2, stageMinSource: 'product',
        packMin: 10, packMinSource: 'product',
        qaQcMin: 3, qaQcMinSource: 'product',
      },
    );
    expect(totals.finishSandRawMin).toBe(14);
    expect(totals.finishSandPrimedMin).toBe(5);
    expect(totals.estimatedPrintDurationMin).toBe(1500);
    expect(totals.assembleMin).toBe(20);
    // grandTotalLaborMin excludes machine print time.
    // finish sums (14 + 5 + 2 + 3 + 1 + 2) + stock (20 + 2 + 10 + 3) = 27 + 35 = 62
    expect(totals.grandTotalLaborMin).toBe(62);
  });

  it('handles null stock gracefully', () => {
    const totals = computeSingleTotals(
      [
        {
          partName: 'A',
          sandRawMin: 5, sandRawMinSource: 'product',
          sandPrimedMin: null, sandPrimedMinSource: 'unset',
          primeMin: null, primeMinSource: 'unset',
          paintMin: null, paintMinSource: 'unset',
          finishQcMin: null, finishQcMinSource: 'unset',
          finishStageMin: null, finishStageMinSource: 'unset',
          estimatedPrintDurationMin: null, printBlockCount: 0,
        },
      ],
      null,
    );
    expect(totals.assembleMin).toBe(0);
    expect(totals.grandTotalLaborMin).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// DefaultJobTemplates parsing + resolution
// ---------------------------------------------------------------------------

describe('parseDefaultJobTemplatesRows', () => {
  it('builds a composite-key map preserving null durations', () => {
    const map = parseDefaultJobTemplatesRows(DJT_FIELDS, [
      ['stock-job-flush_mount', 'Assemble', 'Assemble', null],
      ['stock-job-flush_mount', 'Pack', 'Pack', 10],
      ['stock-job-floor', 'QA', 'QC', 3],
    ]);
    expect(map.get(djtKey('stock-job-flush_mount', 'Assemble', 'Assemble'))).toBeNull();
    expect(map.get(djtKey('stock-job-flush_mount', 'Pack', 'Pack'))).toBe(10);
    expect(map.get(djtKey('stock-job-floor', 'QA', 'QC'))).toBe(3);
    expect(map.has(djtKey('stock-job-pendant', 'Assemble', 'Assemble'))).toBe(false);
  });

  it('keeps a non-null value when duplicates appear with the same key', () => {
    // DefaultJobTemplates in prod has per-material duplicates with identical
    // durations (e.g. Polymaker + ColorFabb both produce step=Finish/type=Paint
    // duration=1.3 under groupType=standard). The map should fold these.
    const map = parseDefaultJobTemplatesRows(DJT_FIELDS, [
      ['standard', 'Finish', 'Paint', 1.3],
      ['standard', 'Finish', 'Paint', 1.3],
      ['standard', 'Finish', 'Paint', null],
    ]);
    expect(map.get(djtKey('standard', 'Finish', 'Paint'))).toBe(1.3);
  });

  it('skips rows with missing groupType/step/type', () => {
    const map = parseDefaultJobTemplatesRows(DJT_FIELDS, [
      [null, 'Pack', 'Pack', 10],
      ['stock-job-other', null, 'Pack', 10],
      ['stock-job-other', 'Pack', null, 10],
    ]);
    expect(map.size).toBe(0);
  });
});

describe('resolveStockDuration', () => {
  const defaults = defaultsFixture();

  it('returns the product value with source=product when set, regardless of defaults', () => {
    const out = resolveStockDuration(20, defaults, 'stock-job-flush_mount', 'Assemble', 'Assemble');
    expect(out).toEqual({ value: 20, source: 'product' });
  });

  it('falls back to DefaultJobTemplates when the product value is null', () => {
    // stockBlock.packDuration=null + DefaultJobTemplates(stock-job-flush_mount, Pack, Pack)=10
    const out = resolveStockDuration(null, defaults, 'stock-job-flush_mount', 'Pack', 'Pack');
    expect(out).toEqual({ value: 10, source: 'default' });
  });

  it('returns null with source=unset when both layers are null', () => {
    // DefaultJobTemplates has an Assemble/Assemble row but duration=null —
    // the system intends per-product override, no default available.
    const out = resolveStockDuration(null, defaults, 'stock-job-flush_mount', 'Assemble', 'Assemble');
    expect(out).toEqual({ value: null, source: 'unset' });
  });

  it('returns null with source=unset when the groupType has no matching default row', () => {
    const out = resolveStockDuration(null, defaults, 'stock-job-nonexistent', 'Pack', 'Pack');
    expect(out).toEqual({ value: null, source: 'unset' });
  });

  it('handles a null groupType (Stock row with missing groupType in stockBlock JSON)', () => {
    const out = resolveStockDuration(null, defaults, null, 'Pack', 'Pack');
    expect(out).toEqual({ value: null, source: 'unset' });
  });
});

// ---------------------------------------------------------------------------
// rowsToSingle / rowsToList — full mapper tests with defaults applied
// ---------------------------------------------------------------------------

describe('rowsToSingle', () => {
  it('groups Part rows into parts[] and Stock row into stockJobs', () => {
    const defaults = defaultsFixture();
    const rows = [
      singleRow({
        blockType: 'Stock',
        stockGroupType: 'stock-job-flush_mount',
        assemble: 20, stockStage: 2, pack: 10, qaQc: 3,
      }),
      singleRow({
        blockType: 'Part',
        partName: 'Upper Trim Ring',
        sandRaw: 10, sandPrimed: 5,
        printBlock: ['{"estimatedPrintDuration": 1234}'],
      }),
      singleRow({
        blockType: 'Part',
        partName: 'Lower Trim Ring',
        sandRaw: 8,
        printBlock: ['{"estimatedPrintDuration": 800}'],
      }),
    ];
    const out = rowsToSingle(SINGLE_FIELDS, rows, 'Published', defaults);
    expect(out.productId).toBe(10337);
    expect(out.productName).toBe('Canopy');
    expect(out.category).toBe('Flush Mount');
    expect(out.parts).toHaveLength(2);
    expect(out.parts[0].partName).toBe('Upper Trim Ring');
    expect(out.parts[0].estimatedPrintDurationMin).toBe(1234);
    expect(out.parts[0].sandRawMin).toBe(10);
    expect(out.parts[0].sandRawMinSource).toBe('product');
    expect(out.parts[0].primeMin).toBeNull();
    expect(out.parts[0].primeMinSource).toBe('unset');
    expect(out.stockJobs).toEqual({
      groupType: 'stock-job-flush_mount',
      assembleMin: 20, assembleMinSource: 'product',
      stageMin: 2, stageMinSource: 'product',
      packMin: 10, packMinSource: 'product',
      qaQcMin: 3, qaQcMinSource: 'product',
    });
    expect(out.totals.finishSandRawMin).toBe(18);
    expect(out.totals.estimatedPrintDurationMin).toBe(2034);
    expect(out.caveats.some((c) => c.includes('Per-SKU variant'))).toBe(true);
    expect(out.caveats.some((c) => c.includes('DefaultJobTemplates'))).toBe(true);
  });

  it("falls back to DefaultJobTemplates when stockBlock.packDuration is null", () => {
    // Per Danny's test plan: stockBlock.packDuration=null + DefaultJobTemplates
    // has a row for the groupType → result is the default value with source='default'.
    const defaults = defaultsFixture();
    const rows = [
      singleRow({
        blockType: 'Stock',
        stockGroupType: 'stock-job-flush_mount',
        assemble: 20, stockStage: 2, pack: null, qaQc: 3,
      }),
      singleRow({ blockType: 'Part', partName: 'Ring', sandRaw: 10 }),
    ];
    const out = rowsToSingle(SINGLE_FIELDS, rows, 'Published', defaults);
    expect(out.stockJobs?.packMin).toBe(10);
    expect(out.stockJobs?.packMinSource).toBe('default');
    expect(out.stockJobs?.assembleMin).toBe(20);
    expect(out.stockJobs?.assembleMinSource).toBe('product');
  });

  it("reports null with source='unset' when neither product nor defaults have the value", () => {
    // Per Danny's test plan: stockBlock.assembleDuration=null +
    // DefaultJobTemplates returns null for that (groupType, step, type) →
    // result is null with source='unset'. The Assemble/Assemble row in the
    // fixture exists but has duration=null (system expects per-product override).
    const defaults = defaultsFixture();
    const rows = [
      singleRow({
        blockType: 'Stock',
        stockGroupType: 'stock-job-flush_mount',
        assemble: null, stockStage: 2, pack: 10, qaQc: 3,
      }),
      singleRow({ blockType: 'Part', partName: 'Ring', sandRaw: 10 }),
    ];
    const out = rowsToSingle(SINGLE_FIELDS, rows, 'Published', defaults);
    expect(out.stockJobs?.assembleMin).toBeNull();
    expect(out.stockJobs?.assembleMinSource).toBe('unset');
  });

  it("returns source='product' when stockBlock value is set, even if defaults differ", () => {
    // Per Danny's test plan: stockBlock.assembleDuration=20 → result is 20
    // with source='product' regardless of what's in defaults. Use a wildly
    // different default value to make sure the product layer wins.
    const defaults = parseDefaultJobTemplatesRows(DJT_FIELDS, [
      ['stock-job-flush_mount', 'Assemble', 'Assemble', 999],
    ]);
    const rows = [
      singleRow({
        blockType: 'Stock',
        stockGroupType: 'stock-job-flush_mount',
        assemble: 20,
      }),
      singleRow({ blockType: 'Part', partName: 'Ring', sandRaw: 10 }),
    ];
    const out = rowsToSingle(SINGLE_FIELDS, rows, 'Published', defaults);
    expect(out.stockJobs?.assembleMin).toBe(20);
    expect(out.stockJobs?.assembleMinSource).toBe('product');
  });
});

describe('rowsToList', () => {
  it('maps SQL aggregate rows to ListRow shape and computes totalLaborMin', () => {
    const defaults = defaultsFixture();
    const rows = [
      listRow({
        productId: 1, productName: 'Big', groupType: 'stock-job-floor',
        partCount: 4, sandRawSum: 40, sandPrimedSum: 20,
        primeSum: 10, paintSum: 10, finishQcSum: 4, finishStageSum: 8,
        assemble: 60, stockStage: 5, pack: 12, qaQc: 4,
      }),
    ];
    const out = rowsToList(LIST_FIELDS, rows, defaults);
    expect(out).toHaveLength(1);
    expect(out[0].productId).toBe(1);
    expect(out[0].partCount).toBe(4);
    expect(out[0].finishSandRawMinSum).toBe(40);
    expect(out[0].assembleMin).toBe(60);
    expect(out[0].assembleMinSource).toBe('product');
    // 40+20+10+10+4+8 + 60+5+12+4 = 92 + 81 = 173
    expect(out[0].totalLaborMin).toBe(173);
  });

  it('applies DefaultJobTemplates fallback per row when stock-side values are null', () => {
    const defaults = defaultsFixture();
    const rows = [
      listRow({
        productId: 1, productName: 'Big', groupType: 'stock-job-floor',
        partCount: 4, sandRawSum: 10,
        // assemble null + defaults has null → unset.
        // pack null + defaults has 10 → default 10.
        // stage null + defaults has 1.5 → default 1.5.
        // qaQc null + defaults has 3 → default 3.
        assemble: null, stockStage: null, pack: null, qaQc: null,
      }),
    ];
    const out = rowsToList(LIST_FIELDS, rows, defaults);
    expect(out[0].assembleMin).toBeNull();
    expect(out[0].assembleMinSource).toBe('unset');
    expect(out[0].packMin).toBe(10);
    expect(out[0].packMinSource).toBe('default');
    expect(out[0].stageMin).toBe(1.5);
    expect(out[0].stageMinSource).toBe('default');
    expect(out[0].qaQcMin).toBe(3);
    expect(out[0].qaQcMinSource).toBe('default');
    // totalLaborMin = sandRaw 10 + (assemble null→0) + stage 1.5 + pack 10 + qaQc 3 = 24.5
    expect(out[0].totalLaborMin).toBe(24.5);
  });

  it('re-sorts by post-fallback total — a row whose stock-side fell back can outrank a higher raw row', () => {
    const defaults = defaultsFixture();
    const rows = [
      // The first row from SQL (highest raw per-product total).
      listRow({
        productId: 2, productName: 'Raw winner', groupType: 'stock-job-flush_mount',
        sandRawSum: 30, assemble: 10, pack: 5, qaQc: 2,
      }),
      // The second row from SQL — raw totals lower, but its null stock-side
      // values pick up high defaults and bump it over.
      listRow({
        productId: 1, productName: 'Default winner', groupType: 'stock-job-flush_mount',
        sandRawSum: 100, assemble: null, pack: null, qaQc: null,
      }),
    ];
    const out = rowsToList(LIST_FIELDS, rows, defaults);
    // After re-sort, "Default winner" should be first because its total (100 + 1.5 + 10 + 3 = 114.5)
    // beats "Raw winner" (30 + 10 + 5 + 2 = 47).
    expect(out[0].productName).toBe('Default winner');
    expect(out[1].productName).toBe('Raw winner');
  });
});

describe('buildSingleSql', () => {
  it('embeds productId and versionStatus and joins via COALESCE(versionId, ppt.versionId)', () => {
    const sql = buildSingleSql(10337, 'Published');
    expect(sql).toContain('v."productId" = 10337');
    expect(sql).toContain("v.status = 'Published'");
    expect(sql).toContain('COALESCE(pjb."versionId", ppt."versionId")');
    expect(sql).toContain('"ProductJobBlocks"');
    // Stock-side groupType is exposed so the JS layer can apply the
    // DefaultJobTemplates fallback.
    expect(sql).toContain(`pjb."stockBlock"->>'groupType'`);
  });

  it('escapes single quotes in versionStatus', () => {
    const sql = buildSingleSql(1, "Draft'; DROP TABLE--");
    // Quotes are doubled, no unescaped injection.
    expect(sql).toContain("v.status = 'Draft''; DROP TABLE--'");
  });
});

describe('buildListSql', () => {
  it('applies status and category filters, enforces limit cap of 200, and exposes stock_group_type', () => {
    const sql = buildListSql({
      status: 'Active',
      versionStatus: 'Published',
      category: 'Flush Mount',
      limit: 500,
    } as any);
    expect(sql).toContain("p.status = 'Active'");
    expect(sql).toContain("v.status = 'Published'");
    expect(sql).toContain("p.category = 'Flush Mount'");
    expect(sql).toMatch(/LIMIT 200\b/);
    expect(sql).toContain(`pjb."stockBlock"->>'groupType'`);
    expect(sql).toContain('stock_group_type');
  });

  it('omits category clause when not provided', () => {
    const sql = buildListSql({ status: 'Active', versionStatus: 'Published', limit: 50 } as any);
    expect(sql).not.toContain('p.category =');
  });
});

// ---------------------------------------------------------------------------
// End-to-end tool tests with mocked Grafana
// ---------------------------------------------------------------------------

describe('gantri.product_durations — argument validation', () => {
  it('returns AMBIGUOUS_ARGS when both productId and productName are passed', async () => {
    const grafana = makeGrafanaMock([]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ productId: 10337, productName: 'Canopy' });
    const result = (await tool.execute(args)) as any;
    expect(result.error.code).toBe('AMBIGUOUS_ARGS');
    expect(grafana.runSql).not.toHaveBeenCalled();
  });
});

describe('gantri.product_durations — single mode by productId', () => {
  it('returns parts + stockJobs + totals for Canopy', async () => {
    const grafana = makeGrafanaMock([
      // Defaults load (always first).
      defaultsResponse(),
      // Main single-mode query.
      {
        fields: SINGLE_FIELDS,
        rows: [
          singleRow({
            blockType: 'Stock', stockGroupType: 'stock-job-flush_mount',
            assemble: 20, stockStage: 2, pack: 10, qaQc: 3,
          }),
          singleRow({
            blockType: 'Part', partName: 'Upper Trim Ring',
            sandRaw: 10, sandPrimed: 5, printBlock: ['{"estimatedPrintDuration": 1000}'],
          }),
          singleRow({
            blockType: 'Part', partName: 'Lower Trim Ring',
            sandRaw: 10, sandPrimed: 5, printBlock: ['{"estimatedPrintDuration": 900}'],
          }),
          singleRow({
            blockType: 'Part', partName: 'Center Hub',
            sandRaw: 8, printBlock: ['{"estimatedPrintDuration": 500}'],
          }),
          singleRow({
            blockType: 'Part', partName: 'Backplate',
            sandRaw: 4, printBlock: ['{"estimatedPrintDuration": 300}'],
          }),
        ],
      },
    ]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ productId: 10337 });
    const result = (await tool.execute(args)) as any;
    expect(result.productId).toBe(10337);
    expect(result.parts).toHaveLength(4);
    expect(result.stockJobs.groupType).toBe('stock-job-flush_mount');
    expect(result.stockJobs.assembleMin).toBe(20);
    expect(result.stockJobs.assembleMinSource).toBe('product');
    expect(result.totals.estimatedPrintDurationMin).toBe(2700);
    expect(result.caveats.length).toBeGreaterThan(0);
    expect(grafana.runSql).toHaveBeenCalledTimes(2);
  });

  it('applies the DefaultJobTemplates fallback end-to-end', async () => {
    const grafana = makeGrafanaMock([
      defaultsResponse(),
      {
        fields: SINGLE_FIELDS,
        rows: [
          singleRow({
            blockType: 'Stock', stockGroupType: 'stock-job-flush_mount',
            // assemble null (defaults: null) → unset
            // stockStage null (defaults: 1.5) → default 1.5
            // pack null (defaults: 10) → default 10
            // qaQc 5 (overridden) → product 5
            assemble: null, stockStage: null, pack: null, qaQc: 5,
          }),
        ],
      },
    ]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const result = (await tool.execute(tool.schema.parse({ productId: 10337 }))) as any;
    expect(result.stockJobs.assembleMin).toBeNull();
    expect(result.stockJobs.assembleMinSource).toBe('unset');
    expect(result.stockJobs.stageMin).toBe(1.5);
    expect(result.stockJobs.stageMinSource).toBe('default');
    expect(result.stockJobs.packMin).toBe(10);
    expect(result.stockJobs.packMinSource).toBe('default');
    expect(result.stockJobs.qaQcMin).toBe(5);
    expect(result.stockJobs.qaQcMinSource).toBe('product');
  });
});

describe('gantri.product_durations — single mode by productName', () => {
  it('resolves a unique name, then runs the main query', async () => {
    const grafana = makeGrafanaMock([
      defaultsResponse(),
      // Name-resolution query.
      {
        fields: ['id', 'name', 'category', 'status'],
        rows: [[10337, 'Canopy', 'Flush Mount', 'Active']],
      },
      // Main query.
      {
        fields: SINGLE_FIELDS,
        rows: [
          singleRow({ blockType: 'Stock', stockGroupType: 'stock-job-flush_mount', assemble: 20, pack: 10, qaQc: 3 }),
          singleRow({ blockType: 'Part', partName: 'Ring', sandRaw: 10 }),
        ],
      },
    ]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ productName: 'canopy' }); // lowercased to test case-insensitivity
    const result = (await tool.execute(args)) as any;
    expect(result.productId).toBe(10337);
    expect(result.parts).toHaveLength(1);
    expect(grafana.runSql).toHaveBeenCalledTimes(3);
    // Second call (after defaults) should be the lookup; verify it uses LOWER() + exact match.
    const secondCall = (grafana.runSql as any).mock.calls[1][0];
    expect(secondCall.sql).toContain("LOWER(name) = 'canopy'");
  });

  it('returns AMBIGUOUS_NAME with candidates when multiple products match', async () => {
    const grafana = makeGrafanaMock([
      defaultsResponse(),
      {
        fields: ['id', 'name', 'category', 'status'],
        rows: [
          [1, 'Noah', 'Table Light', 'Active'],
          [2, 'Noah', 'Wall Light', 'Active'],
          [3, 'Noah', 'Floor Light', 'Active'],
        ],
      },
    ]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ productName: 'Noah' });
    const result = (await tool.execute(args)) as any;
    expect(result.error.code).toBe('AMBIGUOUS_NAME');
    expect(result.error.candidates).toHaveLength(3);
    expect(result.error.candidates[0]).toEqual({ id: 1, name: 'Noah', category: 'Table Light', status: 'Active' });
  });

  it('disambiguates with category filter', async () => {
    const grafana = makeGrafanaMock([
      defaultsResponse(),
      // Name-resolution query — only Table Light Noah comes back.
      {
        fields: ['id', 'name', 'category', 'status'],
        rows: [[1, 'Noah', 'Table Light', 'Active']],
      },
      {
        fields: SINGLE_FIELDS,
        rows: [singleRow({ productId: 1, productName: 'Noah', blockType: 'Stock', stockGroupType: 'stock-job-other', assemble: 15 })],
      },
    ]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ productName: 'Noah', category: 'Table Light' });
    const result = (await tool.execute(args)) as any;
    expect(result.productId).toBe(1);
    const secondCall = (grafana.runSql as any).mock.calls[1][0];
    expect(secondCall.sql).toContain("AND category = 'Table Light'");
  });
});

describe('gantri.product_durations — error cases', () => {
  it('returns PRODUCT_NOT_FOUND when productId has neither templates nor a Products row', async () => {
    const grafana = makeGrafanaMock([
      defaultsResponse(),
      // Main query: empty.
      { fields: SINGLE_FIELDS, rows: [] },
      // Existence check: empty.
      { fields: ['id', 'name', 'category', 'status'], rows: [] },
    ]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ productId: 99999 });
    const result = (await tool.execute(args)) as any;
    expect(result.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('returns NO_TEMPLATES when the product exists but has no ProductJobBlocks', async () => {
    const grafana = makeGrafanaMock([
      defaultsResponse(),
      // Main query: empty.
      { fields: SINGLE_FIELDS, rows: [] },
      // Existence check: product exists.
      {
        fields: ['id', 'name', 'category', 'status'],
        rows: [[42, 'Phantom', 'Table Light', 'Active']],
      },
    ]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ productId: 42 });
    const result = (await tool.execute(args)) as any;
    expect(result.error.code).toBe('NO_TEMPLATES');
  });

  it('returns PRODUCT_NOT_FOUND when productName matches nothing', async () => {
    const grafana = makeGrafanaMock([
      defaultsResponse(),
      { fields: ['id', 'name', 'category', 'status'], rows: [] },
    ]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ productName: 'ZZZNotAProduct' });
    const result = (await tool.execute(args)) as any;
    expect(result.error.code).toBe('PRODUCT_NOT_FOUND');
  });
});

describe('gantri.product_durations — list mode', () => {
  it('returns rows sorted as the SQL produced them (post fallback resort), with caveats', async () => {
    const grafana = makeGrafanaMock([
      defaultsResponse(),
      {
        fields: LIST_FIELDS,
        rows: [
          listRow({
            productId: 1, productName: 'Tall One', groupType: 'stock-job-flush_mount', partCount: 6,
            sandRawSum: 60, sandPrimedSum: 30, assemble: 60, pack: 12, qaQc: 4,
          }),
          listRow({
            productId: 2, productName: 'Mid', groupType: 'stock-job-floor', partCount: 3,
            sandRawSum: 20, assemble: 30, pack: 8, qaQc: 3,
          }),
        ],
      },
    ]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({});
    const result = (await tool.execute(args)) as any;
    expect(result.count).toBe(2);
    expect(result.rows[0].productName).toBe('Tall One');
    expect(result.rows[0].totalLaborMin).toBeGreaterThan(result.rows[1].totalLaborMin);
    expect(result.rows[0].assembleMinSource).toBe('product');
    expect(result.scope).toContain('Active');
    expect(result.scope).toContain('Published');
    expect(result.caveats.length).toBeGreaterThan(0);
  });

  it('applies category filter and forwards it into SQL', async () => {
    const grafana = makeGrafanaMock([
      defaultsResponse(),
      { fields: LIST_FIELDS, rows: [] },
    ]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ category: 'Flush Mount' });
    const result = (await tool.execute(args)) as any;
    expect(result.scope).toContain('Flush Mount');
    // Second call (after defaults) is the list query.
    const call = (grafana.runSql as any).mock.calls[1][0];
    expect(call.sql).toContain("p.category = 'Flush Mount'");
  });

  it('caps limit at 200 even if caller requests more', async () => {
    // The schema itself rejects >200, so we use the un-validated path: cap is
    // also enforced inside buildListSql.
    const sql = buildListSql({ status: 'Active', versionStatus: 'Published', limit: 999 } as any);
    expect(sql).toMatch(/LIMIT 200\b/);
    // Sanity: the Zod schema also rejects >200.
    const grafana = makeGrafanaMock([defaultsResponse(), { fields: LIST_FIELDS, rows: [] }]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    expect(() => tool.schema.parse({ limit: 999 })).toThrow();
  });
});
