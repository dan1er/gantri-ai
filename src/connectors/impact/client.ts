import { logger } from '../../logger.js';

/**
 * Minimal client for the Impact.com Brand (Advertiser) REST API.
 *
 * Auth: HTTP Basic where username = AccountSID, password = AuthToken
 * (creds live in Supabase Vault as IMPACT_ACCOUNT_SID / IMPACT_AUTH_TOKEN).
 *
 * Why we don't use the Reports endpoints: empirical probing showed every
 * `Reports/<id>` we tried returned 0 records or empty-string columns for
 * Gantri's account, even when actions clearly existed. The `/Actions` and
 * `/MediaPartners` raw endpoints work correctly, so the connector layer
 * aggregates over those instead. If reports start working we can revisit.
 */

export interface ImpactApiConfig {
  accountSid: string;
  authToken: string;
  /** default 'https://api.impact.com' */
  baseUrl?: string;
  /** default fetch — can be overridden for tests. */
  fetchImpl?: typeof fetch;
  /** Default page size for paginated endpoints. Impact caps at 20000. */
  pageSize?: number;
}

export class ImpactApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ImpactApiError';
  }
}

interface PaginatedResponse {
  '@total': string;
  '@page': string;
  '@numpages': string;
  '@nextpageuri': string;
  [key: string]: unknown;
}

export interface ImpactPartner {
  Id: string;
  Name: string;
  Description?: string;
  Mediatype?: string;
  Country?: string;
  Status?: string;
  /** Other fields are present but not standardized — the connector only
   *  exposes the fields the bot actually uses. */
  [key: string]: unknown;
}

export interface ImpactAction {
  Id: string;
  CampaignId: string;
  CampaignName: string;
  ActionTrackerName: string;
  EventCode: string;
  MediaPartnerId: string;
  MediaPartnerName: string;
  /** PENDING | APPROVED | LOCKED | CLEARED | REVERSED — Impact's lifecycle. */
  State: string;
  Amount: string;
  Payout: string;
  Currency: string;
  ReferringDate: string;
  EventDate: string;
  CreationDate: string;
  LockingDate: string;
  ClearedDate: string;
  ReferringType: string;
  PromoCode: string;
  /** Order id from the merchant's checkout (= Porter Transactions.id for Gantri). */
  Oid: string;
  CustomerStatus: string;
  CustomerCountry: string;
  CustomerRegion: string;
  CustomerCity: string;
  /** PII-safe: Impact stores hashed IPs, not raw. Other PII fields are blank
   *  or coarse (post-code area, city). No emails or names. */
  IpAddress: string;
  [key: string]: unknown;
}

export class ImpactApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pageSize: number;

  constructor(private readonly cfg: ImpactApiConfig) {
    this.baseUrl = cfg.baseUrl ?? 'https://api.impact.com';
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.pageSize = cfg.pageSize ?? 20000;
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64');
  }

  private async getJson<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const params = new URLSearchParams();
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
      }
    }
    const qs = params.toString();
    const url = `${this.baseUrl}/Advertisers/${this.cfg.accountSid}${path}${qs ? `?${qs}` : ''}`;
    const t0 = Date.now();
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: this.authHeader(), Accept: 'application/json' },
    });
    const elapsed = Date.now() - t0;
    if (!res.ok) {
      let body: unknown = null;
      try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
      logger.warn({ path, status: res.status, elapsed, body }, 'impact api error');
      throw new ImpactApiError(`GET ${path} -> ${res.status}`, res.status, body);
    }
    const data = await res.json();
    logger.info({ path, status: res.status, elapsed }, 'impact api ok');
    return data as T;
  }

  /** Paginate through ALL pages of a list endpoint and concatenate the items
   *  under `recordsKey`. Returns a flat array. Capped by `maxPages` to avoid
   *  runaway loops if Impact returns malformed pagination. */
  private async paginateAll<T>(
    path: string,
    recordsKey: string,
    query: Record<string, string | number | undefined> = {},
    maxPages = 50,
  ): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    while (page <= maxPages) {
      const data = await this.getJson<PaginatedResponse>(
        path,
        { ...query, PageSize: this.pageSize, Page: page },
      );
      const records = (data[recordsKey] as T[] | undefined) ?? [];
      out.push(...records);
      const next = data['@nextpageuri'];
      if (!next) break;
      page += 1;
    }
    return out;
  }

  /** All media partners (active + inactive) attached to the brand account. */
  async listPartners(): Promise<ImpactPartner[]> {
    return this.paginateAll<ImpactPartner>('/MediaPartners', 'Partners');
  }

  /** All actions in a date range for a given campaign. Impact's `/Actions`
   *  endpoint caps the window at 45 days (returns 400 otherwise), so we chunk
   *  longer ranges into ≤45-day slices and concatenate. Callers see one
   *  flat array regardless of input range — chunking is an implementation
   *  detail of this client. CampaignId is required by Impact; Gantri has
   *  exactly one (#19816, "Gantri"). */
  async listActions(opts: {
    campaignId: string;
    startDate: string; // YYYY-MM-DD
    endDate: string; // YYYY-MM-DD
  }): Promise<ImpactAction[]> {
    const slices = chunkDateRangeByDays(opts.startDate, opts.endDate, 45);
    const results = await Promise.all(slices.map((s) =>
      this.paginateAll<ImpactAction>('/Actions', 'Actions', {
        CampaignId: opts.campaignId,
        ActionDateStart: s.startDate,
        ActionDateEnd: s.endDate,
      }),
    ));
    return results.flat();
  }

  /** Single campaign listing — useful for discovering CampaignId at boot. */
  async listCampaigns(): Promise<Array<{ Id: string; Name: string; Currency?: string }>> {
    return this.paginateAll('/Campaigns', 'Campaigns', {}, 5);
  }
}

/** Split [startDate, endDate] (YYYY-MM-DD, inclusive) into contiguous slices
 *  whose span is at most `maxDays`. Returned slices reuse YYYY-MM-DD strings.
 *  Exported for unit testing. */
export function chunkDateRangeByDays(
  startDate: string,
  endDate: string,
  maxDays: number,
): Array<{ startDate: string; endDate: string }> {
  const startMs = Date.UTC(...ymdParts(startDate));
  const endMs = Date.UTC(...ymdParts(endDate));
  if (endMs < startMs) return [{ startDate, endDate }];
  const slices: Array<{ startDate: string; endDate: string }> = [];
  const oneDayMs = 86_400_000;
  let cursor = startMs;
  while (cursor <= endMs) {
    const sliceEnd = Math.min(cursor + (maxDays - 1) * oneDayMs, endMs);
    slices.push({ startDate: msToYmd(cursor), endDate: msToYmd(sliceEnd) });
    cursor = sliceEnd + oneDayMs;
  }
  return slices;
}

function ymdParts(ymd: string): [number, number, number] {
  const [y, m, d] = ymd.split('-').map(Number);
  return [y, m - 1, d];
}
function msToYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
