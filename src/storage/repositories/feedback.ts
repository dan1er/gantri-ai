import type { SupabaseClient } from '@supabase/supabase-js';

export type FeedbackStatus = 'open' | 'investigating' | 'resolved' | 'wontfix';

export interface FeedbackRow {
  id: string;
  reporter_slack_user_id: string;
  reason: string | null;
  channel_id: string;
  thread_ts: string;
  thread_permalink: string | null;
  captured_question: string | null;
  captured_response: string | null;
  captured_tool_calls: unknown;
  captured_model: string | null;
  captured_iterations: number | null;
  status: FeedbackStatus;
  resolution: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertFeedbackInput {
  reporter_slack_user_id: string;
  reason: string | null;
  channel_id: string;
  thread_ts: string;
  thread_permalink: string | null;
  captured_question: string | null;
  captured_response: string | null;
  captured_tool_calls: unknown;
  captured_model: string | null;
  captured_iterations: number | null;
}

export interface UpdateFeedbackFields {
  status?: FeedbackStatus;
  resolution?: string | null;
  resolved_at?: string | null;
}

export class FeedbackRepo {
  constructor(private readonly client: SupabaseClient) {}

  async insert(row: InsertFeedbackInput): Promise<FeedbackRow> {
    const { data, error } = await this.client.from('feedback_reports').insert(row).select('*').single();
    if (error) throw new Error(`feedback insert failed: ${error.message}`);
    return data as FeedbackRow;
  }

  async getById(id: string): Promise<FeedbackRow | null> {
    const { data, error } = await this.client.from('feedback_reports').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`feedback read failed: ${error.message}`);
    return (data as FeedbackRow | null) ?? null;
  }

  async update(id: string, fields: UpdateFeedbackFields): Promise<FeedbackRow> {
    const { data, error } = await this.client
      .from('feedback_reports')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new Error(`feedback update failed: ${error.message}`);
    return data as FeedbackRow;
  }

  async listOpen(limit = 50): Promise<FeedbackRow[]> {
    const { data, error } = await this.client
      .from('feedback_reports')
      .select('*')
      .in('status', ['open', 'investigating'])
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`feedback list failed: ${error.message}`);
    return (data ?? []) as FeedbackRow[];
  }
}
