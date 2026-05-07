import { describe, it, expect, vi } from 'vitest';
import { PipedriveWritesRepo } from '../../../src/storage/repositories/pipedrive-writes.js';

function makeMockSupabase(rows: any[] = []) {
  const insertedRows: any[] = [];
  const supabase = {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn(function (this: any, row: any) {
      const inserted = { ...row, id: 'row-uuid', created_at: '2026-05-07T12:00:00Z' };
      insertedRows.push(inserted);
      return {
        select: () => ({
          single: vi.fn().mockResolvedValue({ data: inserted, error: null }),
        }),
      };
    }),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
  };
  return { supabase: supabase as any, insertedRows };
}

describe('PipedriveWritesRepo', () => {
  it('insert round-trips the row with status, payload, and resource ids', async () => {
    const { supabase, insertedRows } = makeMockSupabase();
    const repo = new PipedriveWritesRepo(supabase);
    const row = await repo.insert({
      callerSlackId: 'U1',
      action: 'create_lead',
      pipedriveResourceType: 'lead',
      pipedriveResourceId: 'lead-uuid-1',
      requestPayload: { title: 'Foo Studio' },
      responsePayload: { id: 'lead-uuid-1' },
      status: 'success',
    });
    expect(row.id).toBe('row-uuid');
    expect(insertedRows[0].caller_slack_id).toBe('U1');
    expect(insertedRows[0].action).toBe('create_lead');
    expect(insertedRows[0].pipedrive_resource_type).toBe('lead');
    expect(insertedRows[0].pipedrive_resource_id).toBe('lead-uuid-1');
    expect(insertedRows[0].status).toBe('success');
  });

  it('insert with status=failure also records', async () => {
    const { supabase, insertedRows } = makeMockSupabase();
    const repo = new PipedriveWritesRepo(supabase);
    await repo.insert({
      callerSlackId: 'U1',
      action: 'add_note',
      pipedriveResourceType: null,
      pipedriveResourceId: null,
      requestPayload: { targetType: 'lead', targetId: 'x', content: 'y' },
      responsePayload: { error: { code: 'PIPEDRIVE_ERROR', status: 400 } },
      status: 'failure',
    });
    expect(insertedRows[0].status).toBe('failure');
    expect(insertedRows[0].pipedrive_resource_id).toBeNull();
  });

  it('listForCaller queries by caller_slack_id desc by created_at with limit', async () => {
    const { supabase } = makeMockSupabase([
      { id: 'r1', caller_slack_id: 'U1', action: 'create_lead', pipedrive_resource_type: 'lead', pipedrive_resource_id: 'l1', request_payload: {}, response_payload: {}, status: 'success', created_at: '2026-05-07T12:00:00Z' },
    ]);
    const repo = new PipedriveWritesRepo(supabase);
    const rows = await repo.listForCaller('U1', 5);
    expect(supabase.from).toHaveBeenCalledWith('pipedrive_writes');
    expect(supabase.eq).toHaveBeenCalledWith('caller_slack_id', 'U1');
    expect(supabase.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(supabase.limit).toHaveBeenCalledWith(5);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('create_lead');
  });
});
