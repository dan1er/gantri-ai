import type { SupabaseClient } from '@supabase/supabase-js';

export interface KlaviyoImportRow {
  id: string;
  callerSlackId: string;
  callerEmail: string | null;
  source: 'inline' | 'csv';
  filename: string | null;
  storagePath: string | null;
  listId: string | null;
  listName: string | null;
  channels: string[];
  totalSubmitted: number;
  totalImported: number;
  totalInvalidRejected: number;
  klaviyoJobId: string;
  status: 'queued' | 'processing' | 'complete' | 'failed';
  startedAt: string;
  completedAt: string | null;
  succeededCount: number | null;
  alreadySubscribedCount: number | null;
  failedCount: number | null;
  errorSummary: string | null;
}

export interface InsertImportInput {
  callerSlackId: string;
  callerEmail: string | null;
  source: 'inline' | 'csv';
  filename?: string | null;
  storagePath?: string | null;
  listId: string | null;
  listName: string | null;
  channels: string[];
  totalSubmitted: number;
  totalImported: number;
  totalInvalidRejected: number;
  klaviyoJobId: string;
  status: 'queued' | 'processing' | 'complete' | 'failed';
}

export interface UpdateStatusInput {
  status: 'queued' | 'processing' | 'complete' | 'failed';
  succeededCount?: number;
  alreadySubscribedCount?: number;
  failedCount?: number;
  errorSummary?: string;
}

const TERMINAL: ReadonlyArray<UpdateStatusInput['status']> = ['complete', 'failed'];

function rowFromDb(r: Record<string, any>): KlaviyoImportRow {
  return {
    id: r.id,
    callerSlackId: r.caller_slack_id,
    callerEmail: r.caller_email,
    source: r.source,
    filename: r.filename,
    storagePath: r.storage_path,
    listId: r.list_id,
    listName: r.list_name,
    channels: r.channels,
    totalSubmitted: r.total_submitted,
    totalImported: r.total_imported,
    totalInvalidRejected: r.total_invalid_rejected,
    klaviyoJobId: r.klaviyo_job_id,
    status: r.status,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    succeededCount: r.succeeded_count,
    alreadySubscribedCount: r.already_subscribed_count,
    failedCount: r.failed_count,
    errorSummary: r.error_summary,
  };
}

export class KlaviyoImportsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async insert(input: InsertImportInput): Promise<KlaviyoImportRow> {
    const { data, error } = await this.client
      .from('klaviyo_imports')
      .insert({
        caller_slack_id: input.callerSlackId,
        caller_email: input.callerEmail,
        source: input.source,
        filename: input.filename ?? null,
        storage_path: input.storagePath ?? null,
        list_id: input.listId,
        list_name: input.listName,
        channels: input.channels,
        total_submitted: input.totalSubmitted,
        total_imported: input.totalImported,
        total_invalid_rejected: input.totalInvalidRejected,
        klaviyo_job_id: input.klaviyoJobId,
        status: input.status,
      })
      .select('*')
      .single();
    if (error) throw new Error(`klaviyo_imports insert failed: ${error.message}`);
    if (!data) throw new Error('klaviyo_imports insert returned no row (check RLS/select policy)');
    return rowFromDb(data);
  }

  async updateStatus(id: string, patch: UpdateStatusInput): Promise<void> {
    const update: Record<string, unknown> = { status: patch.status };
    if (patch.succeededCount != null) update.succeeded_count = patch.succeededCount;
    if (patch.alreadySubscribedCount != null) update.already_subscribed_count = patch.alreadySubscribedCount;
    if (patch.failedCount != null) update.failed_count = patch.failedCount;
    if (patch.errorSummary != null) update.error_summary = patch.errorSummary;
    if (TERMINAL.includes(patch.status)) update.completed_at = new Date().toISOString();
    const { error } = await this.client.from('klaviyo_imports').update(update).eq('id', id);
    if (error) throw new Error(`klaviyo_imports update failed: ${error.message}`);
  }

  async countInFlight(callerSlackId: string): Promise<number> {
    const { count, error } = await this.client
      .from('klaviyo_imports')
      .select('id', { count: 'exact', head: true })
      .in('status', ['queued', 'processing'])
      .eq('caller_slack_id', callerSlackId);
    if (error) throw new Error(`klaviyo_imports count failed: ${error.message}`);
    return count ?? 0;
  }

  async countInLastHour(callerSlackId: string): Promise<number> {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error } = await this.client
      .from('klaviyo_imports')
      .select('id', { count: 'exact', head: true })
      .gte('started_at', since)
      .eq('caller_slack_id', callerSlackId);
    if (error) throw new Error(`klaviyo_imports count failed: ${error.message}`);
    return count ?? 0;
  }

  async listInFlight(limit: number = 50): Promise<KlaviyoImportRow[]> {
    const { data, error } = await this.client
      .from('klaviyo_imports')
      .select('*')
      .in('status', ['queued', 'processing'])
      .order('started_at', { ascending: true })
      .limit(limit);
    if (error) throw new Error(`klaviyo_imports list failed: ${error.message}`);
    return (data ?? []).map(rowFromDb);
  }

  async getById(id: string): Promise<KlaviyoImportRow | null> {
    const { data, error } = await this.client.from('klaviyo_imports').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`klaviyo_imports get failed: ${error.message}`);
    return data ? rowFromDb(data) : null;
  }

  async getByJobId(klaviyoJobId: string): Promise<KlaviyoImportRow | null> {
    const { data, error } = await this.client.from('klaviyo_imports').select('*').eq('klaviyo_job_id', klaviyoJobId).maybeSingle();
    if (error) throw new Error(`klaviyo_imports get failed: ${error.message}`);
    return data ? rowFromDb(data) : null;
  }
}
