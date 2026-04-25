import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { logger } from '../../logger.js';

export interface GrafanaConfig {
  baseUrl: string;
  token: string;
  /** UID of the default Postgres read-replica datasource used by the `grafana.sql` tool. */
  postgresDsUid: string;
}

/**
 * Grafana Cloud connector. Uses a service account token to:
 *   1. List dashboards (discovery)
 *   2. Execute all panels of a dashboard for a given time range (panel data)
 *   3. Run ad-hoc read-only SQL against the Postgres datasource (for questions
 *      that don't fit any existing dashboard)
 *
 * Authentication: `Authorization: Bearer <service-account-token>`.
 * All SQL runs through the Grafana query proxy, which targets a read-replica
 * — writes are impossible at the infrastructure layer.
 */
export class GrafanaConnector implements Connector {
  readonly name = 'grafana';
  readonly tools: readonly ToolDef[];

  constructor(private readonly cfg: GrafanaConfig) {
    this.tools = buildGrafanaTools(this);
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const me = await this.request<{ name?: string; email?: string }>('/api/user');
      return { ok: true, detail: `as ${me.name ?? me.email}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${this.cfg.token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Grafana ${init.method ?? 'GET'} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /** Execute a raw SQL query against the Postgres read-replica via /api/ds/query. */
  async runSql(params: {
    sql: string;
    fromMs: number;
    toMs: number;
    datasourceUid?: string;
    maxRows?: number;
  }): Promise<{ fields: string[]; rows: unknown[][] }> {
    const ds = params.datasourceUid ?? this.cfg.postgresDsUid;
    const body = {
      queries: [
        {
          refId: 'A',
          datasource: { uid: ds, type: 'grafana-postgresql-datasource' },
          rawSql: params.sql,
          format: 'table',
        },
      ],
      from: String(params.fromMs),
      to: String(params.toMs),
    };
    const resp = await this.request<{
      results: Record<string, { frames?: Array<{ schema: { fields: Array<{ name: string }> }; data: { values: unknown[][] } }>; error?: string; errorSource?: string }>;
    }>('/api/ds/query', { method: 'POST', body: JSON.stringify(body) });
    const first = Object.values(resp.results)[0];
    if (first?.error) throw new Error(`Grafana SQL error: ${first.error}`);
    const frame = first?.frames?.[0];
    if (!frame) return { fields: [], rows: [] };
    const fields = frame.schema.fields.map((f) => f.name);
    const cols = frame.data.values;
    const rowCount = cols[0]?.length ?? 0;
    const cap = params.maxRows ?? 500;
    const limit = Math.min(rowCount, cap);
    const rows: unknown[][] = [];
    for (let i = 0; i < limit; i++) {
      rows.push(fields.map((_, c) => cols[c]?.[i]));
    }
    return { fields, rows };
  }
}

// ============================================================================
// Tool definitions
// ============================================================================

const DateRange = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Convert YYYY-MM-DD (Pacific Time) to UTC unix-ms bounds. */
function ptRangeToMs(range: { startDate: string; endDate: string }) {
  const fromMs = Date.parse(`${range.startDate}T07:00:00.000Z`);
  const endNext = new Date(`${range.endDate}T00:00:00Z`);
  endNext.setUTCDate(endNext.getUTCDate() + 1);
  const toMs = Date.parse(`${endNext.toISOString().slice(0, 10)}T06:59:59.999Z`);
  return { fromMs, toMs };
}

const ListDashboardsArgs = z.object({
  search: z.string().max(100).optional()
    .describe('Substring to filter dashboard titles. Case-insensitive. Omit to list everything.'),
  limit: z.number().int().min(1).max(200).default(50),
});
type ListDashboardsArgs = z.infer<typeof ListDashboardsArgs>;

const RunDashboardArgs = z.object({
  dashboardUid: z.string().min(1)
    .describe('Dashboard UID from grafana.list_dashboards (e.g. "edc38l4mkbsaoa" for the Sales dashboard).'),
  dateRange: DateRange
    .describe('Date range in Pacific Time (YYYY-MM-DD). All panels inherit this range via Grafana time macros.'),
  panelIds: z.array(z.number().int()).optional()
    .describe('Optional: restrict to a subset of panel IDs. Omit to run every panel on the dashboard.'),
  maxRowsPerPanel: z.number().int().min(1).max(1000).default(100),
});
type RunDashboardArgs = z.infer<typeof RunDashboardArgs>;

const SqlArgs = z.object({
  sql: z.string().min(1).max(20_000)
    .describe('Read-only PostgreSQL against Gantri\'s Porter DB (read-replica). Runs through Grafana\'s query proxy. Use standard Postgres syntax. Grafana macros supported: `$__timeFrom()`, `$__timeTo()`, `$__timeFilter(<column>)`.'),
  dateRange: DateRange
    .describe('Time range exposed to the query as $__timeFrom / $__timeTo / $__timeFilter(...), in Pacific Time.'),
  maxRows: z.number().int().min(1).max(1000).default(100),
});
type SqlArgs = z.infer<typeof SqlArgs>;

// ============================================================================

function buildGrafanaTools(conn: GrafanaConnector): ToolDef[] {
  const listDashboards: ToolDef<ListDashboardsArgs> = {
    name: 'grafana.list_dashboards',
    description:
      'List Grafana dashboards the bot can execute. Returns `title`, `uid`, and `folder` for each. Use this to discover which dashboard to call next (via `grafana.run_dashboard`). Gantri\'s Grafana has management-facing dashboards for Sales, Profit, OKRs, Inventory, On-time delivery/shipping, Finance, CSAT/NPS, etc. Always call this first when the user asks a business question that might be backed by a pre-built dashboard.',
    schema: ListDashboardsArgs as z.ZodType<ListDashboardsArgs>,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        search: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    async execute(args) {
      const q = args.search ? `&query=${encodeURIComponent(args.search)}` : '';
      const data = await conn.request<Array<{ uid: string; title: string; folderTitle?: string }>>(
        `/api/search?type=dash-db&limit=${args.limit}${q}`,
      );
      return {
        count: data.length,
        dashboards: data.map((d) => ({ uid: d.uid, title: d.title, folder: d.folderTitle ?? '(root)' })),
      };
    },
  };

  const runDashboard: ToolDef<RunDashboardArgs> = {
    name: 'grafana.run_dashboard',
    description:
      'Execute one or more panels of a Grafana dashboard for a given Pacific-Time date range and return the raw table data (columns + rows) per panel. Use after `grafana.list_dashboards` has identified the right UID. Every panel on the dashboard becomes a separate result; use `panelIds` to narrow down when you only need a subset. Each panel\'s rows are capped at `maxRowsPerPanel`.',
    schema: RunDashboardArgs as z.ZodType<RunDashboardArgs>,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['dashboardUid', 'dateRange'],
      properties: {
        dashboardUid: { type: 'string' },
        dateRange: {
          type: 'object',
          additionalProperties: false,
          required: ['startDate', 'endDate'],
          properties: { startDate: { type: 'string' }, endDate: { type: 'string' } },
        },
        panelIds: { type: 'array', items: { type: 'integer' } },
        maxRowsPerPanel: { type: 'integer', minimum: 1, maximum: 1000 },
      },
    },
    async execute(args) {
      const dash = await conn.request<{ dashboard: { title: string; panels: any[] } }>(
        `/api/dashboards/uid/${encodeURIComponent(args.dashboardUid)}`,
      );
      const { fromMs, toMs } = ptRangeToMs(args.dateRange);
      const allPanels = dash.dashboard.panels.filter((p) => Array.isArray(p.targets) && p.targets.length > 0);
      const selected = args.panelIds?.length
        ? allPanels.filter((p) => args.panelIds!.includes(p.id))
        : allPanels;

      const results = await Promise.all(
        selected.map(async (p: any) => {
          const target = p.targets[0];
          const dsUid = target.datasource?.uid;
          const rawSql = target.rawSql;
          if (!rawSql || !dsUid) {
            return { panelId: p.id, title: p.title, error: 'panel has no SQL or datasource', fields: [], rows: [] };
          }
          try {
            const { fields, rows } = await conn.runSql({
              sql: rawSql,
              fromMs,
              toMs,
              datasourceUid: dsUid,
              maxRows: args.maxRowsPerPanel,
            });
            return { panelId: p.id, title: p.title, fields, rows };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { panelId: p.id, title: p.title, error: msg, fields: [], rows: [] };
          }
        }),
      );

      return {
        dashboard: { uid: args.dashboardUid, title: dash.dashboard.title },
        period: args.dateRange,
        panels: results,
      };
    },
  };

  const sql: ToolDef<SqlArgs> = {
    name: 'grafana.sql',
    description:
      'Run a read-only PostgreSQL query against the Porter read-replica via Grafana\'s query proxy. Use as a fallback when no existing dashboard answers the question. The date range becomes Grafana macros: `$__timeFrom()` and `$__timeTo()` resolve to SQL timestamp literals; `$__timeFilter(t."createdAt")` generates a "BETWEEN ... AND ..." clause. Prefer `grafana.run_dashboard` when a dashboard already answers the question. Amounts on Transactions.amount are JSON in cents (divide by 100 for dollars). Returns a result capped at `maxRows`.',
    schema: SqlArgs as z.ZodType<SqlArgs>,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sql', 'dateRange'],
      properties: {
        sql: { type: 'string' },
        dateRange: {
          type: 'object',
          additionalProperties: false,
          required: ['startDate', 'endDate'],
          properties: { startDate: { type: 'string' }, endDate: { type: 'string' } },
        },
        maxRows: { type: 'integer', minimum: 1, maximum: 1000 },
      },
    },
    async execute(args) {
      const { fromMs, toMs } = ptRangeToMs(args.dateRange);
      const t0 = Date.now();
      try {
        const { fields, rows } = await conn.runSql({
          sql: args.sql,
          fromMs,
          toMs,
          maxRows: args.maxRows,
        });
        return {
          period: args.dateRange,
          fields,
          rowCount: rows.length,
          rows,
          durationMs: Date.now() - t0,
        };
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'grafana sql failed');
        throw err;
      }
    },
  };

  return [listDashboards, runDashboard, sql];
}
