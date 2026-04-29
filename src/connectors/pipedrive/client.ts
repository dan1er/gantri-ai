import { logger } from '../../logger.js';

/**
 * Read-only client for Pipedrive's REST API. Uses a mix of v1 (aggregations,
 * metadata, search, activities) and v2 (entity reads) endpoints. Auth via
 * `Authorization: api_token=<token>` header — NEVER the `?api_token=` query
 * param, which leaks into request logs.
 *
 * Rate limits: token-budget based (~30K daily × seats). Each endpoint has a
 * token cost (timeline = 40 units). A 10-min in-memory cache for directory
 * lookups (pipelines, stages, users, dealFields) keeps us comfortably under
 * the budget for a single Live-Report refresh storm.
 */

export interface PipedriveApiConfig {
  /** Admin API token — read-only access is sufficient. */
  apiToken: string;
  /** Default `https://api.pipedrive.com`. */
  baseUrl?: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Backoff between the failed attempt and the single retry. Default 1000ms. */
  retryDelayMs?: number;
}

export class PipedriveApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'PipedriveApiError';
  }
}

/** v1 "additional_data.pagination" shape — offset-based. */
interface V1Pagination {
  start: number;
  limit: number;
  more_items_in_collection: boolean;
  next_start?: number;
}

interface V1Response<T> {
  success: boolean;
  data: T[] | null;
  additional_data?: { pagination?: V1Pagination };
}

/** v2 "additional_data.next_cursor" shape — cursor-based. */
interface V2Response<T> {
  success: boolean;
  data: T[] | null;
  additional_data?: { next_cursor?: string | null };
}

/** TS shapes — only the fields tools actually surface. */
export interface Pipeline { id: number; name: string; active: boolean; order_nr?: number; deal_probability?: number }
export interface Stage { id: number; name: string; pipeline_id: number; order_nr: number; active_flag?: boolean }
export interface User { id: number; name: string; email: string; active_flag: boolean; is_admin?: number }
export interface DealField { key: string; name: string; field_type: string; options?: Array<{ id: number | string; label: string }> }

/** One bucket from `/v1/deals/timeline`. Gantri is USD-only — values are
 *  pulled from `totals.values.USD` (server-converted via `totals_convert_currency=USD`). */
export interface TimelineBucket {
  period_start: string;
  period_end: string;
  count: number;
  total_value_usd: number;
  weighted_value_usd: number;
  open_count: number;
  open_value_usd: number;
  won_count: number;
  won_value_usd: number;
}

/** Flattened `/v1/deals/summary` output. */
export interface DealsSummary {
  count: number;
  total_value_usd: number;
  weighted_value_usd: number;
}

interface RawTimelineTotals {
  count: number;
  values?: { USD?: number };
  weighted_values?: { USD?: number };
  open_count?: number;
  open_values?: { USD?: number };
  won_count?: number;
  won_values?: { USD?: number };
}

interface RawTimelinePeriod {
  period_start: string;
  period_end: string;
  totals: RawTimelineTotals;
}

export interface DealsTimelineOpts {
  /** YYYY-MM-DD anchor for the first bucket. */
  startDate: string;
  /** Number of intervals to return. */
  amount: number;
  interval: 'day' | 'week' | 'month' | 'quarter';
  fieldKey: 'add_time' | 'won_time' | 'close_time' | 'expected_close_date';
  pipelineId?: number;
  userId?: number;
  stageId?: number;
}

const DEFAULT_MAX_PAGES = 10;

