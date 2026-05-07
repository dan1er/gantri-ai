import type { SupabaseClient } from '@supabase/supabase-js';

export interface PipedriveWriteRow {
  id: string;
  callerSlackId: string;
  action:
    | 'create_lead'
    | 'add_note'
    | 'create_activity'
    | 'delete_lead'
    | 'delete_note'
    | 'delete_activity'
    | 'delete_organization'
    | 'delete_person';
  pipedriveResourceType: 'lead' | 'note' | 'activity' | 'person' | 'organization' | null;
  pipedriveResourceId: string | null;
  requestPayload: unknown;
  responsePayload: unknown;
  status: 'success' | 'failure';
  createdAt: string;
}

export interface PipedriveWriteInsert {
  callerSlackId: string;
  action: PipedriveWriteRow['action'];
  pipedriveResourceType: PipedriveWriteRow['pipedriveResourceType'];
  pipedriveResourceId: PipedriveWriteRow['pipedriveResourceId'];
  requestPayload: unknown;
  responsePayload: unknown;
  status: PipedriveWriteRow['status'];
}

export class PipedriveWritesRepo {
  constructor(private readonly client: SupabaseClient) {}

  async insert(input: PipedriveWriteInsert): Promise<PipedriveWriteRow> {
    const { data, error } = await this.client
      .from('pipedrive_writes')
      .insert({
        caller_slack_id: input.callerSlackId,
        action: input.action,
        pipedrive_resource_type: input.pipedriveResourceType,
        pipedrive_resource_id: input.pipedriveResourceId,
        request_payload: input.requestPayload,
        response_payload: input.responsePayload,
        status: input.status,
      })
      .select('id, caller_slack_id, action, pipedrive_resource_type, pipedrive_resource_id, request_payload, response_payload, status, created_at')
      .single();
    if (error) throw new Error(`pipedrive_writes insert failed: ${error.message}`);
    return mapRow(data);
  }

  async listForCaller(slackUserId: string, limit = 50): Promise<PipedriveWriteRow[]> {
    const { data, error } = await this.client
      .from('pipedrive_writes')
      .select('id, caller_slack_id, action, pipedrive_resource_type, pipedrive_resource_id, request_payload, response_payload, status, created_at')
      .eq('caller_slack_id', slackUserId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`pipedrive_writes list failed: ${error.message}`);
    return (data ?? []).map(mapRow);
  }
}

function mapRow(r: any): PipedriveWriteRow {
  return {
    id: r.id,
    callerSlackId: r.caller_slack_id,
    action: r.action,
    pipedriveResourceType: r.pipedrive_resource_type ?? null,
    pipedriveResourceId: r.pipedrive_resource_id ?? null,
    requestPayload: r.request_payload,
    responsePayload: r.response_payload ?? null,
    status: r.status,
    createdAt: r.created_at,
  };
}
