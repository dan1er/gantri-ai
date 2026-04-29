import type { SupabaseClient } from '@supabase/supabase-js';

export interface KlaviyoSignupRollupRow {
  day: string; // YYYY-MM-DD
  signupsTotal: number;
  signupsConsentedEmail: number;
  computedAt: string; // ISO 8601
}

export interface KlaviyoSignupRollupUpsert {
  day: string;
  signupsTotal: number;
  signupsConsentedEmail: number;
}

export class KlaviyoSignupRollupRepo {
  constructor(private readonly db: SupabaseClient) {}

  async upsertManyDays(rows: KlaviyoSignupRollupUpsert[]): Promise<void> {
    if (rows.length === 0) return;
    const payload = rows.map((r) => ({
      day: r.day,
      signups_total: r.signupsTotal,
      signups_consented_email: r.signupsConsentedEmail,
      computed_at: new Date().toISOString(),
    }));
    const { error } = await this.db.from('klaviyo_signups_daily').upsert(payload);
    if (error) throw new Error(`klaviyo_signups_daily upsert failed: ${error.message}`);
  }

  async getRange(startDate: string, endDate: string): Promise<KlaviyoSignupRollupRow[]> {
    const { data, error } = await this.db
      .from('klaviyo_signups_daily')
      .select('day,signups_total,signups_consented_email,computed_at')
      .gte('day', startDate)
      .lte('day', endDate)
      .order('day', { ascending: true });
    if (error) throw new Error(`klaviyo_signups_daily getRange failed: ${error.message}`);
    return ((data as Array<{ day: string; signups_total: number; signups_consented_email: number; computed_at: string }>) ?? []).map((r) => ({
      day: r.day,
      signupsTotal: r.signups_total,
      signupsConsentedEmail: r.signups_consented_email,
      computedAt: r.computed_at,
    }));
  }

  async latestDay(): Promise<string | null> {
    const { data, error } = await this.db
      .from('klaviyo_signups_daily')
      .select('day')
      .order('day', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`klaviyo_signups_daily latestDay failed: ${error.message}`);
    return (data as { day: string } | null)?.day ?? null;
  }

  async count(): Promise<number> {
    const { count, error } = await this.db
      .from('klaviyo_signups_daily')
      .select('count', { count: 'exact', head: true });
    if (error) throw new Error(`klaviyo_signups_daily count failed: ${error.message}`);
    return count ?? 0;
  }
}
