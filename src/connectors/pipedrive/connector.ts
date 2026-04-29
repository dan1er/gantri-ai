import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import { DateRangeArg, normalizeDateRange } from '../base/date-range.js';
import { logger } from '../../logger.js';
import {
  PipedriveApiClient,
  PipedriveApiError,
  type Deal,
} from './client.js';

/**
 * Pipedrive CRM connector — read-only. 11 tools cover Gantri's full B2B
 * trade / wholesale CRM analytics surface (open pipeline value, deal
 * timeseries, top firms, lost-reason breakdown, rep leaderboards, activity
 * volume).
 *
 * Currency hard-coded to USD (Gantri's Pipedrive is single-currency). All
 * date-range tools use the shared `DateRangeArg` from `base/date-range.ts`
 * and call `normalizeDateRange()` before any logic. Pagination is capped
 * at 10 pages = ~5000 records — analytics tools that hit the cap return
 * `truncated: true` so the LLM can flag partial results.
 */

export interface PipedriveConnectorDeps {
  client: PipedriveApiClient;
}

export class PipedriveConnector implements Connector {
  readonly name = 'pipedrive';
  readonly tools: readonly ToolDef[];
  private readonly client: PipedriveApiClient;

  constructor(deps: PipedriveConnectorDeps) {
    this.client = deps.client;
    this.tools = this.buildTools();
  }