export class PipedriveApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;
  /** Directory-only TTL cache. NOT used for aggregations / lists / details. */
  private readonly directoryCache = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly directoryTtlMs = 10 * 60 * 1000;

  constructor(private readonly cfg: PipedriveApiConfig) {
    this.baseUrl = cfg.baseUrl ?? 'https://api.pipedrive.com';
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.retryDelayMs = cfg.retryDelayMs ?? 1000;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `api_token=${this.cfg.apiToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  /** Single-attempt GET that throws on 4xx/5xx. The retry wrapper lives
   *  inside `request()`. */
  private async fetchOnce(url: string): Promise<Response> {
    return this.fetchImpl(url, { method: 'GET', headers: this.headers() });
  }

  /** GET with one retry on 429/5xx. `path` starts with `/`. */
  private async request<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, v);
    }
    const qs = params.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const t0 = Date.now();
    let res = await this.fetchOnce(url);
    if (res.status === 429 || res.status >= 500) {
      logger.warn({ path, status: res.status }, 'pipedrive transient error — retrying once');
      await new Promise((r) => setTimeout(r, this.retryDelayMs));
      res = await this.fetchOnce(url);
    }
    const elapsed = Date.now() - t0;
    if (!res.ok) {
      // Clone before reading so the original Response stream is left untouched
      // (defensive: lets shared mocks / middleware inspect it independently).
      let body: unknown = null;
      try { body = await res.clone().json(); } catch { body = await res.clone().text().catch(() => null); }
      logger.warn({ path, status: res.status, elapsed, body }, 'pipedrive api error');
      throw new PipedriveApiError(`GET ${path} -> ${res.status}`, res.status, body);
    }
    const data = await res.clone().json();
    logger.info({ path, status: res.status, elapsed }, 'pipedrive api ok');
    return data as T;
  }

  /** v1 offset-pagination walk. Caps at `maxPages`. Returns `{ items, hasMore }`
   *  so callers can flag truncation in tool output. */
  async paginateV1<T>(path: string, query: Record<string, string | undefined> = {}, maxPages = DEFAULT_MAX_PAGES): Promise<{ items: T[]; hasMore: boolean }> {
    const limit = '500';
    const out: T[] = [];
    let start = 0;
    let pages = 0;
    let hasMore = false;
    while (pages < maxPages) {
      const resp = await this.request<V1Response<T>>(path, { ...query, start: String(start), limit });
      const batch = resp.data ?? [];
      out.push(...batch);
      pages += 1;
      const pag = resp.additional_data?.pagination;
      if (!pag || !pag.more_items_in_collection) { hasMore = false; break; }
      hasMore = true;
      start = pag.next_start ?? start + Number(limit);
    }
    return { items: out, hasMore: pages >= maxPages && hasMore };
  }

  /** v2 cursor-pagination walk. Same return shape. */
  async paginateV2<T>(path: string, query: Record<string, string | undefined> = {}, maxPages = DEFAULT_MAX_PAGES): Promise<{ items: T[]; hasMore: boolean }> {
    const out: T[] = [];
    let cursor: string | null | undefined = undefined;
    let pages = 0;
    let hasMore = false;
    while (pages < maxPages) {
      const q: Record<string, string | undefined> = { ...query, limit: '500' };
      if (cursor) q.cursor = cursor;
      const resp = await this.request<V2Response<T>>(path, q);
      const batch = resp.data ?? [];
      out.push(...batch);
      pages += 1;
      cursor = resp.additional_data?.next_cursor;
      if (!cursor) { hasMore = false; break; }
      hasMore = true;
    }
    return { items: out, hasMore: pages >= maxPages && hasMore };
  }

  /** Test hook so we can exercise pagination caps directly. */
  async paginateForTest(path: string, query: Record<string, string>, maxPages: number): Promise<{ items: unknown[]; hasMore: boolean }> {
    return this.paginateV1<unknown>(path, query, maxPages);
  }

  // ---- Directory (cached 10 min) ---- //
  async listPipelines(): Promise<Pipeline[]> {
    return this.cacheGet('pipelines', async () => {
      const resp = await this.request<V1Response<Pipeline>>('/v1/pipelines');
      return resp.data ?? [];
    });
  }

  async listStages(): Promise<Stage[]> {
    return this.cacheGet('stages', async () => {
      const resp = await this.request<V1Response<Stage>>('/v1/stages');
      return resp.data ?? [];
    });
  }

  async listUsers(): Promise<User[]> {
    return this.cacheGet('users', async () => {
      const resp = await this.request<V1Response<User>>('/v1/users');
      return resp.data ?? [];
    });
  }

  async listDealFields(): Promise<DealField[]> {
    return this.cacheGet('dealFields', async () => {
      const resp = await this.request<V1Response<DealField>>('/v1/dealFields');
      return resp.data ?? [];
    });
  }

  /** Cached read-through helper. */
  protected async cacheGet<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const hit = this.directoryCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
    const value = await factory();
    this.directoryCache.set(key, { value, expiresAt: Date.now() + this.directoryTtlMs });
    return value;
  }

  // ---- Aggregation (NOT cached — date ranges make caching meaningless) ---- //

  /**
   * `/v1/deals/timeline` — bucketed totals per period (day/week/month/quarter).
   * Costs ~40 token-units per call. We force `totals_convert_currency=USD` so
   * the server folds multi-currency totals into USD; Gantri is USD-only today
   * but this future-proofs the parsing.
   */
  async dealsTimeline(opts: DealsTimelineOpts): Promise<TimelineBucket[]> {
    const query: Record<string, string | undefined> = {
      start_date: opts.startDate,
      amount: String(opts.amount),
      interval: opts.interval,
      field_key: opts.fieldKey,
      pipeline_id: opts.pipelineId !== undefined ? String(opts.pipelineId) : undefined,
      user_id: opts.userId !== undefined ? String(opts.userId) : undefined,
      stage_id: opts.stageId !== undefined ? String(opts.stageId) : undefined,
      totals_convert_currency: 'USD',
    };
    // Note: /v1/deals/timeline returns `data: { totals, data: [periods] }`,
    // NOT the usual `data: [...]` envelope, so we type the inner shape directly.
    const resp = await this.request<{ success: boolean; data: { data?: RawTimelinePeriod[] } }>(
      '/v1/deals/timeline',
      query,
    );
    const periods = resp.data?.data ?? [];
    return periods.map((p) => ({
      period_start: p.period_start,
      period_end: p.period_end,
      count: p.totals?.count ?? 0,
      total_value_usd: p.totals?.values?.USD ?? 0,
      weighted_value_usd: p.totals?.weighted_values?.USD ?? 0,
      open_count: p.totals?.open_count ?? 0,
      open_value_usd: p.totals?.open_values?.USD ?? 0,
      won_count: p.totals?.won_count ?? 0,
      won_value_usd: p.totals?.won_values?.USD ?? 0,
    }));
  }

  /**
   * `/v1/deals/summary` — single rolled-up snapshot (no time series). Useful
   * for "deals open right now" / "total won lifetime" style queries.
   */
  async dealsSummary(opts: { status?: 'open' | 'won' | 'lost' | 'all_not_deleted'; pipelineId?: number; userId?: number }): Promise<DealsSummary> {
    const query: Record<string, string | undefined> = {
      status: opts.status,
      pipeline_id: opts.pipelineId !== undefined ? String(opts.pipelineId) : undefined,
      user_id: opts.userId !== undefined ? String(opts.userId) : undefined,
      totals_convert_currency: 'USD',
    };
    const resp = await this.request<{ success: boolean; data: { total_count?: number; total_currency_converted_value?: number; total_weighted_currency_converted_value?: number } }>(
      '/v1/deals/summary',
      query,
    );
    return {
      count: resp.data?.total_count ?? 0,
      total_value_usd: resp.data?.total_currency_converted_value ?? 0,
      weighted_value_usd: resp.data?.total_weighted_currency_converted_value ?? 0,
    };
  }
}
