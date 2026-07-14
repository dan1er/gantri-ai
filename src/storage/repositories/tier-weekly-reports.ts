import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Idempotency ledger for the Monday delivery-tier report. One row per week keyed
 * by the Monday date (`YYYY-MM-DD`, America/New_York). The poller only sends when
 * `get(weekStart)` is null. See `migrations/0036_tier_classifications.sql`.
 */
export interface TierWeeklyReportRow {
  weekStart: string;
  sentAt: string | null;
  payload: unknown;
}

export class TierWeeklyReportsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async get(weekStart: string): Promise<TierWeeklyReportRow | null> {
    const { data, error } = await this.client
      .from('tier_weekly_reports')
      .select('*')
      .eq('week_start', weekStart)
      .maybeSingle();
    if (error) throw new Error(`tier_weekly_reports get failed: ${error.message}`);
    if (!data) return null;
    return { weekStart: data.week_start, sentAt: data.sent_at ?? null, payload: data.payload };
  }

  /** Insert the week's row. Uses upsert so a racing double-send is a no-op rather
   *  than a duplicate-key error. */
  async insert(weekStart: string, payload: unknown): Promise<void> {
    const { error } = await this.client
      .from('tier_weekly_reports')
      .upsert({ week_start: weekStart, payload }, { onConflict: 'week_start' });
    if (error) throw new Error(`tier_weekly_reports insert failed: ${error.message}`);
  }
}
