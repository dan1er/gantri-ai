import { describe, it, expect, vi } from 'vitest';
import {
  ProductDurationsConnector,
  parsePrintBlock,
  computeSingleTotals,
  rowsToSingle,
  rowsToList,
  buildSingleSql,
  buildListSql,
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

/**
 * Build a Grafana mock whose `runSql` returns a queued sequence of responses
 * keyed by the call index. Each tool call may issue 1+ SQL queries (lookup +
 * main, or main only), so we accept the responses in order.
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
          partName: 'A', sandRawMin: 10, sandPrimedMin: 5, primeMin: 2, paintMin: 3,
          finishQcMin: 1, finishStageMin: 2, estimatedPrintDurationMin: 1000, printBlockCount: 1,
        },
        {
          partName: 'B', sandRawMin: 4, sandPrimedMin: null, primeMin: null, paintMin: null,
          finishQcMin: null, finishStageMin: null, estimatedPrintDurationMin: 500, printBlockCount: 1,
        },
      ],
      { assembleMin: 20, stageMin: 2, packMin: 10, qaQcMin: 3 },
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
          partName: 'A', sandRawMin: 5, sandPrimedMin: null, primeMin: null, paintMin: null,
          finishQcMin: null, finishStageMin: null, estimatedPrintDurationMin: null, printBlockCount: 0,
        },
      ],
      null,
    );
    expect(totals.assembleMin).toBe(0);
    expect(totals.grandTotalLaborMin).toBe(5);
  });
});

describe('rowsToSingle', () => {
  it('groups Part rows into parts[] and Stock row into stockJobs', () => {
    const rows = [
      singleRow({
        blockType: 'Stock',
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
    const out = rowsToSingle(SINGLE_FIELDS, rows, 'Published');
    expect(out.productId).toBe(10337);
    expect(out.productName).toBe('Canopy');
    expect(out.category).toBe('Flush Mount');
    expect(out.parts).toHaveLength(2);
    expect(out.parts[0].partName).toBe('Upper Trim Ring');
    expect(out.parts[0].estimatedPrintDurationMin).toBe(1234);
    expect(out.stockJobs).toEqual({ assembleMin: 20, stageMin: 2, packMin: 10, qaQcMin: 3 });
    expect(out.totals.finishSandRawMin).toBe(18);
    expect(out.totals.estimatedPrintDurationMin).toBe(2034);
    expect(out.caveats.some((c) => c.includes('Per-SKU variant'))).toBe(true);
  });
});

describe('rowsToList', () => {
  it('maps SQL aggregate rows to ListRow shape and computes totalLaborMin', () => {
    const rows = [
      listRow({
        productId: 1, productName: 'Big',
        partCount: 4, sandRawSum: 40, sandPrimedSum: 20,
        primeSum: 10, paintSum: 10, finishQcSum: 4, finishStageSum: 8,
        assemble: 60, stockStage: 5, pack: 12, qaQc: 4,
      }),
    ];
    const out = rowsToList(LIST_FIELDS, rows);
    expect(out).toHaveLength(1);
    expect(out[0].productId).toBe(1);
    expect(out[0].partCount).toBe(4);
    expect(out[0].finishSandRawMinSum).toBe(40);
    // 40+20+10+10+4+8 + 60+5+12+4 = 92 + 81 = 173
    expect(out[0].totalLaborMin).toBe(173);
  });
});

describe('buildSingleSql', () => {
  it('embeds productId and versionStatus and joins via COALESCE(versionId, ppt.versionId)', () => {
    const sql = buildSingleSql(10337, 'Published');
    expect(sql).toContain('v."productId" = 10337');
    expect(sql).toContain("v.status = 'Published'");
    expect(sql).toContain('COALESCE(pjb."versionId", ppt."versionId")');
    expect(sql).toContain('"ProductJobBlocks"');
  });

  it('escapes single quotes in versionStatus', () => {
    const sql = buildSingleSql(1, "Draft'; DROP TABLE--");
    // Quotes are doubled, no unescaped injection.
    expect(sql).toContain("v.status = 'Draft''; DROP TABLE--'");
  });
});

describe('buildListSql', () => {
  it('applies status and category filters and enforces limit cap of 200', () => {
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
      {
        fields: SINGLE_FIELDS,
        rows: [
          singleRow({
            blockType: 'Stock',
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
    expect(result.stockJobs).toEqual({ assembleMin: 20, stageMin: 2, packMin: 10, qaQcMin: 3 });
    expect(result.totals.estimatedPrintDurationMin).toBe(2700);
    expect(result.caveats.length).toBeGreaterThan(0);
    expect(grafana.runSql).toHaveBeenCalledTimes(1);
  });
});

describe('gantri.product_durations — single mode by productName', () => {
  it('resolves a unique name, then runs the main query', async () => {
    const grafana = makeGrafanaMock([
      // Name-resolution query.
      {
        fields: ['id', 'name', 'category', 'status'],
        rows: [[10337, 'Canopy', 'Flush Mount', 'Active']],
      },
      // Main query.
      {
        fields: SINGLE_FIELDS,
        rows: [
          singleRow({ blockType: 'Stock', assemble: 20, pack: 10, qaQc: 3 }),
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
    expect(grafana.runSql).toHaveBeenCalledTimes(2);
    // First call should be the lookup; verify it uses LOWER() + exact match.
    const firstCall = (grafana.runSql as any).mock.calls[0][0];
    expect(firstCall.sql).toContain("LOWER(name) = 'canopy'");
  });

  it('returns AMBIGUOUS_NAME with candidates when multiple products match', async () => {
    const grafana = makeGrafanaMock([
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
      // Name-resolution query — only Table Light Noah comes back.
      {
        fields: ['id', 'name', 'category', 'status'],
        rows: [[1, 'Noah', 'Table Light', 'Active']],
      },
      {
        fields: SINGLE_FIELDS,
        rows: [singleRow({ productId: 1, productName: 'Noah', blockType: 'Stock', assemble: 15 })],
      },
    ]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ productName: 'Noah', category: 'Table Light' });
    const result = (await tool.execute(args)) as any;
    expect(result.productId).toBe(1);
    const firstCall = (grafana.runSql as any).mock.calls[0][0];
    expect(firstCall.sql).toContain("AND category = 'Table Light'");
  });
});

describe('gantri.product_durations — error cases', () => {
  it('returns PRODUCT_NOT_FOUND when productId has neither templates nor a Products row', async () => {
    const grafana = makeGrafanaMock([
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
  it('returns rows sorted as the SQL produced them, with caveats', async () => {
    const grafana = makeGrafanaMock([
      {
        fields: LIST_FIELDS,
        rows: [
          listRow({
            productId: 1, productName: 'Tall One', partCount: 6,
            sandRawSum: 60, sandPrimedSum: 30, assemble: 60, pack: 12, qaQc: 4,
          }),
          listRow({
            productId: 2, productName: 'Mid', partCount: 3,
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
    expect(result.scope).toContain('Active');
    expect(result.scope).toContain('Published');
    expect(result.caveats.length).toBeGreaterThan(0);
  });

  it('applies category filter and forwards it into SQL', async () => {
    const grafana = makeGrafanaMock([
      { fields: LIST_FIELDS, rows: [] },
    ]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ category: 'Flush Mount' });
    const result = (await tool.execute(args)) as any;
    expect(result.scope).toContain('Flush Mount');
    const call = (grafana.runSql as any).mock.calls[0][0];
    expect(call.sql).toContain("p.category = 'Flush Mount'");
  });

  it('caps limit at 200 even if caller requests more', async () => {
    const grafana = makeGrafanaMock([{ fields: LIST_FIELDS, rows: [] }]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    // The schema itself rejects >200, so we use the un-validated path: cap is
    // also enforced inside buildListSql. Bypass schema by constructing args.
    const sql = buildListSql({ status: 'Active', versionStatus: 'Published', limit: 999 } as any);
    expect(sql).toMatch(/LIMIT 200\b/);
    // Sanity: the Zod schema also rejects >200.
    expect(() => tool.schema.parse({ limit: 999 })).toThrow();
  });
});
