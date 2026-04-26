import { logger } from '../../logger.js';

/**
 * Thin client over Northbeam's official REST API
 * (https://docs.northbeam.io/reference). Replaces the dashboard-scraping
 * `NorthbeamConnector` which got blocked by NB's anti-bot detection.
 *
 * Auth model: raw `Authorization: <api_key>` header (NOT Bearer) plus a
 * `Data-Client-ID` header — both generated under Settings → API Keys in the
 * NB dashboard.
 *
 * Surface:
 *   - `runExport(payload)` — synchronous-feeling wrapper over the async
 *     POST /v1/exports/data-export → poll → download CSV → parse flow.
 *   - `createExport`, `pollExportResult`, `waitForExport`, `downloadCsv` for
 *     callers that want manual control.
 *   - `listMetrics`, `listBreakdowns`, `listAttributionModels` for catalog
 *     discovery (powers the `northbeam.list_*` tools).
 */
export interface NorthbeamApiConfig {
  apiKey: string;
  dataClientId: string;
  /** default 'https://api.northbeam.io' */
  baseUrl?: string;
  /** Polling interval for waitForExport. default 1000ms */
  pollIntervalMs?: number;
  /** Total budget for waitForExport before giving up. default 90000ms (90s). */
  pollTimeoutMs?: number;
  /** Optional fetch override for testing. */
  fetchImpl?: typeof fetch;
}

export interface DataExportBreakdown {
  key: string;
  values?: string[];
}

export interface DataExportPayload {
  /** ad-level granularity. defaults to 'platform'. */
  level?: 'platform' | 'campaign' | 'adset' | 'ad';
  time_granularity?: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'HOURLY';
  /** e.g. 'YESTERDAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS', 'FIXED' */
  period_type?: string;
  /** Required when period_type === 'FIXED'. Some NB clients accept {from,to}, others {period_unit,period_value}. */
  period_options?: Record<string, unknown>;
  breakdowns?: DataExportBreakdown[];
  options?: {
    export_aggregation?: 'BREAKDOWN' | 'TOTAL';
    remove_zero_spend?: boolean;
    aggregate_data?: boolean;
    include_ids?: boolean;
  };
  attribution_options: {
    attribution_models: string[];
    accounting_modes: ('cash' | 'accrual')[];
    attribution_windows: string[];
  };
  metrics: Array<{ id: string; label?: string }>;
  export_file_name?: string;
}

export interface DataExportStatus {
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | string;
  result?: string[];
  data_export_id?: string;
  created_at?: string;
  finished_at?: string;
}

export interface ParsedCsv {
  /** Field names in declaration order. */
  headers: string[];
  /** Parsed records as plain objects keyed by `headers`. */
  rows: Array<Record<string, string>>;
  /** Original CSV body for callers that want it raw. */
  raw: string;
}

export class NorthbeamApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'NorthbeamApiError';
  }
}

