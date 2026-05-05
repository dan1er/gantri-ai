import type { SupabaseClient } from '@supabase/supabase-js';

export interface KlaviyoDeletionRow {
  id: string;
  callerSlackId: string;
  callerEmail: string | null;
  requestedEmails: string[];
  foundCount: number;
  deletedCount: number;
  failedCount: number;
  failedDetails: Array<{ email: string; profile_id?: string; status?: number; error?: string }>;
  status: 'submitted';
  startedAt: string;
  completedAt: string;
}

export interface InsertDeletionInput {
  callerSlackId: string;
  callerEmail: string | null;
  requestedEmails: string[];
  foundCount: number;
  deletedCount: number;
  failedCount: number;
  failedDetails: KlaviyoDeletionRow['failedDetails'];
}

function rowFromDb(r: Record<string, any>): KlaviyoDeletionRow {
  return {
    id: r.id,
    callerSlackId: r.caller_slack_id,
    callerEmail: r.caller_email,
    requestedEmails: r.requested_emails,
    foundCount: r.found_count,
    deletedCount: r.deleted_count,
    failedCount: r.failed_count,
    failedDetails: r.failed_details,
    status: r.status,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

export class KlaviyoDeletionsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async insert(input: InsertDeletionInput): Promise<KlaviyoDeletionRow> {
    const { data, error } = await this.client
      .from('klaviyo_deletions')
      .insert({
        caller_slack_id: input.callerSlackId,
        caller_email: input.callerEmail,
        requested_emails: input.requestedEmails,
        found_count: input.foundCount,
        deleted_count: input.deletedCount,
        failed_count: input.failedCount,
        failed_details: input.failedDetails,
        status: 'submitted',
      })
      .select('*')
      .single();
    if (error) throw new Error(`klaviyo_deletions insert failed: ${error.message}`);
    if (!data) throw new Error('klaviyo_deletions insert returned no row (check RLS/select policy)');
    return rowFromDb(data);
  }

  async countInLastHour(callerSlackId: string): Promise<number> {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error } = await this.client
      .from('klaviyo_deletions')
      .select('id', { count: 'exact', head: true })
      .gte('started_at', since)
      .eq('caller_slack_id', callerSlackId);
    if (error) throw new Error(`klaviyo_deletions count failed: ${error.message}`);
    return count ?? 0;
  }
}
