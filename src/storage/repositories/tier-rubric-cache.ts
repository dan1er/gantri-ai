import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Persisted last-known-good snapshot of the live Delivery Tier rubric page. A
 * single row (id = 1) holds the rendered page BODY, its parsed version, and the
 * adopted prompt hash. The `RubricSource` reads it on a cold boot so classification
 * survives a Notion outage, and re-writes it whenever it adopts a new page revision.
 * See `migrations/0040_tier_rubric_cache.sql`.
 */
export interface TierRubricCacheRow {
  /** The rendered page body markdown (pre machine-appendix). */
  pageText: string;
  /** Version parsed from the page's `Version: N` header. */
  version: number;
  /** sha256 of the adopted prompt text (body + repo-owned appendix). */
  hash: string;
}

const ROW_ID = 1;

export class TierRubricCacheRepo {
  constructor(private readonly client: SupabaseClient) {}

  /** Read the single cache row, or null when nothing has been persisted yet. */
  async get(): Promise<TierRubricCacheRow | null> {
    const { data, error } = await this.client
      .from('tier_rubric_cache')
      .select('*')
      .eq('id', ROW_ID)
      .maybeSingle();
    if (error) throw new Error(`tier_rubric_cache get failed: ${error.message}`);
    if (!data) return null;
    return {
      pageText: data.page_text as string,
      version: data.version as number,
      hash: data.hash as string,
    };
  }

  /** Insert or replace the single cache row (id is fixed at 1). */
  async put(row: TierRubricCacheRow): Promise<void> {
    const { error } = await this.client.from('tier_rubric_cache').upsert(
      {
        id: ROW_ID,
        page_text: row.pageText,
        version: row.version,
        hash: row.hash,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );
    if (error) throw new Error(`tier_rubric_cache put failed: ${error.message}`);
  }
}
