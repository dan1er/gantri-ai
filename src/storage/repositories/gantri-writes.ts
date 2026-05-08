import type { SupabaseClient } from '@supabase/supabase-js';

export interface GantriWriteRow {
  id: string;
  callerSlackId: string;
  action: 'update_customer_email';
  porterUserId: number | null;
  porterOrderId: number | null;
  klaviyoProfileId: string | null;
  requestPayload: unknown;
  responsePayload: unknown;
  status: 'success' | 'partial' | 'failure';
  writeTarget: 'staging' | 'prod';
  createdAt: string;
}

export interface GantriWriteInsert {
  callerSlackId: string;
  action: GantriWriteRow['action'];
  porterUserId: number | null;
  porterOrderId: number | null;
  klaviyoProfileId: string | null;
  requestPayload: unknown;
  responsePayload: unknown;
  status: GantriWriteRow['status'];
  writeTarget: GantriWriteRow['writeTarget'];
}

export class GantriWritesRepo {
  constructor(private readonly client: SupabaseClient) {}

  async insert(input: GantriWriteInsert): Promise<GantriWriteRow> {
    const { data, error } = await this.client
      .from('gantri_writes')
      .insert({
        caller_slack_id: input.callerSlackId,
        action: input.action,
        porter_user_id: input.porterUserId,
        porter_order_id: input.porterOrderId,
        klaviyo_profile_id: input.klaviyoProfileId,
        request_payload: input.requestPayload,
        response_payload: input.responsePayload,
        status: input.status,
        write_target: input.writeTarget,
      })
      .select('id, caller_slack_id, action, porter_user_id, porter_order_id, klaviyo_profile_id, request_payload, response_payload, status, write_target, created_at')
      .single();
    if (error) throw new Error(`gantri_writes insert failed: ${error.message}`);
    return mapRow(data);
  }

  async listForCaller(slackUserId: string, limit = 50): Promise<GantriWriteRow[]> {
    const { data, error } = await this.client
      .from('gantri_writes')
      .select('id, caller_slack_id, action, porter_user_id, porter_order_id, klaviyo_profile_id, request_payload, response_payload, status, write_target, created_at')
      .eq('caller_slack_id', slackUserId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`gantri_writes list failed: ${error.message}`);
    return (data ?? []).map(mapRow);
  }
}

function mapRow(r: any): GantriWriteRow {
  return {
    id: r.id,
    callerSlackId: r.caller_slack_id,
    action: r.action,
    porterUserId: r.porter_user_id ?? null,
    porterOrderId: r.porter_order_id ?? null,
    klaviyoProfileId: r.klaviyo_profile_id ?? null,
    requestPayload: r.request_payload,
    responsePayload: r.response_payload ?? null,
    status: r.status,
    writeTarget: r.write_target,
    createdAt: r.created_at,
  };
}
