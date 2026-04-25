import type { SupabaseClient } from '@supabase/supabase-js';

export interface RollupRow {
  date: string;                      // YYYY-MM-DD PT
  total_orders: number;
  total_revenue_cents: number;
  by_type: Record<string, { orders: number; revenueCents: number }>;
  by_status: Record<string, { orders: number; revenueCents: number }>;
  by_organization: Record<string, { orders: number; revenueCents: number }>;
  refreshed_at: string;
}

export interface UpsertRollupInput {
  date: string;
  total_orders: number;
  total_revenue_cents: number;
  by_type: Record<string, { orders: number; revenueCents: number }>;
  by_status: Record<string, { orders: number; revenueCents: number }>;
  by_organization: Record<string, { orders: number; revenueCents: number }>;
}

export class RollupRepo {
  constructor(private readonly client: SupabaseClient) {}

  async upsertMany(rows: UpsertRollupInput[]): Promise<void> {
    if (rows.length === 0) return;
    const payload = rows.map((r) => ({
      ...r,
      refreshed_at: new Date().toISOString(),
    }));
    const { error } = await this.client.from('sales_daily_rollup').upsert(payload);
    if (error) throw new Error(`rollup upsert failed: ${error.message}`);
  }

  async getRange(startDate: string, endDate: string): Promise<RollupRow[]> {
    const { data, error } = await this.client
      .from('sales_daily_rollup')
      .select('*')
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: true });
    if (error) throw new Error(`rollup read failed: ${error.message}`);
    return (data ?? []) as RollupRow[];
  }

  async maxRefreshedDate(): Promise<string | null> {
    const { data, error } = await this.client
      .from('sales_daily_rollup')
      .select('date')
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`rollup max read failed: ${error.message}`);
    return (data?.date as string | undefined) ?? null;
  }
}
