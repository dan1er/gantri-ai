import { GoogleAuth, type AuthClient } from 'google-auth-library';
import { logger } from '../../logger.js';

export interface Ga4DateRange { startDate: string; endDate: string; name?: string }
export interface Ga4Dimension { name: string }
export interface Ga4Metric { name: string }
export interface Ga4OrderBy {
  metric?: { metricName: string };
  dimension?: { dimensionName: string };
  desc?: boolean;
}

export interface Ga4ReportRequest {
  dateRanges: Ga4DateRange[];
  dimensions?: Ga4Dimension[];
  metrics: Ga4Metric[];
  limit?: number;
  offset?: number;
  orderBys?: Ga4OrderBy[];
  dimensionFilter?: Record<string, unknown>;
  metricFilter?: Record<string, unknown>;
}

export interface Ga4Row {
  dimensionValues: Array<{ value: string }>;
  metricValues: Array<{ value: string }>;
}

export interface Ga4ReportResponse {
  dimensionHeaders: Array<{ name: string }>;
  metricHeaders: Array<{ name: string; type: string }>;
  rows: Ga4Row[];
  rowCount: number;
  metadata?: Record<string, unknown>;
}

export class Ga4ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown, message: string) {
    super(message);
    this.name = 'Ga4ApiError';
  }
}

export interface Ga4ClientConfig {
  propertyId: string;
  /** The full service-account JSON, as a string. */
  serviceAccountKey: string;
  /** Defaults to the v1beta endpoint. */
  baseUrl?: string;
  /** Optional fetch override, for tests. */
  fetchImpl?: typeof fetch;
  /** Optional auth-client factory override, for tests. Production code lets it default. */
  authFactory?: (key: unknown) => Pick<AuthClient, 'getRequestHeaders'>;
}

const TOKEN_CACHE_TTL_MS = 50 * 60 * 1000; // 50 min — token expires in 60.

export class Ga4Client {
  private cachedHeaders: Record<string, string> | null = null;
  private cachedAt = 0;
  private readonly fetch: typeof fetch;

  constructor(private readonly cfg: Ga4ClientConfig) {
    this.fetch = cfg.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    if (this.cachedHeaders && Date.now() - this.cachedAt < TOKEN_CACHE_TTL_MS) {
      return this.cachedHeaders;
    }
    const credentials = JSON.parse(this.cfg.serviceAccountKey) as Record<string, unknown>;
    const factory = this.cfg.authFactory ?? ((c: unknown) =>
      new GoogleAuth({
        credentials: c as { client_email: string; private_key: string },
        scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
      }).getClient());
    const client = await Promise.resolve(factory(credentials));
    const headers = await client.getRequestHeaders();
    this.cachedHeaders = headers as Record<string, string>;
    this.cachedAt = Date.now();
    logger.debug({ propertyId: this.cfg.propertyId }, 'ga4 access token refreshed');
    return this.cachedHeaders;
  }

  async runReport(req: Ga4ReportRequest): Promise<Ga4ReportResponse> {
    return this.post<Ga4ReportResponse>(`:runReport`, req);
  }

  private async post<T>(suffix: string, body: unknown): Promise<T> {
    const headers = await this.getAuthHeaders();
    const baseUrl = this.cfg.baseUrl ?? 'https://analyticsdata.googleapis.com/v1beta';
    const url = `${baseUrl}/properties/${this.cfg.propertyId}${suffix}`;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) {
      const msg = (parsed as { error?: { message?: string } } | null)?.error?.message ?? text.slice(0, 200);
      logger.warn({ status: res.status, body: parsed }, 'ga4 api error');
      throw new Ga4ApiError(res.status, parsed, `GA4 ${suffix} -> ${res.status}: ${msg}`);
    }
    return parsed as T;
  }
}
