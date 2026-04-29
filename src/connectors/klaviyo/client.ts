import { logger } from '../../logger.js';

/**
 * Minimal client for Klaviyo's REST API (current JSON:API generation, NOT the
 * legacy v1/v2). Read-only — every endpoint we hit is GET or POST-for-query.
 *
 * Auth: header `Authorization: Klaviyo-API-Key <pk_...>` plus `revision`
 * pinning the API contract version. We pin to a specific date instead of
 * tracking "latest" so a Klaviyo deploy can't silently break our parsing.
 *
 * Reporting endpoints (`*-values-reports`) have aggressive limits: 1/s burst,
 * 2/min steady, 225/day. The connector layer relies on `tool_result_cache` to
 * keep us well under that — past-period queries are settled, current-period
 * queries cache for ~5 min. Don't drop the cache.
 */

export interface KlaviyoApiConfig {
  /** Private API key (`pk_...`). Read-only scope is sufficient for this connector. */
  apiKey: string;
  /** API revision date — pinned, not "latest". Defaults to a known-good date. */
  revision?: string;
  /** Default `https://a.klaviyo.com/api`. */
  baseUrl?: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_REVISION = '2026-04-15';

export class KlaviyoApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'KlaviyoApiError';
  }
}

/** Unified shape for every JSON:API resource we touch — we only ever read
 *  `id` and `attributes`, so the inner attribute shape is per-resource. */
export interface KlaviyoResource<TAttrs = Record<string, unknown>> {
  type: string;
  id: string;
  attributes: TAttrs;
  [key: string]: unknown;
}

interface CollectionResponse<TAttrs> {
  data: KlaviyoResource<TAttrs>[];
  links?: {
    next?: string | null;
    self?: string | null;
    prev?: string | null;
  };
  [key: string]: unknown;
}

