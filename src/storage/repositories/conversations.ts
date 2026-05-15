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

/** Minimal projection used by usage aggregation. */
export interface ConversationUsageRow {
  slackUserId: string;
  question: string;
  toolCalls: Array<{ name?: string; ok?: boolean }> | null;
  model: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  durationMs: number | null;
  hadError: boolean;
  createdAt: string;
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

  /**
   * Load raw conversation rows inside a date range, for usage aggregation.
   * `from` and `to` are inclusive ISO timestamps. Hard cap at 5000 rows so the
   * caller can't accidentally pull the whole table; in practice we have ~5
   * users and an in-house bot, so a week is well under 1000 rows.
   */
  async loadInRange(opts: { from: string; to: string; maxRows?: number }): Promise<ConversationUsageRow[]> {
    const max = opts.maxRows ?? 5000;
    const { data, error } = await this.client
      .from('conversations')
      .select('slack_user_id, question, tool_calls, model, tokens_input, tokens_output, duration_ms, error, created_at')
      .gte('created_at', opts.from)
      .lte('created_at', opts.to)
      .order('created_at', { ascending: false })
      .limit(max);
    if (error) throw new Error(`conversations range read failed: ${error.message}`);
    return (data ?? []).map((r) => ({
      slackUserId: r.slack_user_id as string,
      question: (r.question as string) ?? '',
      toolCalls: Array.isArray(r.tool_calls)
        ? (r.tool_calls as Array<{ name?: string; ok?: boolean }>)
        : null,
      model: (r.model as string | null) ?? null,
      tokensInput: (r.tokens_input as number | null) ?? null,
      tokensOutput: (r.tokens_output as number | null) ?? null,
      durationMs: (r.duration_ms as number | null) ?? null,
      hadError: typeof r.error === 'string' && r.error.length > 0,
      createdAt: r.created_at as string,
    }));
  }
}
