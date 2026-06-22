import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import { DateRangeArg, normalizeDateRange } from '../base/date-range.js';
import { logger } from '../../logger.js';
import {
  SendgridApiClient,
  SendgridApiError,
  type SendgridMessageDetail,
} from './client.js';

/**
 * SendGrid transactional-email connector — read-only, STATELESS. Answers
 * "what emails did <recipient> receive?" purely from SendGrid's Email Activity
 * API on each call. Nothing is persisted.
 *
 * Tool surface (two tools):
 *   - `sendgrid.email_activity` — list the transactional emails a recipient
 *     received, with status + open/click counts.
 *   - `sendgrid.message_detail` — the full per-event timeline for one message.
 *
 * Caveats the LLM must know (and the tool descriptions repeat):
 *   - These are TRANSACTIONAL emails Porter sends via SendGrid (order
 *     confirmation, shipping, delivery, password reset, …) — NOT marketing
 *     (that's Klaviyo).
 *   - Retention is ~30 days. Anything older is not queryable.
 *   - Requires the paid "Email Activity History" add-on; without it the API
 *     403s (surfaced in healthCheck and in tool errors).
 */
export interface SendgridConnectorDeps {
  client: SendgridApiClient;
}

/** Max rows per email_activity call we'll enrich with template metadata. Each
 *  needs its own getMessage call (the list endpoint omits template_id), so we
 *  cap the fan-out and mark the rest truncated. */
const TEMPLATE_ENRICHMENT_CAP = 50;
/** How many per-row getMessage calls run at once during enrichment. */
const ENRICHMENT_CONCURRENCY = 6;

export class SendgridConnector implements Connector {
  readonly name = 'sendgrid';
  readonly tools: readonly ToolDef[];
  private readonly client: SendgridApiClient;
  /** templateId → in-flight/resolved name lookup, scoped to this connector
   *  instance. Caching the PROMISE (not just the value) means concurrent rows
   *  sharing a template id collapse into one getTemplate call. Names that fail
   *  to resolve settle as null so we don't re-hit a 404/scope error. */
  private readonly templateNameCache = new Map<string, Promise<string | null>>();

  constructor(deps: SendgridConnectorDeps) {
    this.client = deps.client;
    this.tools = this.buildTools();
  }

