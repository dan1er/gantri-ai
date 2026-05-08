import { describe, it, expect, vi } from 'vitest';
import { GantriWritesRepo } from '../../../src/storage/repositories/gantri-writes.js';

function makeMockSupabase(rows: any[] = []) {
  const insertedRows: any[] = [];
  const supabase = {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn(function (this: any, row: any) {
      const inserted = { ...row, id: 'row-uuid', created_at: '2026-05-08T12:00:00Z' };
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

describe('GantriWritesRepo', () => {
  it('insert success row round-trips', async () => {
    const { supabase, insertedRows } = makeMockSupabase();
    const repo = new GantriWritesRepo(supabase);
    const row = await repo.insert({
      callerSlackId: 'U_ZUZ',
      action: 'update_customer_email',
      porterUserId: 59516,
      porterOrderId: 43785,
      klaviyoProfileId: '01JHPN57KPZFTJVN8D4D2WVK2H',
      requestPayload: { fromEmail: 'x@a.com', toEmail: 'x@b.com' },
      responsePayload: { porterOk: true, klaviyoOk: true },
      status: 'success',
      writeTarget: 'staging',
    });
    expect(row.id).toBe('row-uuid');
    expect(insertedRows[0].caller_slack_id).toBe('U_ZUZ');
    expect(insertedRows[0].porter_user_id).toBe(59516);
    expect(insertedRows[0].write_target).toBe('staging');
    expect(insertedRows[0].status).toBe('success');
  });

  it('insert partial row (porter ok, klaviyo failed)', async () => {
    const { supabase, insertedRows } = makeMockSupabase();
    const repo = new GantriWritesRepo(supabase);
    await repo.insert({
      callerSlackId: 'U_ZUZ',
      action: 'update_customer_email',
      porterUserId: 59516,
      porterOrderId: 43785,
      klaviyoProfileId: 'kid_x',
      requestPayload: {},
      responsePayload: { porterOk: true, klaviyoOk: false, klaviyoError: 'timeout' },
      status: 'partial',
      writeTarget: 'prod',
    });
    expect(insertedRows[0].status).toBe('partial');
    expect(insertedRows[0].write_target).toBe('prod');
  });

  it('insert failure row leaves resource ids null', async () => {
    const { supabase, insertedRows } = makeMockSupabase();
    const repo = new GantriWritesRepo(supabase);
    await repo.insert({
      callerSlackId: 'U_ZUZ',
      action: 'update_customer_email',
      porterUserId: null,
      porterOrderId: 43785,
      klaviyoProfileId: null,
      requestPayload: { newEmail: 'x@x.com' },
      responsePayload: { error: { code: 'PORTER_ERROR', status: 422 } },
      status: 'failure',
      writeTarget: 'staging',
    });
    expect(insertedRows[0].status).toBe('failure');
    expect(insertedRows[0].porter_user_id).toBeNull();
    expect(insertedRows[0].klaviyo_profile_id).toBeNull();
  });

  it('listForCaller queries by caller_slack_id desc with limit', async () => {
    const { supabase } = makeMockSupabase([
      { id: 'r1', caller_slack_id: 'U_ZUZ', action: 'update_customer_email', porter_user_id: 59516, porter_order_id: 43785, klaviyo_profile_id: null, request_payload: {}, response_payload: {}, status: 'success', write_target: 'staging', created_at: '2026-05-08T12:00:00Z' },
    ]);
    const repo = new GantriWritesRepo(supabase);
    const rows = await repo.listForCaller('U_ZUZ', 5);
    expect(supabase.from).toHaveBeenCalledWith('gantri_writes');
    expect(supabase.eq).toHaveBeenCalledWith('caller_slack_id', 'U_ZUZ');
    expect(supabase.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(supabase.limit).toHaveBeenCalledWith(5);
    expect(rows).toHaveLength(1);
    expect(rows[0].porterUserId).toBe(59516);
    expect(rows[0].writeTarget).toBe('staging');
  });
});
