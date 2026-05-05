import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PendingConfirmationsRepo } from '../../../src/storage/repositories/pending-confirmations.js';

describe('PendingConfirmationsRepo', () => {
  let chain: any;
  let client: any;
  let repo: PendingConfirmationsRepo;

  beforeEach(() => {
    chain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn(),
      maybeSingle: vi.fn(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      lt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    client = { from: vi.fn(() => chain) } as any;
    repo = new PendingConfirmationsRepo(client);
  });

  it('insert returns mapped row with token + expiry', async () => {
    chain.single.mockResolvedValue({
      data: {
        id: 'p1', confirmation_token: 't1',
        caller_slack_id: 'U1', channel_id: 'D1', thread_ts: 't0',
        kind: 'klaviyo_import', payload: { foo: 1 },
        created_at: '2026-05-05T00:00:00Z', expires_at: '2026-05-05T00:30:00Z',
      },
      error: null,
    });
    const row = await repo.insert({
      callerSlackId: 'U1', channelId: 'D1', threadTs: 't0',
      kind: 'klaviyo_import', payload: { foo: 1 },
    });
    expect(row.confirmationToken).toBe('t1');
    expect(row.kind).toBe('klaviyo_import');
    expect(row.payload).toEqual({ foo: 1 });
  });

  it('insert throws on supabase error', async () => {
    chain.single.mockResolvedValue({ data: null, error: { message: 'unique violation' } });
    await expect(repo.insert({
      callerSlackId: 'U1', channelId: 'D1', threadTs: 't0', kind: 'klaviyo_import', payload: {},
    })).rejects.toThrow(/unique violation/);
  });

  it('insert throws on null data', async () => {
    chain.single.mockResolvedValue({ data: null, error: null });
    await expect(repo.insert({
      callerSlackId: 'U1', channelId: 'D1', threadTs: 't0', kind: 'klaviyo_import', payload: {},
    })).rejects.toThrow(/RLS/);
  });

  it('lookupByThread filters by caller + channel + thread + active expiry, returns mapped row', async () => {
    chain.maybeSingle.mockResolvedValue({
      data: {
        id: 'p1', confirmation_token: 't1',
        caller_slack_id: 'U1', channel_id: 'D1', thread_ts: 't0',
        kind: 'klaviyo_delete', payload: {},
        created_at: '2026-05-05T00:00:00Z', expires_at: '2026-05-05T00:30:00Z',
      },
      error: null,
    });
    const row = await repo.lookupByThread('U1', 'D1', 't0');
    expect(row?.id).toBe('p1');
    expect(row?.kind).toBe('klaviyo_delete');
    expect(chain.gt).toHaveBeenCalledWith('expires_at', expect.any(String));
    expect(chain.eq).toHaveBeenCalledWith('caller_slack_id', 'U1');
    expect(chain.eq).toHaveBeenCalledWith('channel_id', 'D1');
    expect(chain.eq).toHaveBeenCalledWith('thread_ts', 't0');
  });

  it('lookupByThread returns null when no row', async () => {
    chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await repo.lookupByThread('U1', 'D1', 't0')).toBeNull();
  });

  it('deleteById issues a delete by id', async () => {
    chain.eq = vi.fn().mockResolvedValue({ error: null });
    await repo.deleteById('p1');
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith('id', 'p1');
  });

  it('sweepExpired returns count of deleted rows', async () => {
    chain.select = vi.fn().mockReturnThis();
    chain.lt = vi.fn().mockResolvedValue({ data: [{ id: 'old1' }, { id: 'old2' }], error: null });
    const n = await repo.sweepExpired();
    expect(n).toBe(2);
    expect(chain.lt).toHaveBeenCalledWith('expires_at', expect.any(String));
  });

  it('countOutstanding filters by caller + active expiry', async () => {
    chain.gt = vi.fn().mockReturnThis();
    chain.eq = vi.fn().mockResolvedValue({ count: 1, error: null });
    expect(await repo.countOutstanding('U1')).toBe(1);
    expect(chain.eq).toHaveBeenCalledWith('caller_slack_id', 'U1');
    expect(chain.gt).toHaveBeenCalledWith('expires_at', expect.any(String));
  });
});
