import { describe, it, expect, vi } from 'vitest';
import { KlaviyoConnector } from '../../../../src/connectors/klaviyo/connector.js';

interface DepsOpts {
  callerRole?: 'admin' | 'marketing' | 'user' | null;
  listLists?: any;
  pendingOutstanding?: number;
}

function makeDeps(opts: DepsOpts = {}) {
  return {
    client: {
      listLists: opts.listLists ?? vi.fn().mockResolvedValue([
        { id: 'L1', name: 'Trade Customers' },
        { id: 'L2', name: 'Newsletter' },
      ]),
      deleteList: vi.fn().mockResolvedValue(undefined),
      // typed but unused
      bulkSubscribeProfiles: vi.fn(),
      findProfileByEmail: vi.fn(),
      requestProfileDeletion: vi.fn(),
      createList: vi.fn(),
    } as any,
    importsRepo: { countInFlight: vi.fn(), countInLastHour: vi.fn(), insert: vi.fn() } as any,
    deletionsRepo: { countInLastHour: vi.fn(), insert: vi.fn() } as any,
    pendingRepo: {
      countOutstanding: vi.fn().mockResolvedValue(opts.pendingOutstanding ?? 0),
      insert: vi.fn().mockResolvedValue({ id: 'p1', confirmationToken: 'tok-1' }),
    } as any,
    usersRepo: {
      getRole: vi.fn().mockResolvedValue(opts.callerRole === undefined ? 'admin' : opts.callerRole),
    } as any,
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U1', slackChannelId: 'D1' }),
    getActiveThread: vi.fn().mockReturnValue({ channelId: 'D1', threadTs: 't0' }),
  };
}

function getTool(deps: any) {
  const conn = new KlaviyoConnector(deps);
  return conn.tools.find((t) => t.name === 'klaviyo.delete_list')!;
}

describe('klaviyo.delete_list', () => {
  it('returns awaiting_confirmation with confirmation_token when resolved by id', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ id: 'L1' });
    expect((r as any).kind).toBe('awaiting_confirmation');
    expect((r as any).confirmation_token).toBe('tok-1');
    expect((r as any).list_id).toBe('L1');
    expect((r as any).list_name).toBe('Trade Customers');
    expect(deps.pendingRepo.insert).toHaveBeenCalledOnce();
    // Should NOT have called deleteList yet — that's the confirmation handler's job.
    expect(deps.client.deleteList).not.toHaveBeenCalled();
  });

  it('returns awaiting_confirmation when resolved by exact case-insensitive name', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ name: 'trade customers' });
    expect((r as any).kind).toBe('awaiting_confirmation');
    expect((r as any).list_id).toBe('L1');
    expect((r as any).list_name).toBe('Trade Customers');
  });

  it('FORBIDDEN for role=user', async () => {
    const deps = makeDeps({ callerRole: 'user' });
    const r = await getTool(deps).execute({ id: 'L1' });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(deps.client.listLists).not.toHaveBeenCalled();
  });

  it('FORBIDDEN for role=null', async () => {
    const deps = makeDeps({ callerRole: null });
    const r = await getTool(deps).execute({ id: 'L1' });
    expect((r as any).error.code).toBe('FORBIDDEN');
  });

  it('allows marketing role', async () => {
    const deps = makeDeps({ callerRole: 'marketing' });
    const r = await getTool(deps).execute({ id: 'L1' });
    expect((r as any).kind).toBe('awaiting_confirmation');
  });

  it('NO_ACTOR when no actor on context', async () => {
    const deps = makeDeps();
    deps.getActor = vi.fn().mockReturnValue(undefined);
    const r = await getTool(deps).execute({ id: 'L1' });
    expect((r as any).error.code).toBe('NO_ACTOR');
  });

  it('NOT_FOUND when id does not resolve', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ id: 'DOES_NOT_EXIST' });
    expect((r as any).error.code).toBe('NOT_FOUND');
    expect(deps.pendingRepo.insert).not.toHaveBeenCalled();
  });

  it('NOT_FOUND when name does not resolve', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ name: 'No Such List' });
    expect((r as any).error.code).toBe('NOT_FOUND');
  });

  it('AMBIGUOUS when multiple lists share the name', async () => {
    const deps = makeDeps({
      listLists: vi.fn().mockResolvedValue([
        { id: 'A1', name: 'Trade' },
        { id: 'A2', name: 'Trade' },
        { id: 'A3', name: 'Other' },
      ]),
    });
    const r = await getTool(deps).execute({ name: 'trade' });
    expect((r as any).error.code).toBe('AMBIGUOUS');
    expect((r as any).error.details.matches).toEqual([
      { id: 'A1', name: 'Trade' },
      { id: 'A2', name: 'Trade' },
    ]);
    expect(deps.pendingRepo.insert).not.toHaveBeenCalled();
  });

  it('PENDING_LIMIT when 3 pending outstanding', async () => {
    const deps = makeDeps({ pendingOutstanding: 3 });
    const r = await getTool(deps).execute({ id: 'L1' });
    expect((r as any).error.code).toBe('PENDING_LIMIT');
  });

  it('rejects when neither id nor name provided (Zod refinement)', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    expect(tool.schema.safeParse({}).success).toBe(false);
  });

  it('rejects when both id and name provided (Zod refinement)', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    expect(tool.schema.safeParse({ id: 'L1', name: 'X' }).success).toBe(false);
  });
});
