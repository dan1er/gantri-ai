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
});
