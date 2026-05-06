import { describe, it, expect, vi } from 'vitest';
import { KlaviyoConnector } from '../../../../src/connectors/klaviyo/connector.js';

interface DepsOpts {
  callerRole?: 'admin' | 'marketing' | 'user' | null;
  createList?: any;
}

function makeDeps(opts: DepsOpts = {}) {
  return {
    client: {
      createList: opts.createList ?? vi.fn().mockResolvedValue({ id: 'NEW1', name: 'Test List' }),
      // unused but typed
      bulkSubscribeProfiles: vi.fn(), getBulkImportJobStatus: vi.fn(),
      findProfileByEmail: vi.fn(), requestProfileDeletion: vi.fn(),
      listLists: vi.fn().mockResolvedValue([]),
    } as any,
    importsRepo: { countInFlight: vi.fn(), countInLastHour: vi.fn(), insert: vi.fn(), getById: vi.fn(), getByJobId: vi.fn() } as any,
    deletionsRepo: { countInLastHour: vi.fn(), insert: vi.fn() } as any,
    pendingRepo: { countOutstanding: vi.fn(), insert: vi.fn() } as any,
    usersRepo: { getRole: vi.fn().mockResolvedValue(opts.callerRole === undefined ? 'admin' : opts.callerRole) } as any,
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U1', slackChannelId: 'D1' }),
    getActiveThread: vi.fn().mockReturnValue({ channelId: 'D1', threadTs: 't0' }),
  };
}

function getTool(deps: any) {
  const conn = new KlaviyoConnector(deps);
  return conn.tools.find((t) => t.name === 'klaviyo.create_list')!;
}

describe('klaviyo.create_list', () => {
  it('admin can create a list', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ name: 'BDNY 2026' });
    expect((r as any).ok).toBe(true);
    expect((r as any).id).toBe('NEW1');
    expect(deps.client.createList).toHaveBeenCalledWith({ name: 'BDNY 2026', optInProcess: undefined });
  });

  it('marketing role can create', async () => {
    const deps = makeDeps({ callerRole: 'marketing' });
    const r = await getTool(deps).execute({ name: 'X' });
    expect((r as any).ok).toBe(true);
  });

  it('FORBIDDEN for role=user', async () => {
    const deps = makeDeps({ callerRole: 'user' });
    const r = await getTool(deps).execute({ name: 'X' });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(deps.client.createList).not.toHaveBeenCalled();
  });

  it('NO_ACTOR when no actor', async () => {
    const deps = makeDeps();
    deps.getActor = vi.fn().mockReturnValue(undefined);
    const r = await getTool(deps).execute({ name: 'X' });
    expect((r as any).error.code).toBe('NO_ACTOR');
  });

  it('passes opt_in_process when provided', async () => {
    const deps = makeDeps();
    await getTool(deps).execute({ name: 'X', opt_in_process: 'single_opt_in' });
    expect(deps.client.createList).toHaveBeenCalledWith({ name: 'X', optInProcess: 'single_opt_in' });
  });

  it('NAME_TAKEN error when Klaviyo says duplicate', async () => {
    const err: any = new Error('name already exists');
    err.status = 400;
    const deps = makeDeps({ createList: vi.fn().mockRejectedValue(err) });
    const r = await getTool(deps).execute({ name: 'dup' });
    expect((r as any).error.code).toBe('NAME_TAKEN');
  });

  it('KLAVIYO_ERROR for other failures', async () => {
    const err: any = new Error('rate limit');
    err.status = 429;
    const deps = makeDeps({ createList: vi.fn().mockRejectedValue(err) });
    const r = await getTool(deps).execute({ name: 'X' });
    expect((r as any).error.code).toBe('KLAVIYO_ERROR');
  });
});
