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
    // Tool definitions added in Tasks 8-12.
    return [];
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
