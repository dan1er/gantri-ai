import type { SupabaseClient } from '@supabase/supabase-js';

export interface ConversationInsert {
  slack_thread_ts: string;
  slack_channel_id: string;
  slack_user_id: string;
  question: string;
  tool_calls?: unknown;
  response?: string;
  model?: string;
  tokens_input?: number;
  tokens_output?: number;
  duration_ms?: number;
  error?: string;
}

export class ConversationsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async insert(row: ConversationInsert): Promise<string> {
    const { data, error } = await this.client
      .from('conversations')
      .insert(row)
      .select('id')
      .single();
    if (error) throw new Error(`conversations insert failed: ${error.message}`);
    return data.id as string;
  }

  async loadRecentByThread(threadTs: string, limit = 10): Promise<Array<{ question: string; response: string | null }>> {
    const { data, error } = await this.client
      .from('conversations')
      .select('question,response')
      .eq('slack_thread_ts', threadTs)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw new Error(`conversations read failed: ${error.message}`);
    return (data ?? []) as Array<{ question: string; response: string | null }>;
  }
}
