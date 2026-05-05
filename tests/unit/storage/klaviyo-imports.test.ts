import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KlaviyoImportsRepo, type KlaviyoImportRow } from '../../../src/storage/repositories/klaviyo-imports.js';

function makeStub(table: any) {
  return { from: vi.fn(() => table) } as any;
}

describe('KlaviyoImportsRepo', () => {
  let chain: any;
  let client: any;
  let repo: KlaviyoImportsRepo;

  beforeEach(() => {
    chain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      head: false,
    };
    client = makeStub(chain);
    repo = new KlaviyoImportsRepo(client);
  });

  it('insert returns the inserted row', async () => {
    chain.single.mockResolvedValue({ data: { id: 'abc', status: 'queued' }, error: null });
    const row = await repo.insert({
      callerSlackId: 'U1', callerEmail: 'a@b.com', source: 'inline',
      listId: null, listName: null, channels: ['email'],
      totalSubmitted: 3, totalImported: 3, totalInvalidRejected: 0,
      klaviyoJobId: 'job-1', status: 'queued',
    });
    expect(row.id).toBe('abc');
  });

  it('countInFlight filters status + caller', async () => {
    const head = { count: 2, error: null };
    chain.in = vi.fn().mockReturnThis();
    chain.eq = vi.fn().mockResolvedValue(head);
    expect(await repo.countInFlight('U1')).toBe(2);
    expect(chain.in).toHaveBeenCalledWith('status', ['queued', 'processing']);
  });

  it('countInLastHour filters started_at + caller', async () => {
    chain.gte = vi.fn().mockReturnThis();
    chain.eq = vi.fn().mockResolvedValue({ count: 5, error: null });
    expect(await repo.countInLastHour('U1')).toBe(5);
    const arg = (chain.gte as any).mock.calls[0];
    expect(arg[0]).toBe('started_at');
    expect(typeof arg[1]).toBe('string');
  });

  it('listInFlight returns rows with status queued/processing', async () => {
    chain.in = vi.fn().mockReturnThis();
    chain.order = vi.fn().mockReturnThis();
    chain.limit = vi.fn().mockResolvedValue({ data: [{ id: 'x', status: 'processing', klaviyo_job_id: 'j' }], error: null });
    const rows = await repo.listInFlight(50);
    expect(rows.length).toBe(1);
  });

  it('updateStatus sets status + counts + completed_at on terminal', async () => {
    chain.update = vi.fn().mockReturnThis();
    chain.eq = vi.fn().mockResolvedValue({ data: null, error: null });
    await repo.updateStatus('abc', { status: 'complete', succeededCount: 3, alreadySubscribedCount: 0, failedCount: 0 });
    const update = (chain.update as any).mock.calls[0][0];
    expect(update.status).toBe('complete');
    expect(update.succeeded_count).toBe(3);
    expect(update.completed_at).toBeDefined();
  });

  it('getById returns null when not found', async () => {
    chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await repo.getById('xyz')).toBeNull();
  });

  it('rowFromDb maps every column from snake_case to camelCase', async () => {
    chain.maybeSingle.mockResolvedValue({
      data: {
        id: 'u', caller_slack_id: 'U1', caller_email: 'a@b.com',
        source: 'csv', filename: 'f.csv', storage_path: 'p/f.csv',
        list_id: 'L1', list_name: 'L', channels: ['email', 'sms'],
        total_submitted: 10, total_imported: 9, total_invalid_rejected: 1,
        klaviyo_job_id: 'job', status: 'complete',
        started_at: '2026-05-05T00:00:00Z', completed_at: '2026-05-05T00:00:30Z',
        succeeded_count: 8, already_subscribed_count: 1, failed_count: 0,
        error_summary: null,
      },
      error: null,
    });
    const r = await repo.getById('u');
    expect(r).toEqual({
      id: 'u', callerSlackId: 'U1', callerEmail: 'a@b.com',
      source: 'csv', filename: 'f.csv', storagePath: 'p/f.csv',
      listId: 'L1', listName: 'L', channels: ['email', 'sms'],
      totalSubmitted: 10, totalImported: 9, totalInvalidRejected: 1,
      klaviyoJobId: 'job', status: 'complete',
      startedAt: '2026-05-05T00:00:00Z', completedAt: '2026-05-05T00:00:30Z',
      succeededCount: 8, alreadySubscribedCount: 1, failedCount: 0,
      errorSummary: null,
    });
  });

  it('updateStatus does NOT set completed_at on non-terminal status', async () => {
    chain.update = vi.fn().mockReturnThis();
    chain.eq = vi.fn().mockResolvedValue({ data: null, error: null });
    await repo.updateStatus('abc', { status: 'processing' });
    const update = (chain.update as any).mock.calls[0][0];
    expect(update.status).toBe('processing');
    expect(update.completed_at).toBeUndefined();
  });
});
