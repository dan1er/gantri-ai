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
  /** Display name — populated when opt_fields includes `enum_value.name`. */
  name?: string;
}
export interface AsanaCustomFieldValue {
  gid: string;
  /** Field display name — populated when opt_fields includes `custom_fields.name`. */
  name?: string;
  enum_value?: AsanaEnumValue | null;
}
export interface AsanaTask {
  gid: string;
  name: string;
  completed?: boolean;
  created_at?: string;
  modified_at?: string;
  permalink_url?: string;
  /** Task description — populated when opt_fields includes `notes`. */
  notes?: string;
  custom_fields?: AsanaCustomFieldValue[];
  /** Only populated for subtasks (opt_fields includes created_by.name). */
  created_by?: AsanaStoryUser | null;
  /** Section/project memberships — populated when opt_fields includes
   *  `memberships.section.gid`. Used to detect the board section a task sits in. */
  memberships?: AsanaMembership[];
}
export interface AsanaMembership {
  project?: { gid?: string; name?: string } | null;
  section?: { gid?: string; name?: string } | null;
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
/** Sanity cap for full-history scans (1M tasks). A batch job that hits this is
 *  almost certainly looping, not legitimately huge. */
const UNBOUNDED_MAX_PAGES = 10000;

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

  /** POST/PUT the Asana API with the same single-retry-on-429/5xx policy as
   *  reads. Body is wrapped as `{ data: ... }` per the Asana convention and
   *  sent as JSON. Returns the parsed `data` of the response envelope. */
  private async write<T>(
    method: 'POST' | 'PUT',
    path: string,
    data: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    };
    const t0 = Date.now();
    let res = await this.fetchImpl(url, init);
    if (res.status === 429 || res.status >= 500) {
      logger.warn({ path, method, status: res.status }, 'asana transient error — retrying once');
      await new Promise((r) => setTimeout(r, this.retryDelayMs));
      res = await this.fetchImpl(url, init);
    }
    const elapsed = Date.now() - t0;
    if (!res.ok) {
      let body: unknown = null;
      try { body = await res.clone().json(); } catch { body = await res.clone().text().catch(() => null); }
      logger.warn({ path, method, status: res.status, elapsed, body }, 'asana api write error');
      throw new AsanaApiError(`${method} ${path} -> ${res.status}`, res.status, body);
    }
    const parsed = (await res.clone().json()) as AsanaEnvelope<T>;
    logger.info({ path, method, status: res.status, elapsed }, 'asana api write ok');
    return parsed.data;
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

  /** Like `paginate`, but with the 10K-page sanity cap instead of the 50-page
   *  default — for batch jobs that must see FULL project history (the Software
   *  Board keeps completed tasks, so it can exceed the 5000-task default cap).
   *  Logs a warning if the sanity cap is ever reached (results truncated). */
  private async paginateUnbounded<T>(
    path: string,
    query: Record<string, string | undefined> = {},
  ): Promise<T[]> {
    const out: T[] = [];
    let offset: string | undefined;
    let pages = 0;
    while (pages < UNBOUNDED_MAX_PAGES) {
      const q: Record<string, string | undefined> = { ...query, limit: String(PAGE_LIMIT) };
      if (offset) q.offset = offset;
      const resp = await this.request<T[]>(path, q);
      out.push(...(resp.data ?? []));
      pages += 1;
      const next = resp.next_page;
      if (!next || !next.offset) return out;
      offset = next.offset;
    }
    logger.warn(
      { path, pages, cap: UNBOUNDED_MAX_PAGES },
      'asana paginateUnbounded hit the 10K-page sanity cap — results are truncated',
    );
    return out;
  }

  /** All tasks belonging to a project (offset-paginated, 50-page cap). */
  async getProjectTasks(projectGid: string, optFields: string): Promise<AsanaTask[]> {
    return this.paginate<AsanaTask>(`/projects/${projectGid}/tasks`, { opt_fields: optFields });
  }

  /** Every task on a project with no 50-page cap — for full-history batch jobs
   *  (the delivery-tier poller and weekly report) that must not silently drop the
   *  newest tasks once the board grows past 5000. */
  async getProjectTasksUnbounded(projectGid: string, optFields: string): Promise<AsanaTask[]> {
    return this.paginateUnbounded<AsanaTask>(`/projects/${projectGid}/tasks`, { opt_fields: optFields });
  }

  /** All stories (activity + comments) on a task (offset-paginated). */
  async getTaskStories(taskGid: string, optFields: string): Promise<AsanaStory[]> {
    return this.paginate<AsanaStory>(`/tasks/${taskGid}/stories`, { opt_fields: optFields });
  }

  /** All subtasks of a task (offset-paginated). QA logs defects here by
   *  convention, so these feed bounce evidence for the classifier. */
  async getTaskSubtasks(taskGid: string, optFields: string): Promise<AsanaTask[]> {
    return this.paginate<AsanaTask>(`/tasks/${taskGid}/subtasks`, { opt_fields: optFields });
  }

  /** A single task with the requested opt_fields. */
  async getTask(taskGid: string, optFields: string): Promise<AsanaTask> {
    const resp = await this.request<AsanaTask>(`/tasks/${taskGid}`, { opt_fields: optFields });
    return resp.data;
  }

  /** Set an enum custom field on a task to a specific option. Used by the
   *  delivery-tier classifier to write the computed T0/T1/T2 tier. */
  async setEnumCustomField(taskGid: string, fieldGid: string, optionGid: string): Promise<void> {
    await this.write<AsanaTask>('PUT', `/tasks/${taskGid}`, {
      custom_fields: { [fieldGid]: optionGid },
    });
  }

  /** Post a comment (story) on a task. When an `html` body (`<body>…</body>`) is
   *  given it is posted as Asana rich text (`html_text`); otherwise the plain `text`
   *  is posted. Returns the created story so callers can persist its gid. */
  async createStory(taskGid: string, text: string, html?: string): Promise<AsanaStory> {
    return this.writeStory('POST', `/tasks/${taskGid}/stories`, text, html);
  }

  /** Update an existing comment (story) in place. Only the comment's author can
   *  edit it — the bot always comments through the same PAT, so its own comments
   *  qualify. Used to refresh an unchanged verdict instead of re-posting it. Same
   *  rich-text handling as `createStory`. */
  async updateStory(storyGid: string, text: string, html?: string): Promise<AsanaStory> {
    return this.writeStory('PUT', `/stories/${storyGid}`, text, html);
  }

  /** Write a comment body, preferring Asana rich text (`html_text`) when an html
   *  variant is supplied. If Asana rejects the rich-text body with a 400 (a malformed
   *  `html_text` payload), retry ONCE with the plain `text` so a formatting slip never
   *  drops the comment entirely. Plain `text` directly when there is no html variant. */
  private async writeStory(
    method: 'POST' | 'PUT',
    path: string,
    text: string,
    html?: string,
  ): Promise<AsanaStory> {
    if (!html) return this.write<AsanaStory>(method, path, { text });
    try {
      return await this.write<AsanaStory>(method, path, { html_text: html });
    } catch (err) {
      if (err instanceof AsanaApiError && err.status === 400) {
        logger.warn({ path, method }, 'asana html_text write rejected (400) — retrying as plain text');
        return this.write<AsanaStory>(method, path, { text });
      }
      throw err;
    }
  }

  /** The authenticated user — used for health checks and smoke reachability. */
  async getCurrentUser(): Promise<AsanaUser> {
    const resp = await this.request<AsanaUser>('/users/me', { opt_fields: 'name,email' });
    return resp.data;
  }
}
