import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export type PendingKind = 'klaviyo_import' | 'klaviyo_delete' | 'klaviyo_csv_pending';

export interface PendingConfirmationRow {
  id: string;
  confirmationToken: string;
  callerSlackId: string;
  channelId: string;
  threadTs: string;
  kind: PendingKind;
  payload: unknown;
  createdAt: string;
  expiresAt: string;
}

export interface InsertPendingInput {
  callerSlackId: string;
  channelId: string;
  threadTs: string;
  kind: PendingKind;
  payload: unknown;
  ttlMinutes?: number;
}

function rowFromDb(r: Record<string, any>): PendingConfirmationRow {
  return {
    id: r.id,
    confirmationToken: r.confirmation_token,
    callerSlackId: r.caller_slack_id,
    channelId: r.channel_id,
    threadTs: r.thread_ts,
    kind: r.kind,
    payload: r.payload,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

export class PendingConfirmationsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async insert(input: InsertPendingInput): Promise<PendingConfirmationRow> {
    const ttl = input.ttlMinutes ?? 30;
    const expiresAt = new Date(Date.now() + ttl * 60 * 1000).toISOString();
    const { data, error } = await this.client
      .from('pending_confirmations')
      .insert({
        confirmation_token: randomUUID(),
        caller_slack_id: input.callerSlackId,
        channel_id: input.channelId,
        thread_ts: input.threadTs,
        kind: input.kind,
        payload: input.payload,
        expires_at: expiresAt,
      })
      .select('*')
      .single();
    if (error) throw new Error(`pending_confirmations insert failed: ${error.message}`);
    if (!data) throw new Error('pending_confirmations insert returned no row (check RLS/select policy)');
    return rowFromDb(data);
  }

  async lookupByThread(callerSlackId: string, channelId: string, threadTs: string): Promise<PendingConfirmationRow | null> {
    const now = new Date().toISOString();
    const { data, error } = await this.client
      .from('pending_confirmations')
      .select('*')
      .eq('caller_slack_id', callerSlackId)
      .eq('channel_id', channelId)
      .eq('thread_ts', threadTs)
      .gt('expires_at', now)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`pending_confirmations lookup failed: ${error.message}`);
    return data ? rowFromDb(data) : null;
  }

  async deleteById(id: string): Promise<void> {
    const { error } = await this.client.from('pending_confirmations').delete().eq('id', id);
    if (error) throw new Error(`pending_confirmations delete failed: ${error.message}`);
  }

  async sweepExpired(): Promise<number> {
    const now = new Date().toISOString();
    const { data, error } = await this.client.from('pending_confirmations').delete().select('id').lt('expires_at', now);
    if (error) throw new Error(`pending_confirmations sweep failed: ${error.message}`);
    return (data ?? []).length;
  }

  async countOutstanding(callerSlackId: string): Promise<number> {
    const now = new Date().toISOString();
    const { count, error } = await this.client
      .from('pending_confirmations')
      .select('id', { count: 'exact', head: true })
      .gt('expires_at', now)
      .eq('caller_slack_id', callerSlackId);
    if (error) throw new Error(`pending_confirmations count failed: ${error.message}`);
    return count ?? 0;
  }
}
