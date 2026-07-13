import { logger } from '../../logger.js';
import { ASANA_API_BASE } from './board-config.js';

/**
 * Read-only client for the RAW Asana REST API (app.asana.com/api/1.0). Auth via
 * a Personal Access Token in the `Authorization: Bearer <token>` header.
 *
 * The RAW API paginates with offset tokens returned in `next_page.offset` — we
 * follow them until exhausted (50-page cap; the Software Board has ~130 tasks =
 * 2 pages at limit 100, and no single task has anywhere near 5000 stories).
 *
 * Every request retries ONCE on a 429 / 5xx after a short backoff; anything
 * still failing throws a typed `AsanaApiError`.
 */

export interface AsanaApiConfig {
  /** Personal Access Token — read-only scope is sufficient. */
  accessToken: string;
  /** Default `https://app.asana.com/api/1.0`. */
  baseUrl?: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Backoff between the failed attempt and the single retry. Default 500ms. */
  retryDelayMs?: number;
}

export class AsanaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'AsanaApiError';
  }
}

/** Asana wraps list responses as `{ data: [...], next_page: {...} | null }`
 *  and single-object responses as `{ data: {...} }`. */
interface AsanaEnvelope<T> {
  data: T;
  next_page?: { offset: string; path: string; uri: string } | null;
}

/** Only the fields the QA-stats tool reads. */
export interface AsanaEnumValue {
  gid: string;
}
export interface AsanaCustomFieldValue {
  gid: string;
  enum_value?: AsanaEnumValue | null;
}
export interface AsanaTask {
  gid: string;
  name: string;
  completed?: boolean;
  created_at?: string;
  modified_at?: string;
  permalink_url?: string;
  custom_fields?: AsanaCustomFieldValue[];
}
export interface AsanaStoryUser {
  gid?: string;
  name?: string;
}
export interface AsanaStory {
  gid: string;
  created_at?: string;
  created_by?: AsanaStoryUser | null;
  resource_subtype?: string;
  text?: string;
}
export interface AsanaUser {
  gid: string;
  name?: string;
  email?: string;
}

/** Asana caps `limit` at 100. */
const PAGE_LIMIT = 100;
const DEFAULT_MAX_PAGES = 50;

export class AsanaApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;

  constructor(private readonly cfg: AsanaApiConfig) {
    this.baseUrl = cfg.baseUrl ?? ASANA_API_BASE;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.retryDelayMs = cfg.retryDelayMs ?? 500;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.accessToken}`,
      Accept: 'application/json',
    };
  }

  private async fetchOnce(url: string): Promise<Response> {
    return this.fetchImpl(url, { method: 'GET', headers: this.headers() });
  }

  /** GET with one retry on 429/5xx. `path` starts with `/`. Returns the parsed
   *  Asana envelope so callers can read both `data` and `next_page`. */
  private async request<T>(
    path: string,
    query: Record<string, string | undefined> = {},
  ): Promise<AsanaEnvelope<T>> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, v);
    }
    const qs = params.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const t0 = Date.now();
    let res = await this.fetchOnce(url);
    if (res.status === 429 || res.status >= 500) {
      logger.warn({ path, status: res.status }, 'asana transient error — retrying once');
      await new Promise((r) => setTimeout(r, this.retryDelayMs));
      res = await this.fetchOnce(url);
    }
    const elapsed = Date.now() - t0;
    if (!res.ok) {
      let body: unknown = null;
      try { body = await res.clone().json(); } catch { body = await res.clone().text().catch(() => null); }
      logger.warn({ path, status: res.status, elapsed, body }, 'asana api error');
      throw new AsanaApiError(`GET ${path} -> ${res.status}`, res.status, body);
    }
    const data = await res.clone().json();
    logger.info({ path, status: res.status, elapsed }, 'asana api ok');
    return data as AsanaEnvelope<T>;
  }

  /** Follow `next_page.offset` until exhausted or `maxPages` is hit. */
  private async paginate<T>(
    path: string,
    query: Record<string, string | undefined> = {},
    maxPages = DEFAULT_MAX_PAGES,
  ): Promise<T[]> {
    const out: T[] = [];
    let offset: string | undefined;
    let pages = 0;
    while (pages < maxPages) {
      const q: Record<string, string | undefined> = { ...query, limit: String(PAGE_LIMIT) };
      if (offset) q.offset = offset;
      const resp = await this.request<T[]>(path, q);
      out.push(...(resp.data ?? []));
      pages += 1;
      const next = resp.next_page;
      if (!next || !next.offset) break;
      offset = next.offset;
    }
    return out;
  }

  /** All tasks belonging to a project (offset-paginated). */
  async getProjectTasks(projectGid: string, optFields: string): Promise<AsanaTask[]> {
    return this.paginate<AsanaTask>(`/projects/${projectGid}/tasks`, { opt_fields: optFields });
  }

  /** All stories (activity + comments) on a task (offset-paginated). */
  async getTaskStories(taskGid: string, optFields: string): Promise<AsanaStory[]> {
    return this.paginate<AsanaStory>(`/tasks/${taskGid}/stories`, { opt_fields: optFields });
  }

  /** The authenticated user — used for health checks and smoke reachability. */
  async getCurrentUser(): Promise<AsanaUser> {
    const resp = await this.request<AsanaUser>('/users/me', { opt_fields: 'name,email' });
    return resp.data;
  }
}
