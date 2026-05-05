import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KlaviyoDeletionsRepo } from '../../../src/storage/repositories/klaviyo-deletions.js';

describe('KlaviyoDeletionsRepo', () => {
  let chain: any;
  let client: any;
  let repo: KlaviyoDeletionsRepo;

  beforeEach(() => {
    chain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
    };
    client = { from: vi.fn(() => chain) } as any;
    repo = new KlaviyoDeletionsRepo(client);
  });

  it('insert persists requested_emails + counts and returns mapped row', async () => {
    chain.single.mockResolvedValue({
      data: {
        id: 'd1', caller_slack_id: 'U1', caller_email: 'a@b.com',
        requested_emails: ['x@y.com', 'z@w.com'],
        found_count: 2, deleted_count: 2, failed_count: 0, failed_details: [],
        status: 'submitted',
        started_at: '2026-05-05T00:00:00Z', completed_at: '2026-05-05T00:00:30Z',
      },
      error: null,
    });
    const row = await repo.insert({
      callerSlackId: 'U1', callerEmail: 'a@b.com',
      requestedEmails: ['x@y.com', 'z@w.com'],
      foundCount: 2, deletedCount: 2, failedCount: 0, failedDetails: [],
    });
    expect(row.id).toBe('d1');
    expect(row.requestedEmails).toEqual(['x@y.com', 'z@w.com']);
    expect(row.callerSlackId).toBe('U1');
    expect(row.deletedCount).toBe(2);
    expect(row.status).toBe('submitted');
    const arg = (chain.insert as any).mock.calls[0][0];
    expect(arg.requested_emails).toEqual(['x@y.com', 'z@w.com']);
    expect(arg.status).toBe('submitted');
  });

  it('insert throws when supabase returns error', async () => {
    chain.single.mockResolvedValue({ data: null, error: { message: 'duplicate' } });
    await expect(repo.insert({
      callerSlackId: 'U1', callerEmail: null, requestedEmails: ['x@y.com'],
      foundCount: 1, deletedCount: 1, failedCount: 0, failedDetails: [],
    })).rejects.toThrow(/duplicate/);
  });

  it('insert throws when supabase returns no data and no error', async () => {
    chain.single.mockResolvedValue({ data: null, error: null });
    await expect(repo.insert({
      callerSlackId: 'U1', callerEmail: null, requestedEmails: ['x@y.com'],
      foundCount: 1, deletedCount: 1, failedCount: 0, failedDetails: [],
    })).rejects.toThrow(/RLS/);
  });

  it('countInLastHour filters by caller + 1h window', async () => {
    chain.gte = vi.fn().mockReturnThis();
    chain.eq = vi.fn().mockResolvedValue({ count: 3, error: null });
    expect(await repo.countInLastHour('U1')).toBe(3);
    const gteCall = (chain.gte as any).mock.calls[0];
    expect(gteCall[0]).toBe('started_at');
    expect(typeof gteCall[1]).toBe('string');
  });
});
