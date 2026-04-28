import { logger } from '../../logger.js';

/**
 * Minimal client for Google Search Console API. Auth is OAuth2 with a
 * refresh token (Danny's verified-owner account) — service-account flow
 * doesn't work because the GSC user UI rejects service-account emails.
 *
 * Three endpoints exposed: GET /sites, POST /searchAnalytics/query,
 * POST /urlInspection/index:inspect. Access tokens are minted on demand
 * from the long-lived refresh token and cached in-memory until ~5 min
 * before expiry.
 */

export interface SearchConsoleApiConfig {
  /** OAuth 2.0 client ID (`*.apps.googleusercontent.com`). */
  clientId: string;
  /** OAuth 2.0 client secret. */
  clientSecret: string;
  /** Long-lived refresh token captured during one-time consent. */
  refreshToken: string;
  /** Override base URL — defaults to https://searchconsole.googleapis.com */
  baseUrl?: string;
  /** Override OAuth token endpoint — defaults to https://oauth2.googleapis.com/token */
  tokenUrl?: string;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
}

export class SearchConsoleApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'SearchConsoleApiError';
  }
}

export interface SiteInfo {
  siteUrl: string;
  permissionLevel?: string;
}

export type GscDimension = 'date' | 'query' | 'page' | 'country' | 'device' | 'searchAppearance';

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
  responseAggregationType?: string;
}

export interface SearchAnalyticsRequest {
  startDate: string;
  endDate: string;
  dimensions?: GscDimension[];
  dimensionFilterGroups?: Array<{
    groupType?: 'and' | 'or';
    filters: Array<{
      dimension: GscDimension;
      operator: 'contains' | 'equals' | 'notContains' | 'notEquals' | 'includingRegex' | 'excludingRegex';
      expression: string;
    }>;
  }>;
  rowLimit?: number;
  startRow?: number;
  dataState?: 'all' | 'final';
  type?: 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews';
}

/** Subset of the URL Inspection response we care about. The raw response is
 *  deeply nested; the connector flattens it before returning. */
export interface InspectionResultRaw {
  inspectionResult?: {
    inspectionResultLink?: string;
    indexStatusResult?: {
      verdict?: string;
      coverageState?: string;
      robotsTxtState?: string;
      indexingState?: string;
      lastCrawlTime?: string;
      pageFetchState?: string;
      googleCanonical?: string;
      userCanonical?: string;
      sitemap?: string[];
      referringUrls?: string[];
      crawledAs?: string;
    };
    mobileUsabilityResult?: {
      verdict?: string;
      issues?: Array<{ issueType?: string; severity?: string; message?: string }>;
    };
    ampResult?: {
      verdict?: string;
      issues?: Array<{ issueType?: string; severity?: string; message?: string }>;
    };
    richResultsResult?: {
      verdict?: string;
      detectedItems?: Array<{ richResultType?: string; items?: Array<{ name?: string; issues?: Array<{ severity?: string; issueMessage?: string }> }> }>;
    };
  };
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export class SearchConsoleApiClient {
  private readonly baseUrl: string;
  private readonly tokenUrl: string;
  private readonly fetchImpl: typeof fetch;
  private cachedToken: CachedToken | null = null;

  constructor(private readonly cfg: SearchConsoleApiConfig) {
    this.baseUrl = cfg.baseUrl ?? 'https://searchconsole.googleapis.com';
    this.tokenUrl = cfg.tokenUrl ?? 'https://oauth2.googleapis.com/token';
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  /** Trade the long-lived refresh token for a short-lived access token.
   *  Cached in-memory until 5 min before expiry — Google issues 1-hour
   *  tokens, so a single refresh covers ~55 min of actual API use. */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 5 * 60 * 1000) {
      return this.cachedToken.accessToken;
    }
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      refresh_token: this.cfg.refreshToken,
      grant_type: 'refresh_token',
    });
    const t0 = Date.now();
    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const elapsed = Date.now() - t0;
    if (!res.ok) {
      let respBody: unknown = null;
      try { respBody = await res.json(); } catch { respBody = await res.text().catch(() => null); }
      logger.warn({ status: res.status, elapsed, body: respBody }, 'gsc oauth token refresh failed');
      throw new SearchConsoleApiError(`oauth token refresh failed: ${res.status}`, res.status, respBody);
    }
    const data = await res.json() as { access_token: string; expires_in: number };
    logger.info({ elapsed, expires_in: data.expires_in }, 'gsc oauth token refreshed');
    this.cachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getAccessToken();
    const url = `${this.baseUrl}${path}`;
    const t0 = Date.now();
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    const elapsed = Date.now() - t0;
    if (!res.ok) {
      // 401 → token may have just expired; force-refresh once and retry.
      if (res.status === 401) {
        logger.warn({ path, elapsed }, 'gsc 401 — invalidating cached token and retrying once');
        this.cachedToken = null;
        const retryToken = await this.getAccessToken();
        const retryRes = await this.fetchImpl(url, {
          ...init,
          headers: {
            ...(init.headers ?? {}),
            Authorization: `Bearer ${retryToken}`,
            Accept: 'application/json',
          },
        });
        if (retryRes.ok) {
          logger.info({ path, status: retryRes.status }, 'gsc api ok (after token refresh)');
          return retryRes.json() as Promise<T>;
        }
        let body: unknown = null;
        try { body = await retryRes.json(); } catch { body = await retryRes.text().catch(() => null); }
        throw new SearchConsoleApiError(`${init.method ?? 'GET'} ${path} -> ${retryRes.status}`, retryRes.status, body);
      }
      let body: unknown = null;
      try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
      logger.warn({ path, status: res.status, elapsed, body }, 'gsc api error');
      throw new SearchConsoleApiError(`${init.method ?? 'GET'} ${path} -> ${res.status}`, res.status, body);
    }
    const data = await res.json();
    logger.info({ path, status: res.status, elapsed }, 'gsc api ok');
    return data as T;
  }

  /** GET /webmasters/v3/sites — verified properties the user has access to. */
  async listSites(): Promise<SiteInfo[]> {
    const data = await this.request<{ siteEntry?: SiteInfo[] }>('/webmasters/v3/sites');
    return data.siteEntry ?? [];
  }

  /** POST /webmasters/v3/sites/{site}/searchAnalytics/query — the workhorse. */
  async searchAnalyticsQuery(siteUrl: string, body: SearchAnalyticsRequest): Promise<SearchAnalyticsResponse> {
    const path = `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    return this.request<SearchAnalyticsResponse>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** POST /v1/urlInspection/index:inspect — single-URL deep dive. */
  async inspectUrl(opts: { siteUrl: string; pageUrl: string; languageCode?: string }): Promise<InspectionResultRaw> {
    return this.request<InspectionResultRaw>('/v1/urlInspection/index:inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inspectionUrl: opts.pageUrl,
        siteUrl: opts.siteUrl,
        languageCode: opts.languageCode ?? 'en-US',
      }),
    });
  }
}
