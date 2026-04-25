import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReportPlan } from './plan-types.js';

export interface ReportSubscriptionRow {
  id: string;
  slack_user_id: string;
  display_name: string;
  original_intent: string;
  plan: ReportPlan;
  plan_compiled_at: string;
  plan_validation_status: 'ok' | 'stale' | 'broken';
  cron: string;
  timezone: string;
  delivery_channel: string;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_run_status: 'ok' | 'partial' | 'error' | null;
  last_run_error: string | null;
  fail_count: number;
  created_at: string;
  updated_at: string;
}

export interface InsertSubscriptionInput {
  slack_user_id: string;
  display_name: string;
  original_intent: string;
  plan: ReportPlan;
  cron: string;
  timezone: string;
  delivery_channel: string;
  next_run_at: string;
}

export interface UpdateSubscriptionFields {
  display_name?: string;
  original_intent?: string;
  plan?: ReportPlan;
  plan_compiled_at?: string;
  plan_validation_status?: 'ok' | 'stale' | 'broken';
  cron?: string;
  timezone?: string;
  delivery_channel?: string;
  enabled?: boolean;
  next_run_at?: string;
  last_run_at?: string;
  last_run_status?: 'ok' | 'partial' | 'error' | null;
  last_run_error?: string | null;
  fail_count?: number;
  updated_at?: string;
}

export class ReportSubscriptionsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async insert(row: InsertSubscriptionInput): Promise<ReportSubscriptionRow> {
    const { data, error } = await this.client
      .from('report_subscriptions')
      .insert(row)
      .select('*')
      .single();
    if (error) throw new Error(`report subscription insert failed: ${error.message}`);
    return data as ReportSubscriptionRow;
  }

  async getById(id: string): Promise<ReportSubscriptionRow | null> {
    const { data, error } = await this.client
      .from('report_subscriptions')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`report subscription read failed: ${error.message}`);
    return (data as ReportSubscriptionRow | null) ?? null;
  }

  async listByUser(slackUserId: string): Promise<ReportSubscriptionRow[]> {
    const { data, error } = await this.client
      .from('report_subscriptions')
      .select('*')
      .eq('slack_user_id', slackUserId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(`report subscription list failed: ${error.message}`);
    return (data ?? []) as ReportSubscriptionRow[];
  }

  async update(id: string, fields: UpdateSubscriptionFields): Promise<ReportSubscriptionRow> {
    const { data, error } = await this.client
      .from('report_subscriptions')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new Error(`report subscription update failed: ${error.message}`);
    return data as ReportSubscriptionRow;
  }

  /**
   * Atomically pick up to `limit` due-and-enabled subscriptions and return them.
   * Backed by the `claim_due_report_subscriptions` Postgres function which uses
   * FOR UPDATE SKIP LOCKED so multiple workers can race safely. The function
   * also bumps next_run_at by one minute as a sentinel; the runner will
   * overwrite it with the cron-computed next fire after a successful or
   * failed run.
   */
  async claimDueBatch(now: Date, limit: number): Promise<ReportSubscriptionRow[]> {
    const { data, error } = await this.client.rpc('claim_due_report_subscriptions', {
      p_now: now.toISOString(),
      p_limit: limit,
    });
    if (error) throw new Error(`claim_due_report_subscriptions failed: ${error.message}`);
    return (data ?? []) as ReportSubscriptionRow[];
  }
}
