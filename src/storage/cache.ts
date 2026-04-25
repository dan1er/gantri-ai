import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface CacheSetOptions {
  /** TTL in seconds. Required when `frozen` is false (or omitted). Ignored when `frozen` is true. */
  ttlSec?: number;
  /** When true, the row never expires — used for fully-closed historical periods. */
  frozen?: boolean;
  /** Identifier for the tool whose result is being cached (e.g. `northbeam.overview`).
   *  Stored so we can later inspect/invalidate per-tool. Defaults to `'unknown'`. */
  tool?: string;
}

const FROZEN_EXPIRES_AT = '2099-01-01T00:00:00.000Z';

export class TtlCache {
  constructor(private readonly client: SupabaseClient) {}

  static key(operationName: string, variables: Record<string, unknown>): string {
    const stable = stableStringify({ op: operationName, vars: variables });
    return createHash('sha256').update(stable).digest('hex');
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.client
      .from('tool_result_cache')
      .select('response,expires_at')
      .eq('cache_key', key)
      .gt('expires_at', nowIso)
      .maybeSingle();
    if (error) throw new Error(`Cache read failed: ${error.message}`);
    return (data?.response as T | undefined) ?? undefined;
  }

  /**
   * Cache a value. Two call shapes:
   *   - `set(key, value, ttlSec)` — legacy 3-arg form.
   *   - `set(key, value, { ttlSec, frozen, tool })` — preferred form.
   */
  async set(key: string, value: unknown, ttlSecOrOptions: number | CacheSetOptions): Promise<void> {
    const opts: CacheSetOptions =
      typeof ttlSecOrOptions === 'number' ? { ttlSec: ttlSecOrOptions } : ttlSecOrOptions;
    const expiresAt = opts.frozen
      ? FROZEN_EXPIRES_AT
      : new Date(Date.now() + (opts.ttlSec ?? 0) * 1000).toISOString();
    const { error } = await this.client.from('tool_result_cache').upsert({
      cache_key: key,
      response: value,
      expires_at: expiresAt,
      tool: opts.tool ?? 'unknown',
      frozen: !!opts.frozen,
    });
    if (error) throw new Error(`Cache write failed: ${error.message}`);
  }
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k])).join(',') +
    '}'
  );
}
