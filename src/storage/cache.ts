import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export class TtlCache {
  constructor(private readonly client: SupabaseClient) {}

  static key(operationName: string, variables: Record<string, unknown>): string {
    const stable = stableStringify({ op: operationName, vars: variables });
    return createHash('sha256').update(stable).digest('hex');
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.client
      .from('northbeam_cache')
      .select('response,expires_at')
      .eq('cache_key', key)
      .gt('expires_at', nowIso)
      .maybeSingle();
    if (error) throw new Error(`Cache read failed: ${error.message}`);
    return (data?.response as T | undefined) ?? undefined;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const { error } = await this.client
      .from('northbeam_cache')
      .upsert({ cache_key: key, response: value, expires_at: expiresAt });
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
