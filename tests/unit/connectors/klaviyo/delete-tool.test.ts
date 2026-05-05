import { describe, it, expect, vi } from 'vitest';
import { KlaviyoConnector } from '../../../../src/connectors/klaviyo/connector.js';

interface DepsOpts {
  callerRole?: 'admin' | 'marketing' | 'user' | null;
  findProfileByEmail?: any;
  countDeletesInHour?: number;
  pendingOutstanding?: number;
}

function makeDeps(opts: DepsOpts = {}) {
  return {
    client: {
      findProfileByEmail: opts.findProfileByEmail ?? vi.fn(async (email: string) => {
        if (email.startsWith('not')) return null;
        return { id: `pid-${email}`, created_at: '2024-08-12T19:03:45+00:00', lists: ['Trade'] };
      }),
      // these are unused for delete tool but required by type
      bulkSubscribeProfiles: vi.fn(),
      listLists: vi.fn().mockResolvedValue([]),
    } as any,
    importsRepo: { countInFlight: vi.fn(), countInLastHour: vi.fn(), insert: vi.fn() } as any,
    deletionsRepo: {
      countInLastHour: vi.fn().mockResolvedValue(opts.countDeletesInHour ?? 0),
    } as any,
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
  return conn.tools.find((t) => t.name === 'klaviyo.delete_profiles')!;
}

describe('klaviyo.delete_profiles', () => {
  it('returns awaiting_confirmation with found + not_found split', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    const r = await tool.execute({ emails: ['a@x.com', 'notfound@y.com', 'b@z.com'] });
    expect((r as any).kind).toBe('awaiting_confirmation');
    expect((r as any).found.length).toBe(2);
    expect((r as any).not_found.length).toBe(1);
    expect((r as any).not_found).toContain('notfound@y.com');
    expect(deps.pendingRepo.insert).toHaveBeenCalledOnce();
  });

  it('returns nothing_found when 0 profiles match', async () => {
    const deps = makeDeps({ findProfileByEmail: vi.fn().mockResolvedValue(null) });
    const tool = getTool(deps);
    const r = await tool.execute({ emails: ['a@x.com', 'b@y.com'] });
    expect((r as any).kind).toBe('nothing_found');
    expect((r as any).requested_count).toBe(2);
    expect(deps.pendingRepo.insert).not.toHaveBeenCalled();
  });

  it('FORBIDDEN for role=user', async () => {
    const deps = makeDeps({ callerRole: 'user' });
    const tool = getTool(deps);
    const r = await tool.execute({ emails: ['a@x.com'] });
    expect((r as any).error.code).toBe('FORBIDDEN');
  });

  it('allows marketing role', async () => {
    const deps = makeDeps({ callerRole: 'marketing' });
    const tool = getTool(deps);
    const r = await tool.execute({ emails: ['a@x.com'] });
    expect((r as any).kind).toBe('awaiting_confirmation');
  });

  it('NO_ACTOR when no actor on context', async () => {
    const deps = makeDeps();
    deps.getActor = vi.fn().mockReturnValue(undefined);
    const tool = getTool(deps);
    const r = await tool.execute({ emails: ['a@x.com'] });
    expect((r as any).error.code).toBe('NO_ACTOR');
  });

  it('dedupes case-insensitively', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    await tool.execute({ emails: ['a@x.com', 'A@X.COM', 'b@y.com'] });
    expect(deps.client.findProfileByEmail).toHaveBeenCalledTimes(2);
  });

  it('rate-limits 5+ deletes in last hour', async () => {
    const deps = makeDeps({ countDeletesInHour: 5 });
    const tool = getTool(deps);
    const r = await tool.execute({ emails: ['a@x.com'] });
    expect((r as any).error.code).toBe('RATE_LIMITED');
  });

  it('hits PENDING_LIMIT when 3 pending outstanding', async () => {
    const deps = makeDeps({ pendingOutstanding: 3 });
    const tool = getTool(deps);
    const r = await tool.execute({ emails: ['a@x.com'] });
    expect((r as any).error.code).toBe('PENDING_LIMIT');
  });

  it('rejects empty array via Zod', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    // Zod validation on tool.execute happens in the registry layer normally;
    // but the schema is exposed so we can verify directly:
    expect(tool.schema.safeParse({ emails: [] }).success).toBe(false);
  });

  it('rejects 51 emails via Zod', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    const fifty1 = Array.from({ length: 51 }, (_, i) => `u${i}@x.com`);
    expect(tool.schema.safeParse({ emails: fifty1 }).success).toBe(false);
  });
});
