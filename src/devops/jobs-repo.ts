import type { SupabaseClient } from '@supabase/supabase-js';
import type { Job, JobKind, JobTarget, JobStatus, JobSpec } from './types.js';
import { TERMINAL_STATUSES } from './types.js';

interface Row {
  id: string; kind: JobKind; target: JobTarget; status: JobStatus;
  spec: JobSpec; requested_by: string; channel_id: string;
  message_ts: string | null; run_id: number | null; error: string | null;
  created_at: string; updated_at: string;
}

function toJob(r: Row): Job {
  return {
    id: r.id, kind: r.kind, target: r.target, status: r.status,
    spec: r.spec ?? {}, requestedBy: r.requested_by, channelId: r.channel_id,
    messageTs: r.message_ts, runId: r.run_id, error: r.error,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export interface CreateJobInput {
  kind: JobKind;
  target: JobTarget;
  spec: JobSpec;
  requestedBy: string;
  channelId: string;
}

export interface UpdateJobInput {
  status?: JobStatus;
  spec?: JobSpec;
  messageTs?: string | null;
  runId?: number | null;
  error?: string | null;
}

export class DevopsJobsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: CreateJobInput): Promise<Job> {
    const { data, error } = await this.client
      .from('devops_jobs')
      .insert({
        kind: input.kind, target: input.target, status: 'pending',
        spec: input.spec, requested_by: input.requestedBy, channel_id: input.channelId,
      })
      .select('*')
      .single();
    if (error) throw new Error(`devops_jobs insert failed: ${error.message}`);
    return toJob(data as Row);
  }

  async listActive(limit = 25): Promise<Job[]> {
    const terminal = `(${TERMINAL_STATUSES.join(',')})`;
    const { data, error } = await this.client
      .from('devops_jobs')
      .select('*')
      .not('status', 'in', terminal)
      .order('updated_at', { ascending: true })
      .limit(limit);
    if (error) throw new Error(`devops_jobs list failed: ${error.message}`);
    return (data as Row[]).map(toJob);
  }

  async update(id: string, patch: UpdateJobInput): Promise<void> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.spec !== undefined) row.spec = patch.spec;
    if (patch.messageTs !== undefined) row.message_ts = patch.messageTs;
    if (patch.runId !== undefined) row.run_id = patch.runId;
    if (patch.error !== undefined) row.error = patch.error;
    const { error } = await this.client.from('devops_jobs').update(row).eq('id', id);
    if (error) throw new Error(`devops_jobs update failed: ${error.message}`);
  }
}
