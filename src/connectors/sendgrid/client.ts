import { logger } from '../../logger.js';

/**
 * Read-only client over SendGrid's Email Activity API
 * (https://www.twilio.com/docs/sendgrid/api-reference/e-mail-activity).
 *
 * Auth model: `Authorization: Bearer <apiKey>` header. The API key is a
 * SendGrid API key with at least "Email Activity" read scope.
 *
 * Surface:
 *   - `listMessages({ query, limit })` — GET /v3/messages, the Email Activity
 *     query DSL search. Returns the most-recent matching messages.
 *   - `getMessage(msgId)` — GET /v3/messages/{msg_id}, the per-message detail
 *     including the per-event timeline (processed, delivered, open, click, …).
 *
 * KNOWN HARD LIMITATIONS (not bugs — inherent to the API):
 *   1. The /v3/messages Email Activity API REQUIRES the paid "Email Activity
 *      History" add-on on the SendGrid account. Without it every call 403s.
 *      This is surfaced (not swallowed) in the connector healthCheck.
 *   2. Retention is ~30 days max. Messages older than that are not queryable —
 *      there is no "all-time" view of who got what.
 *   3. Max 1000 results per call (the API's own cap). `listMessages` caps the
 *      `limit` at 1000 accordingly.
 *
 * This is a STATELESS connector: nothing is persisted. Every tool call hits the
 * live API. No DB, no rollup job.
 */
export interface SendgridApiConfig {
  apiKey: string;
  /** Default `https://api.sendgrid.com`. */
  baseUrl?: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

export class SendgridApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'SendgridApiError';
  }
}

/** One row from GET /v3/messages — the Email Activity list shape. */
export interface SendgridMessage {
  msg_id: string;
  from_email: string;
  to_email: string;
  subject: string;
  status: string;
  opens_count: number;
  clicks_count: number;
  last_event_time: string;
}

/** GET /v3/messages/{msg_id} — list row plus the per-event timeline and
 *  template/category metadata. */
export interface SendgridMessageDetail extends SendgridMessage {
  events: Array<{ event_name: string; processed: string }>;
  template_id?: string;
  categories?: string[];
}

/** GET /v3/templates/{id} — the dynamic-template metadata we surface. The API
 *  returns many more fields (versions, etc.); we cast those away. */
export interface SendgridTemplate {
  id: string;
  name: string;
  generation: string;
}

/** The API's hard cap on results per /v3/messages call. */
const MAX_LIMIT = 1000;

export class SendgridApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: SendgridApiConfig) {
    this.baseUrl = cfg.baseUrl ?? 'https://api.sendgrid.com';
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      Accept: 'application/json',
    };
  }

  /**
   * GET /v3/messages?query=<urlencoded>&limit=<n>. The `query` is SendGrid's
   * Email-Activity query DSL (e.g. `to_email="x@y.com"`). The caller builds the
   * DSL string; this method only URL-encodes and sends it. `limit` defaults to
   * 100 and is capped at 1000 (the API max).
   */
  async listMessages(params: { query: string; limit?: number }): Promise<SendgridMessage[]> {
    const limit = Math.min(Math.max(1, params.limit ?? 100), MAX_LIMIT);
    const qs = new URLSearchParams();
    qs.set('query', params.query);
    qs.set('limit', String(limit));
    const body = await this.request<{ messages: SendgridMessage[] }>(`/v3/messages?${qs.toString()}`);
    return body.messages ?? [];
  }

  /** GET /v3/messages/{msg_id} — full per-message detail with event timeline. */
  async getMessage(msgId: string): Promise<SendgridMessageDetail> {
    return this.request<SendgridMessageDetail>(`/v3/messages/${encodeURIComponent(msgId)}`);
  }

  /**
   * GET /v3/templates/{id} — the template's metadata (id, name, generation).
   * Requires the Template Engine read scope on the API key. Extra fields the
   * API returns are cast away.
   */
  async getTemplate(templateId: string): Promise<SendgridTemplate> {
    const t = await this.request<SendgridTemplate>(`/v3/templates/${encodeURIComponent(templateId)}`);
    return { id: t.id, name: t.name, generation: t.generation };
  }

  // ---- internals ----

  private async request<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, { method: 'GET', headers: this.headers() });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { /* keep text */ }
    if (!res.ok) {
      logger.warn({ path, status: res.status, body: parsed }, 'sendgrid api error');
      throw new SendgridApiError(`GET ${path} -> ${res.status}`, res.status, parsed);
    }
    return parsed as T;
  }
}