  async healthCheck() {
    try {
      const pipelines = await this.client.listPipelines();
      return { ok: true, detail: `${pipelines.length} pipelines` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Build a hash → human-name lookup from the dealFields catalog. The 3
   *  user-visible custom fields (Specifier/Purchaser/Source) live by hash;
   *  this resolver lets tools surface them by name without hard-coding hashes. */
  async resolveCustomFieldNames(): Promise<Map<string, string>> {
    const fields = await this.client.listDealFields();
    const map = new Map<string, string>();
    for (const f of fields) {
      // Hashed custom-field keys are 40-char hex; standard fields use short
      // names like 'value', 'title'. Only include hashed (custom) ones so
      // resolution can't accidentally rename a standard field.
      if (/^[a-f0-9]{40}$/.test(f.key)) map.set(f.key, f.name);
    }
    return map;
  }

  /** Resolve enum option ids inside a custom_fields blob.
   *  Example: input { f21bb44b...: 161 } → { Source: "ICFF" } */
  async resolveCustomFieldValues(deal: Deal): Promise<Record<string, unknown>> {
    const fields = await this.client.listDealFields();
    const out: Record<string, unknown> = {};
    const cf = deal.custom_fields ?? {};
    for (const f of fields) {
      if (!/^[a-f0-9]{40}$/.test(f.key)) continue;
      const raw = cf[f.key];
      if (raw === undefined || raw === null || raw === '') continue;
      if (Array.isArray(f.options) && f.options.length > 0) {
        const hit = f.options.find((o) => String(o.id) === String(raw));
        out[f.name] = hit?.label ?? raw;
      } else {
        out[f.name] = raw;
      }
    }
    return out;
  }

  private buildTools(): readonly ToolDef[] {
    return [
      this.toolListDirectory(),
      this.toolSearch(),
      this.toolDealTimeseries(),
      this.toolPipelineSnapshot(),
      this.toolListDeals(),
      this.toolDealDetail(),
    ];
  }

  // ============================================================
  // Group A — Discovery / lookup
  // ============================================================

  private toolListDirectory(): ToolDef {
    const Args = z.object({
      kind: z.enum(['pipelines', 'stages', 'users', 'deal_fields', 'source_options']).describe(
        'Which directory to fetch. The LLM should call this BEFORE any tool that filters by id/name.',
      ),
    });
    type A = z.infer<typeof Args>;
    return {
      name: 'pipedrive.list_directory',
      description: [
        'Returns the small static directories the LLM needs to map names → ids before calling other Pipedrive tools (pipelines/stages/users/deal_fields/source_options). Cached 10 min server-side.',
        'For "stages": each row carries `pipeline_id` AND `pipeline_name` so you can disambiguate cross-pipeline stages with the same label (Pipeline 1 and Pipeline 2 both have a stage called "Opportunity").',
        'For "deal_fields": only user-visible CUSTOM fields are returned (Specifier, Purchaser, Source). Standard fields (value/title/etc) are excluded.',
        'For "source_options": the dereferenced Source enum (ICFF, Design Miami, Neocon, …) so you can pass `sourceOptionId` to other tools.',
      ].join(' '),
      schema: Args as z.ZodType<A>,
      jsonSchema: zodToJsonSchema(Args),
      execute: async (rawArgs) => {
        const args = rawArgs as A;
        try {
          if (args.kind === 'pipelines') {
            const items = await this.client.listPipelines();
            return { ok: true, data: { kind: 'pipelines', rows: items.map((p) => ({ id: p.id, name: p.name, active: !!p.active })) } };
          }
          if (args.kind === 'stages') {
            const [stages, pipelines] = await Promise.all([this.client.listStages(), this.client.listPipelines()]);
            const nameById = new Map(pipelines.map((p) => [p.id, p.name] as const));
            return { ok: true, data: { kind: 'stages', rows: stages.map((s) => ({ id: s.id, pipeline_id: s.pipeline_id, pipeline_name: nameById.get(s.pipeline_id) ?? null, name: s.name, order_nr: s.order_nr })) } };
          }
          if (args.kind === 'users') {
            const users = await this.client.listUsers();
            return { ok: true, data: { kind: 'users', rows: users.filter((u) => u.active_flag).map((u) => ({ id: u.id, name: u.name, email: u.email, active: u.active_flag, is_admin: !!u.is_admin })) } };
          }
          if (args.kind === 'deal_fields') {
            const fields = await this.client.listDealFields();
            const customs = fields.filter((f) => /^[a-f0-9]{40}$/.test(f.key));
            return { ok: true, data: { kind: 'deal_fields', rows: customs.map((f) => ({ key: f.key, name: f.name, type: f.field_type, options: f.options ?? null })) } };
          }
          // source_options
          const fields = await this.client.listDealFields();
          const source = fields.find((f) => f.name === 'Source');
          return { ok: true, data: { kind: 'source_options', rows: source?.options ?? [] } };
        } catch (err) { return pipedriveErrorResult(err); }
      },
    };
  }

  private toolSearch(): ToolDef {
    const Args = z.object({
      query: z.string().min(1).describe('Substring or fuzzy search term — Pipedrive\'s native /v1/itemSearch.'),
      entity: z.enum(['all', 'deals', 'persons', 'organizations']).default('all').describe(
        'Restrict results to one entity type. "all" searches across deals + persons + orgs.',
      ),
      limit: z.number().int().min(1).max(100).default(10),
    });
    type A = z.infer<typeof Args>;
    return {
      name: 'pipedrive.search',
      description: [
        'Fuzzy substring search across Pipedrive deals, persons, and organizations via /v1/itemSearch. Returns minimal records with id, type, name, and a short summary.',
        'Use this to RESOLVE a name a user mentioned ("KBM-Hogue", "Bilotti", "Wirecutter") into the numeric id you need for `deal_detail`, `organization_detail`, etc. Optional `entity` to restrict the search.',
      ].join(' '),
      schema: Args as z.ZodType<A>,
      jsonSchema: zodToJsonSchema(Args),
      execute: async (rawArgs) => {
        const args = rawArgs as A;
        try {
          const itemTypes = args.entity === 'all' ? undefined :
            args.entity === 'deals' ? ['deal'] as const :
            args.entity === 'organizations' ? ['organization'] as const :
            ['person'] as const;
          const hits = await this.client.itemSearch({ term: args.query, itemTypes: itemTypes ? [...itemTypes] : undefined, limit: args.limit });
          return { ok: true, data: { query: args.query, count: hits.length, rows: hits.map((h) => ({ type: h.type, id: h.id, name: h.title, summary: h.summary, score: h.score })) } };
        } catch (err) { return pipedriveErrorResult(err); }
      },
    };
  }

  // ============================================================
  // Group B — Server-aggregated time-series
  // ============================================================

  private toolDealTimeseries(): ToolDef {
    const Args = z.object({
      dateRange: DateRangeArg,
      granularity: z.enum(['day', 'week', 'month', 'quarter']).default('month').describe('Bucket size — passed straight to /v1/deals/timeline `interval`.'),
      dateField: z.enum(['add_time', 'won_time', 'close_time', 'expected_close_date']).default('won_time').describe('Which timestamp anchors each deal to a bucket. Default `won_time` (revenue recognition view).'),
      pipelineId: z.number().int().optional(),
      ownerId: z.number().int().optional(),
      stageId: z.number().int().optional(),
      sourceOptionId: z.number().int().optional().describe('Filter by Source enum option id (use `pipedrive.list_directory` kind="source_options" to discover).'),
    });
    type A = z.infer<typeof Args>;
    return {
      name: 'pipedrive.deal_timeseries',
      description: [
        'Per-bucket counts and total/won/open value over a date range, server-aggregated by Pipedrive\'s /v1/deals/timeline. Filterable by pipeline, owner, stage, and Source enum option.',
        'Output rows: { key, count, totalValueUsd, wonCount, wonValueUsd, openCount, openValueUsd, weightedValueUsd }. `key` = period_start (YYYY-MM-DD). All amounts USD.',
        'Use for "monthly won-deal value YTD", "deals created per week in Q1", "ICFF leads converted by month".',
      ].join(' '),
      schema: Args as z.ZodType<A>,
      jsonSchema: zodToJsonSchema(Args),
      execute: async (rawArgs) => {
        const args = rawArgs as A;
        try {
          const { startDate, endDate } = normalizeDateRange(args.dateRange);
          // Compute # of buckets between start and end for the chosen granularity.
          const amount = bucketsBetween(startDate, endDate, args.granularity);
          const buckets = await this.client.dealsTimeline({
            startDate, amount, interval: args.granularity, fieldKey: args.dateField,
            pipelineId: args.pipelineId, userId: args.ownerId, stageId: args.stageId,
          });
          // sourceOptionId is not natively supported by /v1/deals/timeline as
          // a query param — so we surface it as a known limitation in the
          // note rather than silently ignore it.
          const sourceNote = args.sourceOptionId !== undefined
            ? `sourceOptionId filter not honored by /v1/deals/timeline; use pipedrive.list_deals + group client-side instead.`
            : null;
          return {
            period: { startDate, endDate },
            granularity: args.granularity,
            rows: buckets.map((b) => ({
              key: b.period_start,
              count: b.count,
              totalValueUsd: b.total_value_usd,
              wonCount: b.won_count,
              wonValueUsd: b.won_value_usd,
              openCount: b.open_count,
              openValueUsd: b.open_value_usd,
              weightedValueUsd: b.weighted_value_usd,
            })),
            note: sourceNote ?? undefined,
          };
        } catch (err) { return pipedriveErrorResult(err); }
      },
    };
  }

  private toolPipelineSnapshot(): ToolDef {
    const Args = z.object({
      pipelineId: z.number().int().optional().describe('Restrict to one pipeline. Omit to aggregate all pipelines.'),
      ownerId: z.number().int().optional(),
      status: z.enum(['open', 'won', 'lost', 'all']).default('open'),
    });
    type A = z.infer<typeof Args>;
    return {
      name: 'pipedrive.pipeline_snapshot',
      description: [
        'Point-in-time stage funnel: count + total value per stage in a pipeline (or all 4 pipelines). Hits /v2/deals filtered by status, then groups client-side by stage_id.',
        'Output rows: { stageId, stageName, pipelineId, pipelineName, count, totalValueUsd } — sorted by pipelineId then stage order_nr (so the funnel reads top-to-bottom).',
        'Returns `truncated: true` if the underlying scan hit the 10-page (~5000 deal) cap. Use for "open deals by stage now", "Made pipeline funnel", "stuck deals — biggest count by stage".',
      ].join(' '),
      schema: Args as z.ZodType<A>,
      jsonSchema: zodToJsonSchema(Args),
      execute: async (rawArgs) => {
        const args = rawArgs as A;
        try {
          const [stages, pipelines, dealsRes] = await Promise.all([
            this.client.listStages(),
            this.client.listPipelines(),
            this.client.listDeals({
              status: args.status === 'all' ? 'all_not_deleted' : args.status,
              pipelineId: args.pipelineId,
              ownerId: args.ownerId,
              limit: 500,
            }),
          ]);
          const pipelineNameById = new Map(pipelines.map((p) => [p.id, p.name] as const));
          const stageById = new Map(stages.map((s) => [s.id, s] as const));
          const counts = new Map<number, { count: number; total: number }>();
          for (const d of dealsRes.items) {
            const e = counts.get(d.stage_id) ?? { count: 0, total: 0 };
            e.count += 1;
            e.total += Number(d.value) || 0;
            counts.set(d.stage_id, e);
          }
          const rows = [...counts.entries()].map(([stageId, agg]) => {
            const s = stageById.get(stageId);
            return {
              stageId,
              stageName: s?.name ?? `stage_${stageId}`,
              pipelineId: s?.pipeline_id ?? 0,
              pipelineName: s ? (pipelineNameById.get(s.pipeline_id) ?? null) : null,
              count: agg.count,
              totalValueUsd: round2(agg.total),
            };
          }).sort((a, b) => (a.pipelineId - b.pipelineId) || ((stageById.get(a.stageId)?.order_nr ?? 0) - (stageById.get(b.stageId)?.order_nr ?? 0)));
          return {
            ok: true,
            data: {
              status: args.status,
              pipelineId: args.pipelineId ?? null,
              ownerId: args.ownerId ?? null,
              dealCount: dealsRes.items.length,
              truncated: dealsRes.hasMore,
              note: dealsRes.hasMore ? 'Result truncated at 10-page (~5000-deal) scan cap. Re-call with `pipelineId` to narrow.' : undefined,
              rows,
            },
          };
        } catch (err) { return pipedriveErrorResult(err); }
      },
    };
  }

  // ============================================================
  // Group C — Deal-level
  // ============================================================

  private toolListDeals(): ToolDef {
    const Args = z.object({
      dateRange: DateRangeArg.optional(),
      dateField: z.enum(['add_time', 'won_time', 'close_time', 'update_time']).default('update_time'),
      status: z.enum(['open', 'won', 'lost', 'deleted', 'all_not_deleted']).default('all_not_deleted'),
      pipelineId: z.number().int().optional(),
      stageId: z.number().int().optional(),
      ownerId: z.number().int().optional(),
      orgId: z.number().int().optional(),
      personId: z.number().int().optional(),
      sourceOptionId: z.number().int().optional(),
      search: z.string().optional().describe('Substring filter on deal title — applied client-side after fetch.'),
      sortBy: z.enum(['value', 'add_time', 'update_time', 'won_time']).default('value'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
      limit: z.number().int().min(1).max(500).default(50),
    });
    type A = z.infer<typeof Args>;
    return {
      name: 'pipedrive.list_deals',
      description: [
        'Cursor-paginated list of deals with the analytical fields. Hard cap of 500/call.',
        'Output rows: { id, title, status, valueUsd, pipelineId, stageId, ownerId, ownerName, orgId, orgName, personId, personName, addTime, wonTime, lostTime, lostReason, sourceLabel, specifierOrgName, purchaserOrgName, expectedCloseDate }.',
        'Use for "top 20 open deals by value", "lost deals last month with reasons", "all deals from ICFF source". Filter by status/pipeline/stage/owner/org/person/sourceOptionId.',
      ].join(' '),
      schema: Args as z.ZodType<A>,
      jsonSchema: zodToJsonSchema(Args),
      execute: async (rawArgs) => {
        const args = Args.parse(rawArgs);
        try {
          const range = args.dateRange ? normalizeDateRange(args.dateRange) : null;
          const [dealsRes, fields] = await Promise.all([
            this.client.listDeals({
              status: args.status,
              pipelineId: args.pipelineId,
              stageId: args.stageId,
              ownerId: args.ownerId,
              orgId: args.orgId,
              personId: args.personId,
              startDate: range?.startDate,
              endDate: range?.endDate,
              sortBy: args.sortBy,
              sortOrder: args.sortOrder,
              limit: args.limit,
            }),
            this.client.listDealFields(),
          ]);
          const sourceField = fields.find((f) => f.name === 'Source');
          const specifierField = fields.find((f) => f.name === 'Specifier');
          const purchaserField = fields.find((f) => f.name === 'Purchaser');
          const sourceOptions = new Map<string | number, string>((sourceField?.options ?? []).map((o) => [o.id, o.label] as const));

          let rows = dealsRes.items.map((d) => {
            const cf = d.custom_fields ?? {};
            const sourceRaw = sourceField ? cf[sourceField.key] : undefined;
            const sourceLabel = sourceRaw !== undefined && sourceRaw !== null
              ? sourceOptions.get(sourceRaw as string | number) ?? String(sourceRaw)
              : null;
            const specifierOrgName = specifierField ? (cf[specifierField.key] ?? null) : null;
            const purchaserOrgName = purchaserField ? (cf[purchaserField.key] ?? null) : null;
            const owner = typeof d.owner_id === 'object' && d.owner_id !== null
              ? d.owner_id
              : { id: d.owner_id as number, name: null as string | null };
            const person = typeof d.person_id === 'object' && d.person_id !== null ? d.person_id : null;
            const org = typeof d.org_id === 'object' && d.org_id !== null ? d.org_id : null;
            // Client-side date filter (until v2 supports range query natively).
            if (range) {
              const tsStr = (d as unknown as Record<string, unknown>)[args.dateField] as string | undefined;
              if (tsStr) {
                const ymd = tsStr.slice(0, 10);
                if (ymd < range.startDate || ymd > range.endDate) return null;
              }
            }
            // Client-side filter on sourceOptionId since v2 doesn't expose it.
            if (args.sourceOptionId !== undefined && Number(sourceRaw) !== args.sourceOptionId) return null;
            // Client-side title substring search.
            if (args.search && !d.title.toLowerCase().includes(args.search.toLowerCase())) return null;
            return {
              id: d.id,
              title: d.title,
              status: d.status,
              valueUsd: round2(Number(d.value) || 0),
              pipelineId: d.pipeline_id,
              stageId: d.stage_id,
              ownerId: owner.id,
              ownerName: owner.name,
              orgId: org?.value ?? null,
              orgName: org?.name ?? null,
              personId: person?.value ?? null,
              personName: person?.name ?? null,
              addTime: d.add_time ?? null,
              wonTime: d.won_time ?? null,
              lostTime: d.lost_time ?? null,
              lostReason: d.lost_reason ?? null,
              sourceLabel,
              specifierOrgName,
              purchaserOrgName,
              expectedCloseDate: d.expected_close_date ?? null,
            };
          }).filter((r): r is NonNullable<typeof r> => r !== null);
          rows = rows.slice(0, args.limit);
          return {
            ok: true,
            data: {
              dateRange: range,
              count: rows.length,
              truncated: dealsRes.hasMore,
              note: dealsRes.hasMore ? 'Underlying scan hit the 10-page cap; tighten filters to ensure totals are exhaustive.' : undefined,
              rows,
            },
          };
        } catch (err) { return pipedriveErrorResult(err); }
      },
    };
  }

  private toolDealDetail(): ToolDef {
    const Args = z.object({ dealId: z.number().int().positive() });
    type A = z.infer<typeof Args>;
    return {
      name: 'pipedrive.deal_detail',
      description: [
        'Single deal with all fields, custom fields resolved to human names + linked person + org + last activity.',
        'Output extends list_deals row with: personDetail{name, emails, phones}, orgDetail{name, address, web}, lastActivity{type, subject, dueDate, done}, products[{name, qty, priceUsd}], notesCount, activitiesCount, doneActivitiesCount, customFields{...}.',
      ].join(' '),
      schema: Args as z.ZodType<A>,
      jsonSchema: zodToJsonSchema(Args),
      execute: async (rawArgs) => {
        const args = Args.parse(rawArgs);
        try {
          const deal = await this.client.getDeal(args.dealId);
          const orgIdNum = typeof deal.org_id === 'object' && deal.org_id !== null
            ? deal.org_id.value
            : (deal.org_id as number | null);
          const [orgDetail, activitiesRes, customFields] = await Promise.all([
            orgIdNum ? this.client.getOrganization(orgIdNum).catch(() => null) : Promise.resolve(null),
            this.client.listActivities({})
              .then((res) => ({ items: res.items.filter((a) => a.deal_id === args.dealId), hasMore: res.hasMore }))
              .catch(() => ({ items: [], hasMore: false })),
            this.resolveCustomFieldValues(deal),
          ]);
          const activities = activitiesRes.items;
          const lastActivity = activities.length > 0 ? activities[activities.length - 1] : null;
          const owner = typeof deal.owner_id === 'object' && deal.owner_id !== null
            ? deal.owner_id
            : { id: deal.owner_id as number, name: null as string | null };
          const person = typeof deal.person_id === 'object' && deal.person_id !== null ? deal.person_id : null;
          const org = typeof deal.org_id === 'object' && deal.org_id !== null ? deal.org_id : null;
          return {
            ok: true,
            data: {
              id: deal.id,
              title: deal.title,
              status: deal.status,
              valueUsd: round2(Number(deal.value) || 0),
              pipelineId: deal.pipeline_id,
              stageId: deal.stage_id,
              ownerId: owner.id,
              ownerName: owner.name,
              orgId: org?.value ?? orgIdNum,
              orgName: org?.name ?? orgDetail?.name ?? null,
              personId: person?.value ?? null,
              personName: person?.name ?? null,
              addTime: deal.add_time ?? null,
              wonTime: deal.won_time ?? null,
              lostTime: deal.lost_time ?? null,
              lostReason: deal.lost_reason ?? null,
              expectedCloseDate: deal.expected_close_date ?? null,
              orgDetail: orgDetail ? { id: orgDetail.id, name: orgDetail.name, address: orgDetail.address ?? null, web: orgDetail.web ?? null } : null,
              lastActivity: lastActivity ? { type: lastActivity.type, subject: lastActivity.subject, dueDate: lastActivity.due_date ?? null, done: lastActivity.done === 1 } : null,
              activitiesCount: activities.length,
              doneActivitiesCount: activities.filter((a) => a.done === 1).length,
              customFields,
            },
          };
        } catch (err) { return pipedriveErrorResult(err); }
      },
    };
  }
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

/** Number of buckets of size `interval` between two YYYY-MM-DD dates,
 *  inclusive on both ends. Used to compute the `amount` arg /v1/deals/timeline
 *  expects (it counts intervals from `start_date`). */
function bucketsBetween(start: string, end: string, interval: 'day' | 'week' | 'month' | 'quarter'): number {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const s = new Date(Date.UTC(sy, sm - 1, sd));
  const e = new Date(Date.UTC(ey, em - 1, ed));
  const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
  if (interval === 'day') return Math.max(1, days);
  if (interval === 'week') return Math.max(1, Math.ceil(days / 7));
  if (interval === 'month') return Math.max(1, (ey - sy) * 12 + (em - sm) + 1);
  // quarter
  const sq = Math.floor((sm - 1) / 3); const eq = Math.floor((em - 1) / 3);
  return Math.max(1, (ey - sy) * 4 + (eq - sq) + 1);
}

// Helper: registry-shaped error wrapper used by every tool.
export function pipedriveErrorResult(err: unknown) {
  if (err instanceof PipedriveApiError) {
    return { ok: false, error: { code: 'PIPEDRIVE_API_ERROR', status: err.status, message: err.message, body: err.body } };
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.warn({ err: message }, 'pipedrive tool internal error');
  return { ok: false, error: { code: 'PIPEDRIVE_INTERNAL_ERROR', message } };
}

// Re-exported so tools defined in later tasks share schema utilities cleanly.
export { DateRangeArg, normalizeDateRange, z, zodToJsonSchema };
