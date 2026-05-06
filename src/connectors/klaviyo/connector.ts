import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import { DateRangeArg, normalizeDateRange } from '../base/date-range.js';
import { logger } from '../../logger.js';
import {
  KlaviyoApiClient,
  KlaviyoApiError,
  type KlaviyoTimeframe,
} from './client.js';
import { validateBatch, type RawProfile } from './validation.js';
import type { KlaviyoImportsRepo } from '../../storage/repositories/klaviyo-imports.js';
import type { KlaviyoDeletionsRepo } from '../../storage/repositories/klaviyo-deletions.js';
import type { PendingConfirmationsRepo } from '../../storage/repositories/pending-confirmations.js';
import type { AuthorizedUsersRepo } from '../../storage/repositories/authorized-users.js';
import type { ActorContext, ThreadContext } from '../../orchestrator/orchestrator.js';

/**
 * Klaviyo email/SMS analytics connector — read-only. Mirrors the surface
 * shape we used for Impact: a few opinionated tools that wrap server-side
 * aggregation, plus directory lookups so the LLM can resolve names → ids.
 *
 *   - klaviyo.list_campaigns        — directory of sent campaigns (email | sms)
 *   - klaviyo.list_segments         — segments + member counts
 *   - klaviyo.campaign_performance  — per-campaign opens/clicks/revenue/etc
 *   - klaviyo.flow_performance      — per-flow same shape
 *   - klaviyo.consented_signups     — server-side metric-aggregates of the
 *                                     "Subscribed to Email Marketing" event,
 *                                     bucketed daily/weekly/monthly
 *
 * Klaviyo's `*-values-reports` endpoints are rate-limited HARD (1/s burst,
 * 2/min steady, 225/day). Don't disable the cache layer — every "answer"
 * built from these tools should be served from `tool_result_cache` in
 * steady state.
 */

export interface KlaviyoConnectorDeps {
  client: KlaviyoApiClient;
  importsRepo: KlaviyoImportsRepo;
  deletionsRepo: KlaviyoDeletionsRepo;
  pendingRepo: PendingConfirmationsRepo;
  usersRepo: AuthorizedUsersRepo;
  getActor: () => ActorContext | undefined;
  getActiveThread: () => ThreadContext | undefined;
}

const Channel = z.enum(['email', 'sms', 'mobile_push']).default('email')
  .describe('Klaviyo send channel. Defaults to email — most callers want email-specific stats.');

const ListCampaignsArgs = z.object({
  channel: Channel,
  search: z.string().optional().describe('Optional case-insensitive substring filter on the campaign name.'),
  archived: z.boolean().default(false).describe('Include archived campaigns. Default false (active campaigns only).'),
  limit: z.number().int().min(1).max(500).default(100).describe('Max campaigns to return after filtering. Default 100.'),
});
type ListCampaignsArgs = z.infer<typeof ListCampaignsArgs>;

const ListSegmentsArgs = z.object({
  search: z.string().optional().describe('Optional case-insensitive substring filter on the segment name.'),
  minProfileCount: z.number().int().min(0).optional().describe('Drop segments with fewer than N members. Useful for "show me real segments, not test ones".'),
  limit: z.number().int().min(1).max(500).default(100),
});
type ListSegmentsArgs = z.infer<typeof ListSegmentsArgs>;

/** The full Klaviyo statistics surface for `*-values-reports`. We expose the
 *  ones marketers care about; the LLM picks via `metrics`. */
const StatsList = z.array(z.enum([
  'recipients', 'delivered', 'delivery_rate',
  'opens', 'opens_unique', 'open_rate',
  'clicks', 'clicks_unique', 'click_rate', 'click_to_open_rate',
  'unsubscribes', 'unsubscribe_rate',
  'spam_complaints', 'spam_complaint_rate',
  'bounced', 'bounced_or_failed', 'bounce_rate', 'failed', 'failed_rate',
  'conversions', 'conversion_uniques', 'conversion_value', 'conversion_rate', 'revenue_per_recipient',
])).min(1).max(15);

const CampaignPerformanceArgs = z.object({
  dateRange: DateRangeArg,
  channel: Channel,
  metrics: StatsList.default(['recipients', 'open_rate', 'click_rate', 'conversion_uniques', 'conversion_value', 'unsubscribes']),
  sortBy: z.enum(['conversion_value', 'recipients', 'open_rate', 'click_rate', 'conversion_rate']).default('conversion_value').describe('Field to sort campaigns by, descending. Default conversion_value (= attributed revenue).'),
  limit: z.number().int().min(1).max(200).default(50),
});
type CampaignPerformanceArgs = z.infer<typeof CampaignPerformanceArgs>;

