import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GrafanaConnector } from '../../../../src/connectors/grafana/grafana-connector.js';

// ---------------------------------------------------------------------------
// Helpers — build a connector with a mocked global fetch
// ---------------------------------------------------------------------------

function makeConnector() {
  return new GrafanaConnector({
    baseUrl: 'https://grafana.example.com',
    token: 'test-token',
    postgresDsUid: 'pg-uid-123',
  });
}

/** Create a fetch mock that returns a JSON body with the given status. */
function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

/** Build a minimal Grafana /api/ds/query response frame. */
function buildSqlFrame(fields: string[], colArrays: unknown[][]) {
  return {
    results: {
      A: {
        frames: [
          {
            schema: { fields: fields.map((name) => ({ name })) },
            data: { values: colArrays },
          },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// grafana.list_dashboards
// ---------------------------------------------------------------------------

describe('GrafanaConnector → grafana.list_dashboards', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch' as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('happy path — returns mapped dashboards', async () => {
    const apiResponse = [
      { uid: 'abc', title: 'Sales Dashboard', folderTitle: 'Business' },
      { uid: 'def', title: 'OKR Dashboard', folderTitle: 'Business' },
    ];
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => apiResponse,
      text: async () => JSON.stringify(apiResponse),
    } as any);

    const conn = makeConnector();
    const tool = conn.tools.find((t) => t.name === 'grafana.list_dashboards')!;
    const args = tool.schema.parse({ limit: 50 });
    const res: any = await tool.execute(args);

    expect(res.count).toBe(2);
    expect(res.dashboards[0]).toEqual({ uid: 'abc', title: 'Sales Dashboard', folder: 'Business' });
    expect(res.dashboards[1]).toEqual({ uid: 'def', title: 'OKR Dashboard', folder: 'Business' });
  });

  it('search param is forwarded as query string', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ uid: 'abc', title: 'Sales Dashboard' }],
      text: async () => '[]',
    } as any);

    const conn = makeConnector();
    const tool = conn.tools.find((t) => t.name === 'grafana.list_dashboards')!;
    const args = tool.schema.parse({ search: 'Sales', limit: 10 });
    await tool.execute(args);

    const calledUrl: string = (fetchSpy.mock.calls[0][0] as string);
    expect(calledUrl).toContain('query=Sales');
  });

  it('folderTitle missing → falls back to "(root)"', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ uid: 'zz', title: 'Root Dash' }],
      text: async () => '[]',
    } as any);

    const conn = makeConnector();
    const tool = conn.tools.find((t) => t.name === 'grafana.list_dashboards')!;
    const res: any = await tool.execute(tool.schema.parse({ limit: 50 }));
    expect(res.dashboards[0].folder).toBe('(root)');
  });

  it('auth error (401) → throws (not caught at this layer)', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Unauthorized' }),
      text: async () => 'Unauthorized',
    } as any);

    const conn = makeConnector();
    const tool = conn.tools.find((t) => t.name === 'grafana.list_dashboards')!;
    const args = tool.schema.parse({ limit: 50 });
    await expect(tool.execute(args)).rejects.toThrow(/HTTP 401/);
  });
});

// ---------------------------------------------------------------------------
// grafana.run_dashboard
// ---------------------------------------------------------------------------

