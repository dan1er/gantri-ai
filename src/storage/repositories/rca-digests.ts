import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Idempotency ledger for the twice-daily RCA reminder digest. One row per
 * delivered slot, keyed `YYYY-MM-DD:HH` in America/New_York (`2026-07-28:08`).
 * The runner only posts when `get(slotKey)` is null. See
 * `migrations/0042_rca_digests.sql`.
 */
export interface RcaDigestRow {
  slotKey: string;
  sentAt: string | null;
  ticketCount: number;
  payload: unknown;
}

export class RcaDigestsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async get(slotKey: string): Promise<RcaDigestRow | null> {
    const { data, error } = await this.client
      .from('rca_digests')
      .select('*')
      .eq('slot_key', slotKey)
      .maybeSingle();
    if (error) throw new Error(`rca_digests get failed: ${error.message}`);
    if (!data) return null;
    return {
      slotKey: data.slot_key,
      sentAt: data.sent_at ?? null,
      ticketCount: data.ticket_count ?? 0,
      payload: data.payload,
    };
  }

  /** Record the slot as delivered. Upsert so two racing ticks collapse into one
   *  row instead of raising a duplicate-key error. */
  async insert(slotKey: string, ticketCount: number, payload: unknown): Promise<void> {
    const { error } = await this.client
      .from('rca_digests')
      .upsert({ slot_key: slotKey, ticket_count: ticketCount, payload }, { onConflict: 'slot_key' });
    if (error) throw new Error(`rca_digests insert failed: ${error.message}`);
  }
}