  /**
   * Resolve a template id into `{ id, name }`, memoizing the name lookup.
   * Degrades gracefully: on any getTemplate failure (missing scope, 404, …) the
   * name is null but the id is still returned. Never throws.
   *
   * No editor URL is included: SendGrid's `mc.sendgrid.com/dynamic-templates/<id>`
   * deep link does not reliably open the template, so we surface the template
   * NAME (human-meaningful, searchable in the SendGrid UI) instead of a link.
   */
  private async resolveTemplate(templateId: string): Promise<{ id: string; name: string | null }> {
    let lookup = this.templateNameCache.get(templateId);
    if (!lookup) {
      lookup = this.client
        .getTemplate(templateId)
        .then((tpl) => tpl.name ?? null)
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ templateId, err: msg }, 'sendgrid template name lookup failed; returning id only');
          return null;
        });
      this.templateNameCache.set(templateId, lookup);
    }
    return { id: templateId, name: await lookup };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      // Minimal reachability probe: ask for a single message. An empty result
      // is still a healthy 200; a 403 means the Email Activity History add-on
      // is missing on the account.
      const rows = await this.client.listMessages({ query: '', limit: 1 });
      return { ok: true, detail: `email activity reachable (${rows.length} sample row${rows.length === 1 ? '' : 's'})` };
    } catch (err) {
      if (err instanceof SendgridApiError && err.status === 403) {
        return { ok: false, detail: 'sendgrid 403 — the account is likely missing the paid "Email Activity History" add-on (required for /v3/messages)' };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: msg };
    }
  }

  private buildTools(): readonly ToolDef[] {
    const EmailActivityArgs = z.object({
      toEmail: z.string().email().describe('Recipient email address to look up (the customer/address the email was sent TO).'),
      limit: z.number().int().min(1).max(1000).default(100).describe('Max messages to return. Default 100, API hard cap 1000.'),
      dateRange: DateRangeArg.optional().describe('Optional window to restrict by last_event_time. Omit for "all retained activity" (last ~30 days).'),
    });
    type EmailActivityArgs = z.infer<typeof EmailActivityArgs>;
    const emailActivityTool: ToolDef<EmailActivityArgs> = {
      name: 'sendgrid.email_activity',
      description: [
        'List the TRANSACTIONAL emails a specific recipient received, straight from SendGrid\'s Email Activity API. These are Porter-sent system emails (order confirmation, shipping notification, delivery, password reset, account emails) — NOT marketing campaigns (use Klaviyo for those).',
        'Use when asked "what emails did <customer/address> receive", "did this customer get the shipping/order/delivery email", "check delivery/open status for <address>", "why didn\'t X get their confirmation".',
        'Returns per-message status (delivered/bounced/processed/deferred/…), open/click counts, and a `template` object `{ id, name }` (the SendGrid template behind the email; name is null if it could not be resolved, template is null if the message has no template). Template enrichment is capped at the first 50 rows — `templateEnrichmentTruncated: true` flags when there were more. Feed a returned `msgId` into `sendgrid.message_detail` for the full event timeline.',
        'CAVEAT: SendGrid retains only ~30 days of activity — older emails are not queryable. Requires the paid "Email Activity History" add-on; without it the call returns a 403 error.',
      ].join(' '),
      schema: EmailActivityArgs as z.ZodType<EmailActivityArgs>,
      jsonSchema: zodToJsonSchema(EmailActivityArgs),
      execute: (args) => this.runEmailActivity(args as EmailActivityArgs),
    };

    const MessageDetailArgs = z.object({
      msgId: z.string().min(1).describe('SendGrid message id (`msgId`) returned by `sendgrid.email_activity`.'),
    });
    type MessageDetailArgs = z.infer<typeof MessageDetailArgs>;
    const messageDetailTool: ToolDef<MessageDetailArgs> = {
      name: 'sendgrid.message_detail',
      description: [
        'Full detail for ONE SendGrid transactional email: subject, recipient, sender, status, the per-event timeline (processed → delivered → open → click → …), a `template` object `{ id, name }` (the SendGrid template behind the email; null if none), and categories.',
        'Use after `sendgrid.email_activity` when the user wants to know exactly what happened to a specific email ("did they open it", "when was it delivered", "show the full timeline for that message").',
        'CAVEAT: same ~30-day retention and "Email Activity History" add-on requirement as `sendgrid.email_activity`.',
      ].join(' '),
      schema: MessageDetailArgs as z.ZodType<MessageDetailArgs>,
      jsonSchema: zodToJsonSchema(MessageDetailArgs),
      execute: (args) => this.runMessageDetail(args as MessageDetailArgs),
    };

    return [emailActivityTool, messageDetailTool];
  }

  private async runEmailActivity(args: { toEmail: string; limit: number; dateRange?: DateRangeArg }): Promise<unknown> {
    // Build the Email-Activity query DSL. Recipient filter is always present.
    let query = `to_email="${args.toEmail}"`;
    if (args.dateRange) {
      const { startDate, endDate } = normalizeDateRange(args.dateRange);
      // SendGrid's query DSL wants RFC3339 timestamps for BETWEEN. We widen the
      // YYYY-MM-DD window to start-of-day / end-of-day UTC so the range is
      // inclusive of both calendar days.
      // TODO: confirm exact DSL accepted by /v3/messages in the live smoke
      //       (BETWEEN TIMESTAMP "…" AND TIMESTAMP "…"). If the API rejects it,
      //       fall back to recipient-only and filter client-side.
      const startTs = `${startDate}T00:00:00Z`;
      const endTs = `${endDate}T23:59:59Z`;
      query += ` AND last_event_time BETWEEN TIMESTAMP "${startTs}" AND TIMESTAMP "${endTs}"`;
    }

    try {
      const messages = await this.client.listMessages({ query, limit: args.limit });
      const rows = messages.map((m) => ({
        msgId: m.msg_id,
        subject: m.subject,
        status: m.status,
        fromEmail: m.from_email,
        lastEventTime: m.last_event_time,
        opensCount: m.opens_count,
        clicksCount: m.clicks_count,
        template: null as { id: string; name: string | null } | null,
      }));

      // The list endpoint omits template_id, so enrich each row with its own
      // getMessage call. Cap the fan-out and run it in bounded-concurrency
      // batches so a big result set can't trigger a flood of API calls.
      const enrichCount = Math.min(rows.length, TEMPLATE_ENRICHMENT_CAP);
      const templateEnrichmentTruncated = rows.length > TEMPLATE_ENRICHMENT_CAP;
      for (let i = 0; i < enrichCount; i += ENRICHMENT_CONCURRENCY) {
        const batch = rows.slice(i, Math.min(i + ENRICHMENT_CONCURRENCY, enrichCount));
        await Promise.all(
          batch.map(async (row) => {
            try {
              const detail = await this.client.getMessage(row.msgId);
              row.template = detail.template_id ? await this.resolveTemplate(detail.template_id) : null;
            } catch (err) {
              // A single row failing to enrich must not fail the whole tool.
              const msg = err instanceof Error ? err.message : String(err);
              logger.warn({ msgId: row.msgId, err: msg }, 'sendgrid template enrichment failed for row');
              row.template = null;
            }
          }),
        );
      }

      return {
        toEmail: args.toEmail,
        count: messages.length,
        templateEnrichmentTruncated,
        rows,
      };
    } catch (err) {
      return sendgridErrorResult(err);
    }
  }

  private async runMessageDetail(args: { msgId: string }): Promise<unknown> {
    try {
      const d: SendgridMessageDetail = await this.client.getMessage(args.msgId);
      const template = d.template_id ? await this.resolveTemplate(d.template_id) : null;
      return {
        msgId: d.msg_id,
        subject: d.subject,
        toEmail: d.to_email,
        fromEmail: d.from_email,
        status: d.status,
        events: (d.events ?? []).map((e) => ({ name: e.event_name, at: e.processed })),
        template,
        categories: d.categories ?? [],
      };
    } catch (err) {
      return sendgridErrorResult(err);
    }
  }
}

/** Registry-shaped error wrapper shared by every tool. Surfaces the 403
 *  add-on-missing case with a clear, distinct code so the LLM can explain it. */
export function sendgridErrorResult(err: unknown) {
  if (err instanceof SendgridApiError) {
    if (err.status === 403) {
      return {
        ok: false,
        error: {
          code: 'SENDGRID_ADDON_REQUIRED',
          status: 403,
          message: 'SendGrid returned 403 — the Email Activity API requires the paid "Email Activity History" add-on on the account.',
          body: err.body,
        },
      };
    }
    return { ok: false, error: { code: 'SENDGRID_API_ERROR', status: err.status, message: err.message, body: err.body } };
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.warn({ err: message }, 'sendgrid tool internal error');
  return { ok: false, error: { code: 'SENDGRID_INTERNAL_ERROR', message } };
}