export class NorthbeamApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(private readonly cfg: NorthbeamApiConfig) {
    this.baseUrl = cfg.baseUrl ?? 'https://api.northbeam.io';
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.pollIntervalMs = cfg.pollIntervalMs ?? 1000;
    this.pollTimeoutMs = cfg.pollTimeoutMs ?? 90000;
  }

  // ---- public API ----

  async createExport(payload: DataExportPayload): Promise<{ id: string }> {
    return this.request<{ id: string }>('POST', '/v1/exports/data-export', payload);
  }

  async pollExportResult(exportId: string): Promise<DataExportStatus> {
    return this.request<DataExportStatus>('GET', `/v1/exports/data-export/result/${encodeURIComponent(exportId)}`);
  }

  /**
   * Poll until the export reaches a terminal status (SUCCESS or FAILED), or
   * timeout. Returns the final status payload — does NOT auto-download. Caller
   * inspects `.status` and (if SUCCESS) reads `.result[0]` for the signed URL.
   */
  async waitForExport(exportId: string, opts?: { intervalMs?: number; timeoutMs?: number }): Promise<DataExportStatus> {
    const interval = opts?.intervalMs ?? this.pollIntervalMs;
    const timeout = opts?.timeoutMs ?? this.pollTimeoutMs;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await sleep(interval);
      const status = await this.pollExportResult(exportId);
      if (status.status !== 'PENDING' && status.status !== 'RUNNING') return status;
    }
    throw new NorthbeamApiError(0, null, `Export ${exportId} did not finish within ${timeout}ms (last poll still PENDING/RUNNING)`);
  }

  /**
   * High-level helper. Submits the export, waits for SUCCESS, downloads the
   * signed CSV, and returns parsed rows. Throws on non-success or on download
   * failure. Use this for one-shot tool calls.
   */
  async runExport(payload: DataExportPayload, opts?: { intervalMs?: number; timeoutMs?: number }): Promise<ParsedCsv> {
    const { id } = await this.createExport(payload);
    const status = await this.waitForExport(id, opts);
    if (status.status !== 'SUCCESS') {
      throw new NorthbeamApiError(0, status, `Export ${id} ended with status ${status.status}`);
    }
    const url = status.result?.[0];
    if (!url) throw new NorthbeamApiError(0, status, `Export ${id} succeeded but returned no signed URL`);
    return this.downloadCsv(url);
  }

  async downloadCsv(signedUrl: string): Promise<ParsedCsv> {
    const res = await this.fetchImpl(signedUrl);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new NorthbeamApiError(res.status, text, `CSV download failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const raw = await res.text();
    return parseCsv(raw);
  }

  async listMetrics(): Promise<Array<{ id: string; label: string }>> {
    const body = await this.request<{ metrics: Array<{ id: string; label: string }> }>('GET', '/v1/exports/metrics');
    return body.metrics;
  }

  async listBreakdowns(): Promise<Array<{ key: string; values: string[] }>> {
    const body = await this.request<{ breakdowns: Array<{ key: string; values: string[] }> }>('GET', '/v1/exports/breakdowns');
    return body.breakdowns;
  }

  async listAttributionModels(): Promise<Array<{ id: string; name: string }>> {
    const body = await this.request<{ attribution_models: Array<{ id: string; name: string }> }>('GET', '/v1/exports/attribution-models');
    return body.attribution_models;
  }

  /**
   * GET /v2/orders — pulls the per-order rows Northbeam has on file for the
   * window. Each row is what was pushed via the upstream firePurchaseEvent
   * ingestion: order_id, customer_name/email/phone, purchase_total, tax,
   * shipping_cost, discount_amount, order_tags, currency, timestamps, plus
   * `is_cancelled` / `is_deleted` flags. NB does NOT attach per-order
   * attribution (touchpoints, channel) on this surface — for that the
   * dashboard is still the only path.
   */
  async listOrders(opts: { startDate: string; endDate: string }): Promise<Array<Record<string, unknown>>> {
    const qs = `?start_date=${encodeURIComponent(opts.startDate)}&end_date=${encodeURIComponent(opts.endDate)}`;
    const body = await this.request<Array<Record<string, unknown>> | { data?: Array<Record<string, unknown>> }>(
      'GET',
      `/v2/orders${qs}`,
    );
    if (Array.isArray(body)) return body;
    return body.data ?? [];
  }

  // ---- internals ----

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: this.cfg.apiKey,
      'Data-Client-ID': this.cfg.dataClientId,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { /* keep text */ }
    if (!res.ok) {
      logger.warn({ method, path, status: res.status, body: parsed }, 'northbeam api error');
      throw new NorthbeamApiError(res.status, parsed, `${method} ${path} -> ${res.status}`);
    }
    return parsed as T;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Minimal RFC 4180 CSV parser. Handles quoted fields, escaped double-quotes,
 * embedded commas, and embedded newlines. Empty fields stay as empty strings.
 * No dep needed for the few fields NB returns.
 */
export function parseCsv(text: string): ParsedCsv {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  const len = text.length;
  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < len && text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; i++; continue; }
    field += c; i++;
  }
  // Trailing field/row (no final newline)
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  // Drop trailing all-empty row that comes from a final \n
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  if (rows.length === 0) return { headers: [], rows: [], raw: text };
  const headers = rows[0];
  const data: Array<Record<string, string>> = [];
  for (let r = 1; r < rows.length; r++) {
    const obj: Record<string, string> = {};
    const cells = rows[r];
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = cells[c] ?? '';
    data.push(obj);
  }
  return { headers, rows: data, raw: text };
}
