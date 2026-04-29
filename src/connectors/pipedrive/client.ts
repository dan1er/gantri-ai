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
  /** Stub used by tests; real implementations land in Task 3. */
  async listPipelines(): Promise<unknown[]> {
    const resp = await this.request<V1Response<unknown>>('/v1/pipelines');
    return resp.data ?? [];
  }

  /** Cached read-through helper. */
  protected async cacheGet<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const hit = this.directoryCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
    const value = await factory();
    this.directoryCache.set(key, { value, expiresAt: Date.now() + this.directoryTtlMs });
    return value;
  }
}