const FlowPerformanceArgs = z.object({
  dateRange: DateRangeArg,
  channel: z.enum(['email', 'sms', 'mobile_push', 'all']).default('email').describe('Filter rows by send_channel. "all" returns every channel a flow uses.'),
  metrics: StatsList.default(['recipients', 'open_rate', 'click_rate', 'conversion_uniques', 'conversion_value']),
  sortBy: z.enum(['conversion_value', 'recipients', 'open_rate', 'click_rate', 'conversion_rate']).default('conversion_value'),
  limit: z.number().int().min(1).max(200).default(50),
});
type FlowPerformanceArgs = z.infer<typeof FlowPerformanceArgs>;

const ConsentedSignupsArgs = z.object({
  dateRange: DateRangeArg.describe('Date window over which to count "Subscribed to Email Marketing" events.'),
  granularity: z.enum(['daily', 'weekly', 'monthly']).default('monthly')
    .describe("Aggregation bucket. 'monthly' is most common."),
});
type ConsentedSignupsArgs = z.infer<typeof ConsentedSignupsArgs>;

const ImportProfileRow = z.object({
  email: z.string().email(),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  phone: z.string().optional(),
  consent_source: z.string().max(200).optional(),
  consented_at: z.string().datetime().optional(),
});

const ImportProfilesArgs = z.object({
  list: z.string().optional()
    .describe('Klaviyo list id (alphanumeric ≥6 chars) or exact case-insensitive list name. If omitted, profiles are created/subscribed without being added to a list.'),
  channels: z.array(z.enum(['email', 'sms'])).min(1).max(2).default(['email'])
    .describe('Subscription channels to set to SUBSCRIBED for every row in the batch. Whole-batch, not per-row.'),
  default_consent_source: z.string().max(200).optional()
    .describe("Default custom_source for rows that don't carry one. Falls back to 'Slack import — <list_name> (<YYYY-MM-DD>)'."),
  source: z.enum(['inline', 'csv']).default('inline'),
  storage_path: z.string().optional()
    .describe("Set by the file_shared handler when source='csv'. Internal — the LLM should not pass this directly."),
  filename: z.string().optional()
    .describe("Set by the file_shared handler when source='csv'. Internal."),
  profiles: z.array(ImportProfileRow).min(1).max(1000),
});
type ImportProfilesArgs = z.infer<typeof ImportProfilesArgs>;

const DeleteProfilesArgs = z.object({
  emails: z.array(z.string().email()).min(1).max(50)
    .describe('Emails of profiles to delete (≤50). Deduplicated case-insensitively before lookup.'),
});
type DeleteProfilesArgs = z.infer<typeof DeleteProfilesArgs>;

const ImportStatusArgs = z.object({
  audit_id: z.string().uuid().optional(),
  klaviyo_job_id: z.string().optional(),
}).refine((d) => d.audit_id || d.klaviyo_job_id, {
  message: 'Provide audit_id or klaviyo_job_id',
});
type ImportStatusArgs = z.infer<typeof ImportStatusArgs>;

export class KlaviyoConnector implements Connector {
  readonly name = 'klaviyo';
  readonly tools: readonly ToolDef[];
  private readonly client: KlaviyoApiClient;
  private placedOrderMetricId: string | null = null;
  private metricDiscoveryAttempted = false;

  constructor(private readonly deps: KlaviyoConnectorDeps) {
    this.client = deps.client;
    this.tools = this.buildTools();
  }