export interface KlaviyoCampaignAttrs {
  name: string;
  status: string; // Draft | Scheduled | Sending | Sent | Cancelled
  archived: boolean;
  channel?: string; // 'email' | 'sms' | 'mobile_push'
  send_strategy?: unknown;
  send_time?: string | null;
  scheduled_at?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface KlaviyoFlowAttrs {
  name: string;
  status: string; // draft | manual | live
  archived: boolean;
  trigger_type?: string;
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

export interface KlaviyoSegmentAttrs {
  name: string;
  is_active: boolean;
  is_processing: boolean;
  profile_count?: number;
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

export interface KlaviyoMetricAttrs {
  name: string;
  integration?: { name?: string; category?: string };
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

/** Profile resource attributes (`/api/profiles`). We only read `created`
 *  + `subscriptions.email.marketing.consent` for the consented-signups
 *  rollup; other fields are typed permissively because the JSON:API
 *  payload includes many we don't care about. */
export interface KlaviyoProfileAttrs {
  email?: string | null;
  created: string; // ISO 8601
  updated?: string;
  subscriptions?: {
    email?: { marketing?: { consent?: string; consent_timestamp?: string } };
    sms?: unknown;
  } | null;
  [key: string]: unknown;
}

/** A single row from a *-values-report response: dimension keys (`groupings`)
 *  + numeric stats. Stats requested mirror what the connector exposes. */
export interface ValuesReportRow {
  groupings: Record<string, string>;
  statistics: Record<string, number>;
}

export interface ValuesReportResponse {
  data: {
    type: string;
    id: string;
    attributes: { results: ValuesReportRow[] };
  };
}

/** Timeframe shape accepted by *-values-report endpoints. Either a preset key
 *  or a custom ISO datetime range. */
export type KlaviyoTimeframe =
  | { key: string }
  | { start: string; end: string };

export class KlaviyoApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly revision: string;
  /** In-memory TTL cache for directory lookups (campaigns/flows/segments/
   *  metrics). These don't depend on dateRange so they're shared across
   *  every tool call — without this, every campaign_performance/
   *  flow_performance invocation re-paginates a slow directory before
   *  doing any actual work. 10-minute TTL is a reasonable compromise:
   *  long enough to amortize across a Live Report's parallel steps,
   *  short enough that newly-created campaigns appear within minutes. */
  private readonly directoryCache = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly directoryTtlMs = 10 * 60 * 1000;

  constructor(private readonly cfg: KlaviyoApiConfig) {
    this.baseUrl = cfg.baseUrl ?? 'https://a.klaviyo.com/api';
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.revision = cfg.revision ?? DEFAULT_REVISION;
  }

  private async memoize<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const hit = this.directoryCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
    const value = await factory();
    this.directoryCache.set(key, { value, expiresAt: Date.now() + this.directoryTtlMs });
    return value;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Klaviyo-API-Key ${this.cfg.apiKey}`,
      revision: this.revision,
      accept: 'application/vnd.api+json',
      'content-type': 'application/vnd.api+json',
    };
  }

  /** GET helper. `path` starts with `/`. `query` keys are passed verbatim
   *  (Klaviyo uses bracketed keys like `filter`, `page[size]`, etc — caller
   *  encodes those as plain strings). */
  private async get<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, v);
    }
    const qs = params.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const t0 = Date.now();
    const res = await this.fetchImpl(url, { method: 'GET', headers: this.headers() });
    const elapsed = Date.now() - t0;
    if (!res.ok) {
      let body: unknown = null;
      try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
      logger.warn({ path, status: res.status, elapsed, body }, 'klaviyo api error');
      throw new KlaviyoApiError(`GET ${path} -> ${res.status}`, res.status, body);
    }
    const data = await res.json();
    logger.info({ path, status: res.status, elapsed }, 'klaviyo api ok');
    return data as T;
  }

  /** POST helper for `*-values-reports` endpoints (the only POSTs we make). */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const t0 = Date.now();
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const elapsed = Date.now() - t0;
    if (!res.ok) {
      let respBody: unknown = null;
      try { respBody = await res.json(); } catch { respBody = await res.text().catch(() => null); }
      logger.warn({ path, status: res.status, elapsed, body: respBody }, 'klaviyo api error');
      throw new KlaviyoApiError(`POST ${path} -> ${res.status}`, res.status, respBody);
    }
    const data = await res.json();
    logger.info({ path, status: res.status, elapsed }, 'klaviyo api ok');
    return data as T;
  }

  /** Walk every page of a JSON:API collection and return concatenated `data`.
   *  Klaviyo signals pagination via `links.next` (a fully-qualified URL) — we
   *  follow it directly so we don't have to re-encode params on each call.
   *  Capped by `maxPages` to bound the worst case if the cursor loops. */
  private async paginate<TAttrs>(
    initialPath: string,
    initialQuery: Record<string, string | undefined> = {},
    maxPages = 50,
  ): Promise<KlaviyoResource<TAttrs>[]> {
    const out: KlaviyoResource<TAttrs>[] = [];
    let firstResp = await this.get<CollectionResponse<TAttrs>>(initialPath, initialQuery);
    out.push(...firstResp.data);
    let next: string | null | undefined = firstResp.links?.next;
    let pages = 1;
    while (next && pages < maxPages) {
      const url = next; // already a full URL
      const t0 = Date.now();
      const res = await this.fetchImpl(url, { method: 'GET', headers: this.headers() });
      const elapsed = Date.now() - t0;
      if (!res.ok) {
        let body: unknown = null;
        try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
        logger.warn({ path: '<paginated>', status: res.status, elapsed, body }, 'klaviyo api error');
        throw new KlaviyoApiError(`GET <paginated> -> ${res.status}`, res.status, body);
      }
      const data = (await res.json()) as CollectionResponse<TAttrs>;
      logger.info({ path: '<paginated>', status: res.status, elapsed }, 'klaviyo api ok');
      out.push(...data.data);
      next = data.links?.next;
      pages += 1;
    }
    return out;
  }

  /** Walk every page of a JSON:API collection without the 50-page cap that
   *  `paginate` enforces. ONLY for jobs where we actually need to read every
   *  matching resource (e.g. the consented-signups rollup walking all
   *  profiles created in a day). A 10000-page sanity cap still fires if the
   *  cursor loops, so we don't run forever silently. Sibling of `paginate`,
   *  not a replacement — pick the right tool. */
  private async paginateUnbounded<TAttrs>(initialPath: string): Promise<KlaviyoResource<TAttrs>[]> {
    const SANITY_CAP = 10000;
    const out: KlaviyoResource<TAttrs>[] = [];
    let url: string = `${this.baseUrl}${initialPath}`;
    let pageNum = 0;
    while (url) {
      if (pageNum >= SANITY_CAP) {
        throw new KlaviyoApiError(
          `paginateUnbounded exceeded ${SANITY_CAP}-page sanity cap; aborting`,
          0,
          null,
        );
      }
      const t0 = Date.now();
      const res = await this.fetchImpl(url, { method: 'GET', headers: this.headers() });
      const elapsed = Date.now() - t0;
      if (!res.ok) {
        let body: unknown = null;
        try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
        logger.warn({ path: '<paginateUnbounded>', status: res.status, elapsed, body }, 'klaviyo api error');
        throw new KlaviyoApiError(`GET <paginateUnbounded> -> ${res.status}`, res.status, body);
      }
      const json = (await res.json()) as CollectionResponse<TAttrs>;
      logger.info({ path: '<paginateUnbounded>', status: res.status, elapsed, page: pageNum }, 'klaviyo api ok');
      out.push(...(json.data ?? []));
      url = json.links?.next ?? '';
      pageNum++;
    }
    return out;
  }

  /** All metrics in the account. Used at boot to discover the "Placed Order"
   *  metric id, which the *-values-reports require as `conversion_metric_id`.
   *  Memoized — the metrics list is stable across a process lifetime. */
  async listMetrics(): Promise<KlaviyoResource<KlaviyoMetricAttrs>[]> {
    return this.memoize('metrics', () => this.paginate<KlaviyoMetricAttrs>('/metrics'));
  }

  /** Resolve the canonical revenue/conversions metric id by name. Klaviyo
   *  doesn't accept `equals(name,"...")` filters consistently across accounts,
   *  so we list all metrics (small, cached) and find by name client-side. */
  async findMetricIdByName(name: string): Promise<string | null> {
    const metrics = await this.listMetrics();
    const hit = metrics.find((m) => m.attributes.name === name);
    return hit?.id ?? null;
  }

  /** Campaigns directory. `channel` filter is required by Klaviyo (the
   *  campaigns endpoint won't list email + sms in one call) — caller chooses
   *  which channel they want. Memoized for 10 min — the directory doesn't
   *  shift between adjacent tool calls and re-paginating it costs ~5-10s. */
  async listCampaigns(opts: { channel: 'email' | 'sms' | 'mobile_push'; archived?: boolean } = { channel: 'email' }): Promise<KlaviyoResource<KlaviyoCampaignAttrs>[]> {
    const cacheKey = `campaigns:${opts.channel}:${opts.archived ?? 'any'}`;
    return this.memoize(cacheKey, () => {
      const filterParts = [`equals(messages.channel,"${opts.channel}")`];
      if (opts.archived !== undefined) filterParts.push(`equals(archived,${opts.archived})`);
      return this.paginate<KlaviyoCampaignAttrs>('/campaigns', {
        filter: filterParts.join(','),
      });
    });
  }

  /** Flows directory — no channel filter, every account-wide flow regardless
   *  of trigger. Memoized for 10 min (same rationale as listCampaigns). */
  async listFlows(opts: { archived?: boolean } = {}): Promise<KlaviyoResource<KlaviyoFlowAttrs>[]> {
    const cacheKey = `flows:${opts.archived ?? 'any'}`;
    return this.memoize(cacheKey, () => {
      const query: Record<string, string | undefined> = {};
      if (opts.archived !== undefined) query.filter = `equals(archived,${opts.archived})`;
      return this.paginate<KlaviyoFlowAttrs>('/flows', query);
    });
  }

  /** Segments directory. NOTE: revision 2026-04-15 dropped the
   *  `additional-fields[segment]=profile_count` parameter — segments no
   *  longer expose member counts via this endpoint. To get counts, pair
   *  this with `segmentValuesReport({statistics: ['total_members']})` and
   *  join on segment id (the connector's `klaviyo.list_segments` tool
   *  does this). Memoized for 10 min. */
  async listSegments(): Promise<KlaviyoResource<KlaviyoSegmentAttrs>[]> {
    return this.memoize('segments', () => this.paginate<KlaviyoSegmentAttrs>('/segments'));
  }

  /** POST /segment-values-reports — per-segment aggregates over a window.
   *  The only reliable way to get `total_members` (current size) and
   *  `members_added`/`members_removed` (churn) on segments today.
   *  No `conversion_metric_id` required — this report is membership-only. */
  async segmentValuesReport(opts: {
    statistics: string[];
    timeframe: KlaviyoTimeframe;
    filter?: string;
  }): Promise<ValuesReportRow[]> {
    const body = {
      data: {
        type: 'segment-values-report',
        attributes: {
          statistics: opts.statistics,
          timeframe: opts.timeframe,
          ...(opts.filter ? { filter: opts.filter } : {}),
        },
      },
    };
    const resp = await this.post<ValuesReportResponse>('/segment-values-reports', body);
    return resp.data?.attributes?.results ?? [];
  }

  /** POST /campaign-values-reports — per-campaign aggregated stats over a
   *  date range. `conversion_metric_id` anchors revenue/conversion math
   *  (typically the "Placed Order" metric). `statistics` is the list of
   *  fields the caller wants populated; Klaviyo silently drops unknown ones.
   *  `filter` is optional JSON:API-style ("equals(send_channel,'email')"). */
  async campaignValuesReport(opts: {
    statistics: string[];
    conversionMetricId: string;
    timeframe: KlaviyoTimeframe;
    filter?: string;
  }): Promise<ValuesReportRow[]> {
    const body = {
      data: {
        type: 'campaign-values-report',
        attributes: {
          statistics: opts.statistics,
          timeframe: opts.timeframe,
          conversion_metric_id: opts.conversionMetricId,
          ...(opts.filter ? { filter: opts.filter } : {}),
        },
      },
    };
    const resp = await this.post<ValuesReportResponse>('/campaign-values-reports', body);
    return resp.data?.attributes?.results ?? [];
  }

  /** POST /flow-values-reports — same idea as campaigns, grouped by flow. */
  async flowValuesReport(opts: {
    statistics: string[];
    conversionMetricId: string;
    timeframe: KlaviyoTimeframe;
    filter?: string;
  }): Promise<ValuesReportRow[]> {
    const body = {
      data: {
        type: 'flow-values-report',
        attributes: {
          statistics: opts.statistics,
          timeframe: opts.timeframe,
          conversion_metric_id: opts.conversionMetricId,
          ...(opts.filter ? { filter: opts.filter } : {}),
        },
      },
    };
    const resp = await this.post<ValuesReportResponse>('/flow-values-reports', body);
    return resp.data?.attributes?.results ?? [];
  }

  /** GET /profiles filtered by `created` in [startDate, endDate] (inclusive
   *  YMD on both ends). Returns ALL matching profiles via unbounded
   *  pagination — designed for the consented-signups rollup that walks an
   *  entire day's signups. The `additional-fields[profile]=subscriptions`
   *  query param ensures we get the marketing-consent payload back without
   *  a follow-up fetch per profile.
   *
   *  `endDate` is inclusive at the YMD level; we translate it to a
   *  `less-than` (exclusive) on next-day midnight UTC, since Klaviyo's
   *  filter operators are open-interval on the high end. */
  async searchProfilesByCreatedRange(opts: { startDate: string; endDate: string }): Promise<KlaviyoResource<KlaviyoProfileAttrs>[]> {
    // Klaviyo's `created` field only supports greater-than / less-than (not -or-equal).
    // To keep startDate inclusive, subtract 1ms: greater-than(prevInstant) == greater-or-equal(startInstant).
    const startInclusiveMs = Date.UTC(
      Number(opts.startDate.slice(0, 4)),
      Number(opts.startDate.slice(5, 7)) - 1,
      Number(opts.startDate.slice(8, 10)),
    );
    const startExclusiveISO = new Date(startInclusiveMs - 1).toISOString();
    // End is already exclusive in the API, but our argument is YMD inclusive — so endExclusive = next-day midnight.
    const endExclusive = addDaysYmd(opts.endDate, 1);
    const endISO = `${endExclusive}T00:00:00.000Z`;
    const filter = `and(greater-than(created,${startExclusiveISO}),less-than(created,${endISO}))`;
    const params = new URLSearchParams();
    params.set('filter', filter);
    params.set('additional-fields[profile]', 'subscriptions');
    return this.paginateUnbounded<KlaviyoProfileAttrs>(`/profiles?${params.toString()}`);
  }
}

/** Add `n` days to a YMD-format string and return the result in YMD format,
 *  using UTC arithmetic so DST doesn't shift the boundary. Used by
 *  `searchProfilesByCreatedRange` to convert an inclusive end date to the
 *  next-day exclusive boundary Klaviyo's `less-than` operator wants. */
function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
