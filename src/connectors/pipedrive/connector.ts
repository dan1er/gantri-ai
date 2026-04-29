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