describe('GrafanaConnector → grafana.run_dashboard', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch' as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function buildDashboardResponse() {
    return {
      dashboard: {
        title: 'Sales Dashboard',
        panels: [
          {
            id: 1,
            title: 'Orders by Type',
            targets: [
              {
                rawSql: 'SELECT type, COUNT(*) FROM "Transactions" GROUP BY type',
                datasource: { uid: 'pg-uid-123' },
              },
            ],
          },
          {
            id: 2,
            title: 'Revenue Summary',
            targets: [
              {
                rawSql: 'SELECT SUM(amount) FROM "Transactions"',
                datasource: { uid: 'pg-uid-123' },
              },
            ],
          },
          // Panel without targets — should be skipped
          {
            id: 3,
            title: 'Text panel',
            targets: [],
          },
        ],
      },
    };
  }

  it('happy path — fetches dashboard and executes each panel SQL, returns per-panel results', async () => {
    const dashboardResp = buildDashboardResponse();
    const sqlFrameOrders = buildSqlFrame(['type', 'count'], [['Order', 'Wholesale'], [42, 8]]);
    const sqlFrameRevenue = buildSqlFrame(['sum'], [[99900]]);

    fetchSpy
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => dashboardResp, text: async () => '' } as any)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => sqlFrameOrders, text: async () => '' } as any)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => sqlFrameRevenue, text: async () => '' } as any);

    const conn = makeConnector();
    const tool = conn.tools.find((t) => t.name === 'grafana.run_dashboard')!;
    const args = tool.schema.parse({
      dashboardUid: 'sales-uid',
      dateRange: { startDate: '2025-04-01', endDate: '2025-04-30' },
    });
    const res: any = await tool.execute(args);

    expect(res.dashboard.uid).toBe('sales-uid');
    expect(res.dashboard.title).toBe('Sales Dashboard');
    expect(res.panels).toHaveLength(2); // Text panel skipped
    const ordersPanel = res.panels.find((p: any) => p.panelId === 1);
    expect(ordersPanel.title).toBe('Orders by Type');
    expect(ordersPanel.fields).toEqual(['type', 'count']);
    expect(ordersPanel.rows).toHaveLength(2); // 2 data rows
  });

  it('panelIds filter — only runs selected panels', async () => {
    const dashboardResp = buildDashboardResponse();
    const sqlFrame = buildSqlFrame(['sum'], [[500]]);

    fetchSpy
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => dashboardResp, text: async () => '' } as any)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => sqlFrame, text: async () => '' } as any);

    const conn = makeConnector();
    const tool = conn.tools.find((t) => t.name === 'grafana.run_dashboard')!;
    const args = tool.schema.parse({
      dashboardUid: 'sales-uid',
      dateRange: { startDate: '2025-04-01', endDate: '2025-04-30' },
      panelIds: [2],
    });
    const res: any = await tool.execute(args);
    expect(res.panels).toHaveLength(1);
    expect(res.panels[0].panelId).toBe(2);
    // Only 2 fetch calls: dashboard + 1 panel SQL
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('auth error (401) when fetching dashboard → throws', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Unauthorized' }),
      text: async () => 'Unauthorized',
    } as any);

    const conn = makeConnector();
    const tool = conn.tools.find((t) => t.name === 'grafana.run_dashboard')!;
    const args = tool.schema.parse({
      dashboardUid: 'bad-uid',
      dateRange: { startDate: '2025-04-01', endDate: '2025-04-30' },
    });
    await expect(tool.execute(args)).rejects.toThrow(/HTTP 401/);
  });

  it('panel SQL error → panel result has {error} field, does not crash other panels', async () => {
    const dashboardResp = buildDashboardResponse();
    const sqlFrame = buildSqlFrame(['sum'], [[500]]);

    fetchSpy
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => dashboardResp, text: async () => '' } as any)
      // First panel SQL call fails
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}), text: async () => 'internal error' } as any)
      // Second panel SQL succeeds
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => sqlFrame, text: async () => '' } as any);

    const conn = makeConnector();
    const tool = conn.tools.find((t) => t.name === 'grafana.run_dashboard')!;
    const args = tool.schema.parse({
      dashboardUid: 'sales-uid',
      dateRange: { startDate: '2025-04-01', endDate: '2025-04-30' },
    });
    const res: any = await tool.execute(args);
    expect(res.panels).toHaveLength(2);
    const errPanel = res.panels.find((p: any) => p.error);
    expect(errPanel).toBeTruthy();
    const okPanel = res.panels.find((p: any) => !p.error);
    expect(okPanel.rows).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// grafana.sql
// ---------------------------------------------------------------------------

