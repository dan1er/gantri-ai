import { describe, it, expect, vi } from 'vitest';
import { KlaviyoConnector } from '../../../../src/connectors/klaviyo/connector.js';

interface DepsOpts {
  callerRole?: 'admin' | 'marketing' | 'user' | null;
  bulkSubscribe?: any;
  countInFlight?: number;
  countInLastHour?: number;
  pendingOutstanding?: number;
  insertImport?: any;
  insertPending?: any;
  listLists?: Array<{ id: string; name: string }>;
  threadCtx?: { channelId: string; threadTs: string } | null;
}

function makeDeps(opts: DepsOpts = {}) {
  return {
    client: {
      bulkSubscribeProfiles: opts.bulkSubscribe ?? vi.fn().mockResolvedValue({ job_id: 'job-1' }),
      listLists: vi.fn().mockResolvedValue(opts.listLists ?? [{ id: 'L1', name: 'Trade Customers' }]),
    } as any,
    importsRepo: {
      countInFlight: vi.fn().mockResolvedValue(opts.countInFlight ?? 0),
      countInLastHour: vi.fn().mockResolvedValue(opts.countInLastHour ?? 0),
      insert: opts.insertImport ?? vi.fn().mockResolvedValue({
        id: 'audit-1', klaviyoJobId: 'job-1', status: 'queued',
      }),
    } as any,
    pendingRepo: {
      countOutstanding: vi.fn().mockResolvedValue(opts.pendingOutstanding ?? 0),
      insert: opts.insertPending ?? vi.fn().mockResolvedValue({
        id: 'p1', confirmationToken: 'tok-1',
      }),
    } as any,
    usersRepo: {
      getRole: vi.fn().mockResolvedValue(opts.callerRole === undefined ? 'admin' : opts.callerRole),
    } as any,
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U1', slackChannelId: 'D1' }),
    getActiveThread: vi.fn().mockReturnValue(opts.threadCtx === undefined ? { channelId: 'D1', threadTs: 't0' } : opts.threadCtx),
  };
}

function getTool(deps: any) {
  const conn = new KlaviyoConnector(deps);
  return conn.tools.find((t) => t.name === 'klaviyo.import_profiles')!;
}