  async healthCheck() {
    try {
      const id = await this.getPlacedOrderMetricId();
      return id ? { ok: true, detail: `Placed Order metric ${id}` } : { ok: false, detail: 'Placed Order metric not found' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Lazy-discover the Placed Order metric id. The `*-values-reports`
   *  endpoints require this as `conversion_metric_id` for revenue stats.
   *  Cached per-process; if Klaviyo is briefly unavailable we don't crash
   *  the bot, the next call retries. */
  private async getPlacedOrderMetricId(): Promise<string | null> {
    if (this.placedOrderMetricId) return this.placedOrderMetricId;
    if (this.metricDiscoveryAttempted) return null;
    try {
      const id = await this.client.findMetricIdByName('Placed Order');
      if (id) {
        this.placedOrderMetricId = id;
        logger.info({ metricId: id }, 'klaviyo placed-order metric resolved');
      } else {
        logger.warn('klaviyo Placed Order metric not found');
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'klaviyo metric discovery failed; will retry next call');
      return null;
    } finally {
      this.metricDiscoveryAttempted = true;
    }
    return this.placedOrderMetricId;
  }

  private buildTools(): readonly ToolDef[] {
    return [
      {
        name: 'klaviyo.list_campaigns',
        description: [
          'Directory of Klaviyo campaigns. One row per campaign with id, name, status (Draft|Sent|Cancelled), channel (email|sms), scheduled_at, send_time, archived flag.',
          'Use to RESOLVE a name the user mentioned ("Black Friday email") into the campaign_id needed for cross-references, OR to enumerate campaigns sent in a window.',
          'For performance metrics (open rate, revenue, etc.) use `klaviyo.campaign_performance` instead — this tool only returns metadata.',
        ].join(' '),
        schema: ListCampaignsArgs as z.ZodType<z.infer<typeof ListCampaignsArgs>>,
        jsonSchema: zodToJsonSchema(ListCampaignsArgs),
        execute: async (rawArgs) => { const args = rawArgs as ListCampaignsArgs;
          try {
            const all = await this.client.listCampaigns({ channel: args.channel, archived: args.archived });
            let filtered = args.search
              ? all.filter((c) => c.attributes.name?.toLowerCase().includes(args.search!.toLowerCase()))
              : all;
            const trimmed = filtered.slice(0, args.limit);
            return {
              ok: true,
              data: {
                channel: args.channel,
                totalAcrossAccount: all.length,
                count: trimmed.length,
                campaigns: trimmed.map((c) => ({
                  id: c.id,
                  name: c.attributes.name,
                  status: c.attributes.status,
                  channel: c.attributes.channel ?? args.channel,
                  archived: c.attributes.archived,
                  scheduled_at: c.attributes.scheduled_at ?? null,
                  send_time: c.attributes.send_time ?? null,
                  created_at: c.attributes.created_at ?? null,
                })),
              },
            };
          } catch (err) { return errorResult(err); }
        },
      },
      {
        name: 'klaviyo.list_segments',
        description: [
          'Klaviyo segments with current member counts and 30-day churn. Each row: id, name, profile_count (current size), members_added_30d, members_removed_30d, is_active, is_processing, created, updated.',
          'Use for "how many subscribers in segment X", "size of our segments", "which segments are growing", or to find segment ids before referencing them elsewhere.',
          'profile_count comes from POST /segment-values-reports — if that aggregation is briefly unavailable, the field is null but the segment still appears.',
        ].join(' '),
        schema: ListSegmentsArgs as z.ZodType<z.infer<typeof ListSegmentsArgs>>,
        jsonSchema: zodToJsonSchema(ListSegmentsArgs),
        execute: async (rawArgs) => { const args = rawArgs as ListSegmentsArgs;
          try {
            // Klaviyo's /segments endpoint stopped exposing member counts in
            // current revisions. The only reliable source today is the
            // segment-values-reports endpoint with `total_members`. Fetch
            // both in parallel and join — the values-report doesn't return
            // segment names, the directory doesn't return counts.
            const [directory, valuesRows] = await Promise.all([
              this.client.listSegments(),
              this.client.segmentValuesReport({
                statistics: ['total_members', 'members_added', 'members_removed'],
                timeframe: { key: 'last_30_days' },
              }).catch((err) => {
                logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'klaviyo segment-values-report failed; counts will be null');
                return [];
              }),
            ]);
            const countsById = new Map<string, { total_members?: number; members_added?: number; members_removed?: number }>();
            for (const row of valuesRows) {
              const id = row.groupings.segment_id;
              if (id) countsById.set(id, row.statistics);
            }
            let filtered = args.search
              ? directory.filter((s) => s.attributes.name?.toLowerCase().includes(args.search!.toLowerCase()))
              : directory.slice();
            if (args.minProfileCount !== undefined) {
              filtered = filtered.filter((s) => (countsById.get(s.id)?.total_members ?? 0) >= args.minProfileCount!);
            }
            // Sort by total_members desc so the largest segments surface first.
            filtered.sort((a, b) => (countsById.get(b.id)?.total_members ?? 0) - (countsById.get(a.id)?.total_members ?? 0));
            const trimmed = filtered.slice(0, args.limit);
            return {
              ok: true,
              data: {
                totalAcrossAccount: directory.length,
                count: trimmed.length,
                segments: trimmed.map((s) => {
                  const stats = countsById.get(s.id);
                  return {
                    id: s.id,
                    name: s.attributes.name,
                    profile_count: stats?.total_members ?? null,
                    members_added_30d: stats?.members_added ?? null,
                    members_removed_30d: stats?.members_removed ?? null,
                    is_active: s.attributes.is_active,
                    is_processing: s.attributes.is_processing,
                    created: s.attributes.created ?? null,
                    updated: s.attributes.updated ?? null,
                  };
                }),
              },
            };
          } catch (err) { return errorResult(err); }
        },
      },
      {
        name: 'klaviyo.campaign_performance',
        description: [
          'Per-campaign aggregated stats over a date range, served by Klaviyo\'s campaign-values-reports endpoint. Each row: campaign_id, send_channel, plus the requested statistics (open_rate, click_rate, conversion_uniques, conversion_value=attributed revenue, etc.).',
          'Use for "top campaigns by revenue last month", "open rate of our recent campaigns", "which campaign drove the most conversions in Q1".',
          'Revenue here is Klaviyo-attributed via the Placed Order conversion metric (last-touch within Klaviyo\'s default 5-day attribution window). For overall channel-level email revenue across NB/Porter, use the Northbeam tools instead.',
          'Statistic vocab: `recipients`, `delivered`, `opens`/`opens_unique`/`open_rate`, `clicks`/`clicks_unique`/`click_rate`, `click_to_open_rate`, `unsubscribes`/`unsubscribe_rate`, `bounce_rate`, `conversions`/`conversion_uniques`/`conversion_value`/`conversion_rate`, `revenue_per_recipient`. Pass only the ones you need to keep payload small.',
        ].join(' '),
        schema: CampaignPerformanceArgs as z.ZodType<z.infer<typeof CampaignPerformanceArgs>>,
        jsonSchema: zodToJsonSchema(CampaignPerformanceArgs),
        execute: async (rawArgs) => { const args = rawArgs as CampaignPerformanceArgs;
          try {
            const conversionMetricId = await this.getPlacedOrderMetricId();
            if (!conversionMetricId) return { ok: false, error: { code: 'KLAVIYO_NO_PLACED_ORDER_METRIC', message: 'Placed Order metric not found in account; cannot compute revenue/conversion stats.' } };
            const { startDate, endDate } = normalizeDateRange(args.dateRange);
            const timeframe = toKlaviyoTimeframe(startDate, endDate);
            // Resolve campaign names with one extra call so the LLM can render
            // human-readable rows. List is short for any single account.
            const [reportRows, campaigns] = await Promise.all([
              this.client.campaignValuesReport({
                statistics: args.metrics,
                timeframe,
                conversionMetricId,
                filter: `equals(send_channel,'${args.channel}')`,
              }),
              this.client.listCampaigns({ channel: args.channel, archived: false }).catch(() => []),
            ]);
            const nameById = new Map(campaigns.map((c) => [c.id, c.attributes.name] as const));
            const rows = reportRows.map((r) => ({
              campaign_id: r.groupings.campaign_id,
              campaign_name: nameById.get(r.groupings.campaign_id) ?? null,
              send_channel: r.groupings.send_channel ?? args.channel,
              ...r.statistics,
            }));
            const sorted = sortRows(rows, args.sortBy);
            const trimmed = sorted.slice(0, args.limit);
            const totals = aggregateTotals(rows, args.metrics);
            return {
              ok: true,
              data: {
                channel: args.channel,
                dateRange: { startDate, endDate },
                campaignCount: rows.length,
                totals,
                campaigns: trimmed,
              },
            };
          } catch (err) { return errorResult(err); }
        },
      },
      {
        name: 'klaviyo.flow_performance',
        description: [
          'Per-flow aggregated stats over a date range, from Klaviyo\'s flow-values-reports. Each row: flow_id, flow_message_id, send_channel + the requested statistics. Same statistic vocabulary as campaign_performance.',
          'Use for "which flows drove the most revenue last quarter", "open rate of the welcome series", "are abandoned-cart flows still healthy".',
          'For ranking the strongest revenue flows: pass `metrics: ["recipients","open_rate","click_rate","conversion_uniques","conversion_value"]` and `sortBy: "conversion_value"`.',
        ].join(' '),
        schema: FlowPerformanceArgs as z.ZodType<z.infer<typeof FlowPerformanceArgs>>,
        jsonSchema: zodToJsonSchema(FlowPerformanceArgs),
        execute: async (rawArgs) => { const args = rawArgs as FlowPerformanceArgs;
          try {
            const conversionMetricId = await this.getPlacedOrderMetricId();
            if (!conversionMetricId) return { ok: false, error: { code: 'KLAVIYO_NO_PLACED_ORDER_METRIC', message: 'Placed Order metric not found in account; cannot compute revenue/conversion stats.' } };
            const { startDate, endDate } = normalizeDateRange(args.dateRange);
            const timeframe = toKlaviyoTimeframe(startDate, endDate);
            const filter = args.channel === 'all' ? undefined : `equals(send_channel,'${args.channel}')`;
            const [reportRows, flows] = await Promise.all([
              this.client.flowValuesReport({
                statistics: args.metrics,
                timeframe,
                conversionMetricId,
                filter,
              }),
              this.client.listFlows({ archived: false }).catch(() => []),
            ]);
            const nameById = new Map(flows.map((f) => [f.id, f.attributes.name] as const));
            const rows = reportRows.map((r) => ({
              flow_id: r.groupings.flow_id,
              flow_message_id: r.groupings.flow_message_id,
              flow_name: nameById.get(r.groupings.flow_id) ?? null,
              send_channel: r.groupings.send_channel ?? null,
              ...r.statistics,
            }));
            const sorted = sortRows(rows, args.sortBy);
            const trimmed = sorted.slice(0, args.limit);
            const totals = aggregateTotals(rows, args.metrics);
            return {
              ok: true,
              data: {
                channel: args.channel,
                dateRange: { startDate, endDate },
                flowCount: rows.length,
                totals,
                flows: trimmed,
              },
            };
          } catch (err) { return errorResult(err); }
        },
      },
      {
        name: 'klaviyo.consented_signups',
        description:
          'Counts of "Subscribed to Email Marketing" events in Klaviyo, bucketed daily/weekly/monthly. Live ~500ms call to the metric-aggregates endpoint (server-side aggregation). Use for questions like "how many email signups did we get in March?" or "monthly consented signups in 2026". Includes new subscriptions AND re-subscriptions — counts the subscribe events, not "currently subscribed profiles created in window".',
        schema: ConsentedSignupsArgs as z.ZodType<ConsentedSignupsArgs>,
        jsonSchema: zodToJsonSchema(ConsentedSignupsArgs),
        execute: async (rawArgs) => {
          const args = rawArgs as ConsentedSignupsArgs;
          const { startDate, endDate } = normalizeDateRange(args.dateRange);
          const interval =
            args.granularity === 'monthly' ? 'month' :
            args.granularity === 'weekly' ? 'week' : 'day';
          const result = await this.client.metricAggregateByName({
            metricName: 'Subscribed to Email Marketing',
            startDate,
            endDate,
            interval,
          });
          // Klaviyo returns dates as ISO timestamps with the local-timezone
          // offset (e.g. "2026-01-01T08:00:00+00:00" for PT-anchored monthly
          // buckets). Reduce to YYYY-MM (monthly), YYYY-MM-DD (weekly start =
          // Mon, daily).
          const rows = result.dates.map((d, i) => {
            const ymd = d.slice(0, 10);
            const key = interval === 'month' ? ymd.slice(0, 7) : ymd;
            return { key, count: result.counts[i] ?? 0 };
          });
          return {
            period: { startDate, endDate },
            granularity: args.granularity,
            rows,
            note: "Counts events of type 'Subscribed to Email Marketing' (Klaviyo native metric). Includes new subscriptions and re-subscriptions. Differs from 'profiles created in window AND currently subscribed' — that definition is drift-tolerant; this one counts every subscribe event.",
          };
        },
      },
      {
        name: 'klaviyo.import_profiles',
        description: [
          'Bulk-create Klaviyo profiles + subscribe them to email/sms with consent.',
          'ADMIN or MARKETING role only — fails with FORBIDDEN otherwise.',
          'Up to 20 profiles inline; up to 1000 via attached CSV (set source="csv" + storage_path).',
          'When ≥1 row is invalid, returns kind:"awaiting_confirmation" — caller replies "yes" to import the valid subset or "cancel" to abort.',
          'When 0 invalid, imports directly and returns kind:"imported_directly" with audit_id and klaviyo_job_id; the caller will receive a DM when the job completes.',
          'Use ONLY when the user explicitly asks to "import", "add", "upload", "subscribe", "agregar a Klaviyo".',
        ].join(' '),
        schema: ImportProfilesArgs as z.ZodType<ImportProfilesArgs>,
        jsonSchema: zodToJsonSchema(ImportProfilesArgs),
        execute: (args) => this.runImport(args as ImportProfilesArgs),
      } as ToolDef<ImportProfilesArgs>,
      {
        name: 'klaviyo.delete_profiles',
        description: [
          'Permanently delete Klaviyo profiles by email (Klaviyo Data Privacy API).',
          'ADMIN or MARKETING role only — fails with FORBIDDEN otherwise.',
          'ALWAYS asks for confirmation — never auto-executes. Returns kind:"awaiting_confirmation" with a per-email preview; caller replies "yes" to proceed or "cancel" to abort.',
          'When 0 emails resolve to a Klaviyo profile, returns kind:"nothing_found" with no DB write.',
          'Up to 50 emails per call. Deletion is destructive and cannot be undone (Klaviyo provides no public undelete endpoint).',
          'Use ONLY when the user explicitly asks to "delete", "remove", "purge", "borrar", "eliminar".',
        ].join(' '),
        schema: DeleteProfilesArgs as z.ZodType<DeleteProfilesArgs>,
        jsonSchema: zodToJsonSchema(DeleteProfilesArgs),
        execute: (args) => this.runDelete(args as DeleteProfilesArgs),
      } as ToolDef<DeleteProfilesArgs>,
      {
        name: 'klaviyo.list_lists',
        description: [
          'Enumerate all Klaviyo lists (id + name).',
          'Open to ALL authorized users (read-only).',
          'Use BEFORE klaviyo.import_profiles to show the user the available lists when they didn\'t specify one. Also useful for "what lists do we have in Klaviyo?".',
          'Klaviyo lists are static audiences (NOT segments — segments are dynamic queries). For segment listing use klaviyo.list_segments.',
        ].join(' '),
        schema: z.object({}) as z.ZodType<Record<string, never>>,
        jsonSchema: zodToJsonSchema(z.object({})),
        execute: async () => {
          const lists = await this.client.listLists();
          return { count: lists.length, lists };
        },
      } as ToolDef<Record<string, never>>,
      {
        name: 'klaviyo.import_status',
        description: [
          'Look up the status of a previously-queued Klaviyo import.',
          'Open to ALL authorized users (read-only).',
          'Pass either audit_id (the UUID returned by klaviyo.import_profiles) or klaviyo_job_id (the Klaviyo-side job id from the same response).',
          'Returns the audit row with current status, counts, and list info.',
        ].join(' '),
        schema: ImportStatusArgs as z.ZodType<ImportStatusArgs>,
        jsonSchema: zodToJsonSchema(ImportStatusArgs),
        execute: (args) => this.runImportStatus(args as ImportStatusArgs),
      } as ToolDef<ImportStatusArgs>,
    ];
  }

  private async runImportStatus(args: ImportStatusArgs) {
    const row = args.audit_id
      ? await this.deps.importsRepo.getById(args.audit_id)
      : await this.deps.importsRepo.getByJobId(args.klaviyo_job_id!);
    if (!row) return { error: { code: 'NOT_FOUND', message: 'No import found with that id.' } };
    return {
      audit_id: row.id,
      klaviyo_job_id: row.klaviyoJobId,
      status: row.status,
      list: row.listId ? { id: row.listId, name: row.listName! } : null,
      channels: row.channels,
      total_submitted: row.totalSubmitted,
      total_imported: row.totalImported,
      total_invalid_rejected: row.totalInvalidRejected,
      succeeded_count: row.succeededCount ?? undefined,
      already_subscribed_count: row.alreadySubscribedCount ?? undefined,
      failed_count: row.failedCount ?? undefined,
      error_summary: row.errorSummary ?? undefined,
      started_at: row.startedAt,
      completed_at: row.completedAt ?? undefined,
    };
  }

  private async runDelete(args: DeleteProfilesArgs) {
    const actor = this.deps.getActor();
    if (!actor) return { error: { code: 'NO_ACTOR', message: 'klaviyo.delete_profiles requires an active actor.' } };
    const role = await this.deps.usersRepo.getRole(actor.slackUserId);
    if (role !== 'admin' && role !== 'marketing') {
      logger.warn({ caller: actor.slackUserId, role }, 'klaviyo_delete_denied');
      return { error: { code: 'FORBIDDEN', message: 'Klaviyo delete tools require role=admin or role=marketing.' } };
    }

    const [deletesInHour, pending] = await Promise.all([
      this.deps.deletionsRepo.countInLastHour(actor.slackUserId),
      this.deps.pendingRepo.countOutstanding(actor.slackUserId),
    ]);
    if (deletesInHour >= 5) return { error: { code: 'RATE_LIMITED', message: '5 deletes in the last hour; cool down.', details: { reason: 'deletes_per_hour' } } };
    if (pending >= 3) return { error: { code: 'PENDING_LIMIT', message: '3 pending confirmations outstanding; resolve them first.' } };

    const seen = new Set<string>();
    const dedupedOriginal: string[] = [];
    for (const e of args.emails) {
      const lower = e.toLowerCase();
      if (!seen.has(lower)) { seen.add(lower); dedupedOriginal.push(e); }
    }

    const lookups = await Promise.all(
      dedupedOriginal.map(async (email) => {
        try {
          const p = await this.deps.client.findProfileByEmail(email);
          return { email, profile: p };
        } catch (err: any) {
          return { email, profile: null as any, lookupError: String(err?.message ?? err) };
        }
      }),
    );

    const found = lookups
      .filter((l) => !!l.profile)
      .map((l) => ({
        email: l.email,
        profile_id: l.profile!.id,
        created_at: l.profile!.created_at,
        lists: l.profile!.lists,
      }));
    const not_found = lookups.filter((l) => !l.profile && !(l as any).lookupError).map((l) => l.email);

    if (found.length === 0) {
      return {
        kind: 'nothing_found' as const,
        requested_count: dedupedOriginal.length,
        message: `None of the ${dedupedOriginal.length} email${dedupedOriginal.length === 1 ? '' : 's'} matched a Klaviyo profile. Nothing to delete.`,
      };
    }

    const thread = this.deps.getActiveThread();
    const pendingRow = await this.deps.pendingRepo.insert({
      callerSlackId: actor.slackUserId,
      channelId: thread?.channelId ?? actor.slackChannelId ?? '',
      threadTs: thread?.threadTs ?? '',
      kind: 'klaviyo_delete',
      payload: { found, not_found, requested: dedupedOriginal },
    });

    return {
      kind: 'awaiting_confirmation' as const,
      confirmation_token: pendingRow.confirmationToken,
      requested_count: dedupedOriginal.length,
      found, not_found,
      message: `Delete ${found.length} profile${found.length === 1 ? '' : 's'}? Reply "yes" to proceed or "cancel" to abort. This cannot be undone.`,
    };
  }

  private async runImport(args: ImportProfilesArgs) {
    const actor = this.deps.getActor();
    if (!actor) return { error: { code: 'NO_ACTOR', message: 'klaviyo.import_profiles requires an active actor.' } };
    const role = await this.deps.usersRepo.getRole(actor.slackUserId);
    if (role !== 'admin' && role !== 'marketing') {
      logger.warn({ caller: actor.slackUserId, role }, 'klaviyo_write_denied');
      return { error: { code: 'FORBIDDEN', message: 'Klaviyo write tools require role=admin or role=marketing.' } };
    }

    const [inFlight, inHour, pending] = await Promise.all([
      this.deps.importsRepo.countInFlight(actor.slackUserId),
      this.deps.importsRepo.countInLastHour(actor.slackUserId),
      this.deps.pendingRepo.countOutstanding(actor.slackUserId),
    ]);
    if (inFlight >= 5) return { error: { code: 'RATE_LIMITED', message: '5 imports already in flight; wait for them to finish.', details: { reason: 'in_flight_imports' } } };
    if (inHour >= 20) return { error: { code: 'RATE_LIMITED', message: '20 imports in the last hour; cool down.', details: { reason: 'imports_per_hour' } } };
    if (pending >= 3) return { error: { code: 'PENDING_LIMIT', message: '3 pending confirmations outstanding; resolve them first.' } };

    let listId: string | null = null;
    let listName: string | null = null;
    if (args.list) {
      const lists = await this.deps.client.listLists();
      const exactById = lists.find((l) => l.id === args.list);
      const byName = exactById ?? lists.find((l) => l.name.toLowerCase() === args.list!.toLowerCase());
      if (!byName) {
        const needle = args.list.toLowerCase();
        const top5 = lists
          .filter((l) => l.name.toLowerCase().includes(needle))
          .slice(0, 5)
          .map(({ id, name }) => ({ id, name }));
        return { error: { code: 'LIST_NOT_FOUND', message: `No list matched "${args.list}".`, details: { suggestions: top5 } } };
      }
      listId = byName.id;
      listName = byName.name;
    }

    const raws: RawProfile[] = args.profiles.map((p, i) => ({
      rowIndex: i + 1, email: p.email, first_name: p.first_name, last_name: p.last_name,
      phone: p.phone, consent_source: p.consent_source, consented_at: p.consented_at,
    }));
    const v = validateBatch(raws, { channels: args.channels });

    if (v.valid.length === 0) {
      return {
        kind: 'all_invalid' as const,
        total_submitted: raws.length,
        invalid_count: v.invalid.length,
        invalid_rows: v.invalid,
        message: `All ${v.invalid.length} row${v.invalid.length === 1 ? '' : 's'} failed validation. Fix and re-submit.`,
      };
    }

    if (v.invalid.length === 0) {
      const consentedAt = new Date().toISOString();
      const result = await this.deps.client.bulkSubscribeProfiles({
        profiles: v.valid.map((p) => ({
          email: p.email,
          phone_number: p.phone_e164,
          first_name: p.first_name,
          last_name: p.last_name,
          custom_source: p.consent_source ?? args.default_consent_source ?? `Slack import — ${listName ?? 'no list'} (${consentedAt.slice(0, 10)})`,
          consented_at: p.consented_at ?? consentedAt,
        })),
        listId: listId ?? undefined,
        channels: args.channels,
      });
      const audit = await this.deps.importsRepo.insert({
        callerSlackId: actor.slackUserId, callerEmail: null,
        source: args.source, filename: args.filename ?? null, storagePath: args.storage_path ?? null,
        listId, listName, channels: args.channels,
        totalSubmitted: raws.length, totalImported: v.valid.length, totalInvalidRejected: 0,
        klaviyoJobId: result.job_id, status: 'queued',
      });
      logger.info({ auditId: audit.id, jobId: result.job_id, valid: v.valid.length }, 'klaviyo_import_queued');
      return {
        kind: 'imported_directly' as const,
        audit_id: audit.id, klaviyo_job_id: result.job_id, status: 'queued' as const,
        list: listId ? { id: listId, name: listName! } : null,
        channels: args.channels,
        total_submitted: raws.length, total_imported: v.valid.length, total_invalid_rejected: 0,
        message: `Queued ${v.valid.length} profile${v.valid.length === 1 ? '' : 's'} to Klaviyo${listName ? ` (list: ${listName})` : ''}. I'll DM when it's done.`,
      };
    }

    const thread = this.deps.getActiveThread();
    const pendingRow = await this.deps.pendingRepo.insert({
      callerSlackId: actor.slackUserId,
      channelId: thread?.channelId ?? actor.slackChannelId ?? '',
      threadTs: thread?.threadTs ?? '',
      kind: 'klaviyo_import',
      payload: {
        valid: v.valid, listId, listName, channels: args.channels,
        source: args.source, filename: args.filename ?? null, storagePath: args.storage_path ?? null,
        totalSubmitted: raws.length, totalInvalidRejected: v.invalid.length,
        defaultConsentSource: args.default_consent_source ?? null,
      },
    });
    return {
      kind: 'awaiting_confirmation' as const,
      confirmation_token: pendingRow.confirmationToken,
      total_submitted: raws.length, valid_count: v.valid.length, invalid_count: v.invalid.length,
      invalid_rows_preview: v.invalid.slice(0, 20),
      list: listId ? { id: listId, name: listName! } : null,
      channels: args.channels,
      message: `Found ${v.invalid.length} invalid row${v.invalid.length === 1 ? '' : 's'} out of ${raws.length}. Reply "yes" to import the ${v.valid.length} valid one${v.valid.length === 1 ? '' : 's'}, or "cancel" to abort.`,
    };
  }
}

/** Convert a normalized `{ startDate, endDate }` window into the shape
 *  Klaviyo's `*-values-reports` accept. We always emit `{ start, end }` with
 *  full-day UTC bounds for parity across our connectors. */
function toKlaviyoTimeframe(startDate: string, endDate: string): KlaviyoTimeframe {
  return {
    start: `${startDate}T00:00:00+00:00`,
    end: `${endDate}T23:59:59+00:00`,
  };
}

/** Sort rows desc by a given field. Stat values may be missing on rows where
 *  the metric doesn't apply — those go to the bottom. */
function sortRows<T extends Record<string, unknown>>(rows: T[], sortBy: string): T[] {
  return [...rows].sort((a, b) => {
    const av = typeof a[sortBy] === 'number' ? (a[sortBy] as number) : -Infinity;
    const bv = typeof b[sortBy] === 'number' ? (b[sortBy] as number) : -Infinity;
    return bv - av;
  });
}

/** Sum each requested metric across all rows. Skips rate-style metrics (which
 *  should NOT be summed — averaging them is also misleading per-row, so we
 *  just sum the raw counts). */
const SUMMABLE_METRICS = new Set([
  'recipients', 'delivered', 'opens', 'opens_unique', 'clicks', 'clicks_unique',
  'unsubscribes', 'spam_complaints', 'bounced', 'bounced_or_failed', 'failed',
  'conversions', 'conversion_uniques', 'conversion_value',
]);
function aggregateTotals(rows: Array<Record<string, unknown>>, metrics: string[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const m of metrics) {
    if (!SUMMABLE_METRICS.has(m)) continue;
    let s = 0;
    for (const r of rows) {
      const v = r[m];
      if (typeof v === 'number') s += v;
    }
    totals[m] = round2(s);
  }
  return totals;
}

function errorResult(err: unknown): { ok: false; error: { code: string; status?: number; message: string; body?: unknown } } {
  if (err instanceof KlaviyoApiError) {
    return { ok: false, error: { code: 'KLAVIYO_API_ERROR', status: err.status, message: err.message, body: err.body } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'KLAVIYO_INTERNAL_ERROR', message } };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