describe('GrafanaConnector → grafana.sql', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch' as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('happy path — returns fields and rows from frame', async () => {
    const frame = buildSqlFrame(
      ['type', 'orders', 'revenue'],
      [['Order', 'Wholesale'], [100, 20], [50000, 12000]],
    );
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => frame, text: async () => '' } as any);

    const conn = makeConnector();
    const tool = conn.tools.find((t) => t.name === 'grafana.sql')!;
    const args = tool.schema.parse({
      sql: 'SELECT type, COUNT(*) AS orders, SUM(revenue) AS revenue FROM "Transactions" GROUP BY type',
      dateRange: { startDate: '2025-04-01', endDate: '2025-04-30' },
    });
    const res: any = await tool.execute(args);

    expect(res.fields).toEqual(['type', 'orders', 'revenue']);
    expect(res.rowCount).toBe(2);
    expect(res.rows[0]).toEqual(['Order', 100, 50000]);
    expect(res.rows[1]).toEqual(['Wholesale', 20, 12000]);
  });

  it('auth error (401) → throws (not swallowed)', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'Unauthorized',
    } as any);

    const conn = makeConnector();
    const tool = conn.tools.find((t) => t.name === 'grafana.sql')!;
    const args = tool.schema.parse({
      sql: 'SELECT 1',
      dateRange: { startDate: '2025-04-01', endDate: '2025-04-30' },
    });
    await expect(tool.execute(args)).rejects.toThrow(/HTTP 401/);
  });

  it('mixed-type cells (string, number, null) are parsed correctly', async () => {
    const frame = buildSqlFrame(
      ['label', 'amount', 'optional'],
      [['hello'], [42.5], [null]],
    );
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => frame, text: async () => '' } as any);

    const conn = makeConnector();
    const tool = conn.tools.find((t) => t.name === 'grafana.sql')!;
    const args = tool.schema.parse({
      sql: 'SELECT label, amount, optional FROM test',
      dateRange: { startDate: '2025-04-01', endDate: '2025-04-30' },
    });
    const res: any = await tool.execute(args);
    expect(res.rows[0][0]).toBe('hello');
    expect(res.rows[0][1]).toBe(42.5);
    expect(res.rows[0][2]).toBeNull();
  });

  it('respects maxRows cap', async () => {
    const manyValues = Array.from({ length: 20 }, (_, i) => i);
    const frame = buildSqlFrame(['n'], [manyValues]);
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => frame, text: async () => '' } as any);

    const conn = makeConnector();
    const tool = conn.tools.find((t) => t.name === 'grafana.sql')!;
    const args = tool.schema.parse({
      sql: 'SELECT n FROM test',
      dateRange: { startDate: '2025-04-01', endDate: '2025-04-30' },
      maxRows: 5,
    });
    const res: any = await tool.execute(args);
    expect(res.rows).toHaveLength(5);
  });

  it('empty result frame → returns fields=[] rows=[]', async () => {
    const emptyResp = { results: { A: { frames: [] } } };
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => emptyResp, text: async () => '' } as any);

    const conn = makeConnector();
    const tool = conn.tools.find((t) => t.name === 'grafana.sql')!;
    const args = tool.schema.parse({
      sql: 'SELECT 1 WHERE false',
      dateRange: { startDate: '2025-04-01', endDate: '2025-04-30' },
    });
    const res: any = await tool.execute(args);
    expect(res.fields).toEqual([]);
    expect(res.rows).toEqual([]);
  });

  it('Grafana SQL error in result → throws with meaningful message', async () => {
    const errResp = { results: { A: { error: 'relation "foo" does not exist', frames: [] } } };
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => errResp, text: async () => '' } as any);

    const conn = makeConnector();
    const tool = conn.tools.find((t) => t.name === 'grafana.sql')!;
    const args = tool.schema.parse({
      sql: 'SELECT * FROM foo',
      dateRange: { startDate: '2025-04-01', endDate: '2025-04-30' },
    });
    await expect(tool.execute(args)).rejects.toThrow(/Grafana SQL error/);
  });

  it('period field is returned with the correct date range', async () => {
    const frame = buildSqlFrame(['n'], [[1]]);
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => frame, text: async () => '' } as any);

    const conn = makeConnector();
    const tool = conn.tools.find((t) => t.name === 'grafana.sql')!;
    const args = tool.schema.parse({
      sql: 'SELECT 1 AS n',
      dateRange: { startDate: '2025-03-01', endDate: '2025-03-31' },
    });
    const res: any = await tool.execute(args);
    expect(res.period).toEqual({ startDate: '2025-03-01', endDate: '2025-03-31' });
  });
});