describe('klaviyo.import_profiles', () => {
  it('imports directly when 0 invalid (admin caller)', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'a@x.com' }, { email: 'b@y.com' }], channels: ['email'] });
    expect((r as any).kind).toBe('imported_directly');
    expect((r as any).total_imported).toBe(2);
    expect((r as any).total_invalid_rejected).toBe(0);
    expect(deps.client.bulkSubscribeProfiles).toHaveBeenCalledOnce();
    expect(deps.importsRepo.insert).toHaveBeenCalledOnce();
  });

  it('returns awaiting_confirmation when ≥1 invalid', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    const r = await tool.execute({
      profiles: [{ email: 'a@x.com' }, { email: 'gertrude@@gmail.com' }],
      channels: ['email'],
    });
    expect((r as any).kind).toBe('awaiting_confirmation');
    expect((r as any).valid_count).toBe(1);
    expect((r as any).invalid_count).toBe(1);
    expect(deps.client.bulkSubscribeProfiles).not.toHaveBeenCalled();
    expect(deps.pendingRepo.insert).toHaveBeenCalledOnce();
  });

  it('returns all_invalid when 0 valid rows', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'gertrude@@gmail.com' }], channels: ['email'] });
    expect((r as any).kind).toBe('all_invalid');
    expect(deps.client.bulkSubscribeProfiles).not.toHaveBeenCalled();
    expect(deps.pendingRepo.insert).not.toHaveBeenCalled();
  });

  it('FORBIDDEN for role=user', async () => {
    const deps = makeDeps({ callerRole: 'user' });
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'a@x.com' }], channels: ['email'] });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(deps.client.bulkSubscribeProfiles).not.toHaveBeenCalled();
  });

  it('allows marketing role', async () => {
    const deps = makeDeps({ callerRole: 'marketing' });
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'a@x.com' }], channels: ['email'] });
    expect((r as any).kind).toBe('imported_directly');
  });

  it('NO_ACTOR when no actor on context', async () => {
    const deps = makeDeps();
    deps.getActor = vi.fn().mockReturnValue(undefined);
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'a@x.com' }], channels: ['email'] });
    expect((r as any).error.code).toBe('NO_ACTOR');
  });

  it('rate-limits on 5 in-flight', async () => {
    const deps = makeDeps({ countInFlight: 5 });
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'a@x.com' }], channels: ['email'] });
    expect((r as any).error.code).toBe('RATE_LIMITED');
  });

  it('rate-limits on >20 attempts in last hour', async () => {
    const deps = makeDeps({ countInLastHour: 21 });
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'a@x.com' }], channels: ['email'] });
    expect((r as any).error.code).toBe('RATE_LIMITED');
  });

  it('hits PENDING_LIMIT when caller has 3 pending', async () => {
    const deps = makeDeps({ pendingOutstanding: 3 });
    const tool = getTool(deps);
    const r = await tool.execute({
      profiles: [{ email: 'a@x.com' }, { email: 'gertrude@@gmail.com' }],
      channels: ['email'],
    });
    expect((r as any).error.code).toBe('PENDING_LIMIT');
  });

  it('resolves list name via listLists', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'a@x.com' }], channels: ['email'], list: 'trade customers' });
    expect((r as any).kind).toBe('imported_directly');
    const arg = (deps.client.bulkSubscribeProfiles as any).mock.calls[0][0];
    expect(arg.listId).toBe('L1');
  });

  it('returns LIST_NOT_FOUND when name does not match', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'a@x.com' }], channels: ['email'], list: 'foobar' });
    expect((r as any).error.code).toBe('LIST_NOT_FOUND');
  });

  it('extracts list name from natural-language phrases ("subelos a lista de prueba" → "lista de prueba")', async () => {
    const deps = makeDeps({ listLists: [
      { id: 'L_PRUEBA', name: 'lista de prueba' },
      { id: 'L_TRADE', name: 'Trade Customers' },
    ] });
    const tool = getTool(deps);
    const r = await tool.execute({
      profiles: [{ email: 'a@x.com' }],
      channels: ['email'],
      list: 'subelos a lista de prueba',
    });
    expect((r as any).kind).toBe('imported_directly');
    const subscribeCall = (deps.client.bulkSubscribeProfiles as any).mock.calls[0][0];
    expect(subscribeCall.listId).toBe('L_PRUEBA');
  });

  it('does NOT false-match a short list name ("PR") inside a longer word ("prueba") — regression', async () => {
    const deps = makeDeps({ listLists: [
      { id: 'L_PR', name: 'PR' },
      { id: 'L_PRUEBA', name: 'lista de prueba' },
    ] });
    const tool = getTool(deps);
    const r = await tool.execute({
      profiles: [{ email: 'a@x.com' }],
      channels: ['email'],
      list: 'lista de prueba',
    });
    expect((r as any).kind).toBe('imported_directly');
    const subscribeCall = (deps.client.bulkSubscribeProfiles as any).mock.calls[0][0];
    // MUST resolve to the exact-name match (lista de prueba), NOT the
    // accidentally-substring-matching "PR" inside "**pr**ueba".
    expect(subscribeCall.listId).toBe('L_PRUEBA');
  });

  it('multiple natural-language matches → LIST_NOT_FOUND with both as suggestions', async () => {
    const deps = makeDeps({ listLists: [
      { id: 'L_A', name: 'lista de prueba' },
      { id: 'L_B', name: 'segunda lista de prueba' },
    ] });
    const tool = getTool(deps);
    const r = await tool.execute({
      profiles: [{ email: 'a@x.com' }],
      channels: ['email'],
      list: 'subelos a la segunda lista de prueba',
    });
    // Both lists' names appear in the input; the tool should ask the user.
    expect((r as any).error.code).toBe('LIST_NOT_FOUND');
    const sugg = (r as any).error.details.suggestions;
    expect(sugg.length).toBeGreaterThanOrEqual(1);
  });
});
