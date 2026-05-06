import { randomUUID } from 'node:crypto';
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

export interface KlaviyoProfileInput {
  email: string;
  phone_number?: string;
  first_name?: string;
  last_name?: string;
  custom_source?: string;
  consented_at?: string;
}

export interface BulkSubscribeOptions {
  profiles: KlaviyoProfileInput[];
  listId?: string;
  channels: Array<'email' | 'sms'>;
  consentedAt?: string;
  defaultConsentSource?: string;
}

export interface BulkSubscribeResult {
  job_id: string;
}

export interface BulkImportJobStatus {
  jobId: string;
  status: 'queued' | 'processing' | 'complete' | 'failed';
  totalCount?: number;
  completedCount?: number;
  failedCount?: number;
  errors?: Array<{ detail: string }>;
}

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

  /** POST helper for `*-values-reports` endpoints (the only POSTs we make).
   *  Tolerates `content-length: 0` empty-body responses (Klaviyo's async POSTs
   *  like `profile-subscription-bulk-create-jobs` return 202 with no body).
   *  In that case the helper returns `null as T` — callers must handle it. */
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
    const text = await res.text();
    const data = text.length === 0 ? null : JSON.parse(text);
    logger.info({ path, status: res.status, elapsed, empty_body: text.length === 0 }, 'klaviyo api ok');
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

  /** POST /metric-aggregates/ — server-side aggregated counts of a metric over
   *  a date range, bucketed by interval (day | week | month). One ~500ms call
   *  returns the full series, no pagination, no rollup table required. The
   *  metric name is resolved to its id via `findMetricIdByName` (cached). */
  async metricAggregateByName(opts: {
    metricName: string;
    startDate: string; // YYYY-MM-DD inclusive
    endDate: string; // YYYY-MM-DD inclusive
    interval: 'day' | 'week' | 'month';
    timezone?: string; // default 'America/Los_Angeles'
    measurements?: string[]; // default ['count']
  }): Promise<{ dates: string[]; counts: number[] }> {
    const metricId = await this.findMetricIdByName(opts.metricName);
    if (!metricId) {
      throw new KlaviyoApiError(`metric '${opts.metricName}' not found in catalog`, 404, null);
    }
    const startISO = `${opts.startDate}T00:00:00.000Z`;
    // metric-aggregates uses a [start, end) window — advance the inclusive
    // YMD endDate by 1 day so the filter covers the whole final day.
    const endISO = `${addDaysYmd(opts.endDate, 1)}T00:00:00.000Z`;
    const body = {
      data: {
        type: 'metric-aggregate',
        attributes: {
          metric_id: metricId,
          measurements: opts.measurements ?? ['count'],
          interval: opts.interval,
          timezone: opts.timezone ?? 'America/Los_Angeles',
          filter: [
            `greater-or-equal(datetime,${startISO})`,
            `less-than(datetime,${endISO})`,
          ],
        },
      },
    };
    const resp = await this.post<{
      data: {
        attributes: {
          dates: string[];
          data: Array<{ measurements: Record<string, number[]> }>;
        };
      };
    }>('/metric-aggregates/', body);
    const dates = resp.data?.attributes?.dates ?? [];
    const counts = resp.data?.attributes?.data?.[0]?.measurements?.count ?? [];
    return { dates, counts };
  }

  /** POST /profile-subscription-bulk-create-jobs — kicks off an async job that
   *  subscribes a batch of profiles to email and/or sms marketing, optionally
   *  adding them to a list. Returns the Klaviyo job id; poll status via
   *  `getBulkImportJobStatus`. `defaultConsentSource` is the per-batch fallback
   *  custom_source applied when a row doesn't carry its own. */
  async bulkSubscribeProfiles(opts: BulkSubscribeOptions): Promise<BulkSubscribeResult> {
    // The Klaviyo bulk-subscribe endpoint is a strict JSON:API resource: profile
    // attributes are restricted to {email, phone_number, subscriptions}. first_name,
    // last_name, properties, and custom_source on the profile resource all 400.
    // For first_name/last_name we'd need a separate /api/profile-bulk-import-jobs
    // call — TODO: chain that BEFORE this when those fields are present.
    // custom_source goes at JOB level (data.attributes.custom_source).
    // list goes at JOB level via relationships.list (singular, one list per job).
    const subscriptions: Record<string, unknown> = {};
    if (opts.channels.includes('email')) subscriptions.email = { marketing: { consent: 'SUBSCRIBED' } };
    if (opts.channels.includes('sms')) subscriptions.sms = { marketing: { consent: 'SUBSCRIBED' } };

    const profileResources = opts.profiles.map((p) => {
      const attrs: Record<string, unknown> = { email: p.email };
      if (p.phone_number) attrs.phone_number = p.phone_number;
      attrs.subscriptions = subscriptions;
      return { type: 'profile', attributes: attrs };
    });

    const jobAttributes: Record<string, unknown> = {
      profiles: { data: profileResources },
      historical_import: false,
    };
    // Pick a single custom_source for the whole job — prefer the explicit
    // defaultConsentSource, else fall back to the first row's per-row source
    // (the profile-level field is rejected, so we lose per-row source granularity).
    const jobCustomSource =
      opts.defaultConsentSource ??
      opts.profiles.find((p) => p.custom_source)?.custom_source ??
      undefined;
    if (jobCustomSource) jobAttributes.custom_source = jobCustomSource;
    // NOTE: consented_at is rejected at the profile-resource level AND at the
    // job level. It only works if you pass it INSIDE subscriptions.email.marketing
    // AND set historical_import: true. For normal live imports we always want
    // current-time consent — Klaviyo records "now" automatically. If we ever
    // need to record a backdated consent (e.g., migrating from another tool),
    // we'd add a `historical: true` opt + place consented_at inside the
    // subscription. For the v1 import flow we just drop it.

    const body: Record<string, unknown> = {
      data: {
        type: 'profile-subscription-bulk-create-job',
        attributes: jobAttributes,
      },
    };
    if (opts.listId) {
      (body.data as Record<string, unknown>).relationships = {
        list: { data: { type: 'list', id: opts.listId } },
      };
    }

    // Klaviyo's bulk-subscribe endpoint returns HTTP 202 with an EMPTY body —
    // there is no job_id to track. The work is fire-and-forget from our side.
    // We synthesize a local id so callers (audit table, poller) have something
    // to key on. The poller treats `local-` prefixed ids as "verify by querying
    // the profiles directly" rather than "GET /profile-bulk-import-jobs/<id>".
    await this.post<unknown>('/profile-subscription-bulk-create-jobs', body);
    return { job_id: `local-bulksubscribe-${randomUUID()}` };
  }

  /** GET /profile-bulk-import-jobs/:id — poll status of a bulk subscribe job
   *  kicked off by `bulkSubscribeProfiles`. Returns parsed status + counts. */
  async getBulkImportJobStatus(jobId: string): Promise<BulkImportJobStatus> {
    const resp = await this.get<{ data: { id: string; attributes: any } }>(`/profile-bulk-import-jobs/${encodeURIComponent(jobId)}`);
    const a = resp?.data?.attributes ?? {};
    return {
      jobId: resp.data.id,
      status: a.status,
      totalCount: a.total_count,
      completedCount: a.completed_count,
      failedCount: a.failed_count,
      errors: a.errors,
    };
  }

  /** GET /profiles?filter=equals(email,"...") — single-profile lookup by email.
   *  Returns null when the email isn't on file. `created_at` is normalized
   *  across the two attribute names Klaviyo has used historically (`created`
   *  and `created_at`).
   *
   *  Klaviyo's collection /profiles endpoint does NOT currently support
   *  `include=lists` ("'lists' include is not currently supported when listing
   *  profiles"). To get list membership we make a separate /profiles/{id}/lists
   *  call. We do this lazily — only when a caller explicitly needs the list
   *  array — by following the `lists` relationship link. */
  async findProfileByEmail(email: string): Promise<{ id: string; created_at: string; lists: string[] } | null> {
    const filter = `equals(email,"${email.replace(/"/g, '\\"')}")`;
    const path = `/profiles?filter=${encodeURIComponent(filter)}&fields[profile]=email,created`;
    const resp = await this.get<{ data: any[] }>(path);
    const profile = resp?.data?.[0];
    if (!profile) return null;
    let lists: string[] = [];
    try {
      const listsResp = await this.get<{ data: any[] }>(`/profiles/${encodeURIComponent(profile.id)}/lists`);
      lists = (listsResp?.data ?? []).map((l: any) => l.attributes?.name ?? l.id);
    } catch (err) {
      // Non-fatal — return profile without list info if the lists endpoint hiccups.
      logger.warn({ err: String((err as any)?.message ?? err), profileId: profile.id }, 'klaviyo profile lists fetch failed');
    }
    return {
      id: profile.id,
      created_at: profile.attributes?.created ?? profile.attributes?.created_at,
      lists,
    };
  }

  /** POST /data-privacy-deletion-jobs — kicks off the GDPR/CCPA-compliant
   *  async profile deletion job (NOT the soft "suppress" path — this purges
   *  the profile and all associated events). Klaviyo accepts exactly one
   *  identifier on the inner profile attributes block; we prefer email,
   *  then phone_number, then profile_id. Returns the job id, which surfaces
   *  back to the user as a "submitted, processing within 30 days" receipt. */
  async requestProfileDeletion(opts: { email?: string; profile_id?: string; phone_number?: string }): Promise<{ deletion_job_id: string }> {
    if (!opts.email && !opts.profile_id && !opts.phone_number) {
      throw new Error('requestProfileDeletion requires email, profile_id, or phone_number');
    }
    const profileAttributes: Record<string, unknown> = {};
    if (opts.email) profileAttributes.email = opts.email;
    else if (opts.phone_number) profileAttributes.phone_number = opts.phone_number;
    else if (opts.profile_id) profileAttributes.id = opts.profile_id;

    const body = {
      data: {
        type: 'data-privacy-deletion-job',
        attributes: {
          profile: { data: { type: 'profile', attributes: profileAttributes } },
        },
      },
    };
    // Klaviyo's data-privacy-deletion-jobs endpoint also returns 202 + empty
    // body (same as bulk-subscribe). The work is fire-and-forget; we can't
    // poll a deletion-job. Synthesize a local id so the audit can record we
    // submitted this request.
    await this.post<unknown>('/data-privacy-deletion-jobs', body);
    return { deletion_job_id: `local-deletion-${randomUUID()}` };
  }

  /** Create a new Klaviyo list. **Defaults to `single_opt_in`** (NOT Klaviyo's
   *  default of `double_opt_in`). Reasoning: in our import flow, the operator
   *  (admin/marketing user) is curating a list of contacts who already gave
   *  consent — the audit row is the consent record, not a Klaviyo confirmation
   *  email. If we default to double_opt_in, every imported profile would just
   *  sit pending until they click an email Klaviyo sends, and the list would
   *  appear empty (we hit this in production smoke). Override with
   *  optInProcess: 'double_opt_in' if the caller really needs that flow.
   *  Returns { id, name }. Throws KlaviyoApiError on 4xx (e.g. duplicate name). */
  async createList(opts: { name: string; optInProcess?: 'single_opt_in' | 'double_opt_in' }): Promise<{ id: string; name: string }> {
    const attributes: Record<string, unknown> = {
      name: opts.name,
      opt_in_process: opts.optInProcess ?? 'single_opt_in',
    };
    const body = { data: { type: 'list', attributes } };
    const resp = await this.post<{ data: { id: string; attributes: { name: string } } }>('/lists', body);
    if (!resp?.data?.id) throw new KlaviyoApiError('Klaviyo returned no list id', 502, resp);
    return { id: resp.data.id, name: resp.data.attributes.name };
  }

  /** GET /lists — flat id+name directory used by `klaviyo.import_profiles`
   *  to resolve a human-readable list name to the list id required by the
   *  bulk-subscribe job. Klaviyo's `/api/lists` endpoint caps page size at 10
   *  (NOT 100 like other endpoints — sending `page[size]=100` returns 400).
   *  We use the shared `paginate` helper to follow `links.next`. */
  async listLists(): Promise<Array<{ id: string; name: string }>> {
    const rows = await this.paginate<{ name: string }>('/lists', { 'fields[list]': 'name', 'page[size]': '10' });
    return rows.map((l) => ({ id: l.id, name: l.attributes?.name ?? l.id }));
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
