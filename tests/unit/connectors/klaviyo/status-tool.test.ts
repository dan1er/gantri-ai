import { describe, it, expect, vi } from 'vitest';
import { KlaviyoConnector } from '../../../../src/connectors/klaviyo/connector.js';

function makeDeps(row: any | null) {
  return {
    client: {
      bulkSubscribeProfiles: vi.fn(), getBulkImportJobStatus: vi.fn(),
      findProfileByEmail: vi.fn(), requestProfileDeletion: vi.fn(),
      listLists: vi.fn().mockResolvedValue([]),
    } as any,
    importsRepo: {
      countInFlight: vi.fn(), countInLastHour: vi.fn(), insert: vi.fn(),
      getById: vi.fn().mockResolvedValue(row),
      getByJobId: vi.fn().mockResolvedValue(row),
    } as any,
    deletionsRepo: { countInLastHour: vi.fn(), insert: vi.fn() } as any,
    pendingRepo: { countOutstanding: vi.fn(), insert: vi.fn() } as any,
    usersRepo: { getRole: vi.fn().mockResolvedValue('user') } as any,
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U1' }),
    getActiveThread: vi.fn().mockReturnValue({ channelId: 'D1', threadTs: 't0' }),
  };
}

function getTool(deps: any) {
  const conn = new KlaviyoConnector(deps);
  return conn.tools.find((t) => t.name === 'klaviyo.import_status')!;
}

describe('klaviyo.import_status', () => {
  it('returns the row by audit_id (with list, channels, counts, completed_at)', async () => {
    const row = {
      id: 'a1', klaviyoJobId: 'j1', status: 'complete',
      listId: 'L1', listName: 'Trade',
      channels: ['email'], totalSubmitted: 3, totalImported: 3, totalInvalidRejected: 0,
      succeededCount: 3, alreadySubscribedCount: 0, failedCount: 0,
      startedAt: '2026-05-05T10:00:00Z', completedAt: '2026-05-05T10:01:00Z',
      errorSummary: null,
    };
    const tool = getTool(makeDeps(row));
    const r = await tool.execute({ audit_id: '00000000-0000-0000-0000-000000000001' });
    expect((r as any).audit_id).toBe('a1');
    expect((r as any).klaviyo_job_id).toBe('j1');
    expect((r as any).status).toBe('complete');
    expect((r as any).list).toEqual({ id: 'L1', name: 'Trade' });
    expect((r as any).channels).toEqual(['email']);
    expect((r as any).total_submitted).toBe(3);
    expect((r as any).total_imported).toBe(3);
    expect((r as any).total_invalid_rejected).toBe(0);
    expect((r as any).succeeded_count).toBe(3);
    expect((r as any).completed_at).toBe('2026-05-05T10:01:00Z');
  });

  it('returns row by klaviyo_job_id when audit_id not provided', async () => {
    const row = {
      id: 'a2', klaviyoJobId: 'j2', status: 'queued',
      listId: null, listName: null,
      channels: ['email'], totalSubmitted: 1, totalImported: 1, totalInvalidRejected: 0,
      succeededCount: null, alreadySubscribedCount: null, failedCount: null,
      startedAt: '2026-05-05T10:00:00Z', completedAt: null, errorSummary: null,
    };
    const deps = makeDeps(row);
    const tool = getTool(deps);
    const r = await tool.execute({ klaviyo_job_id: 'j2' });
    expect((r as any).list).toBeNull();
    expect((r as any).status).toBe('queued');
    expect((r as any).completed_at).toBeUndefined();
    expect(deps.importsRepo.getByJobId).toHaveBeenCalledWith('j2');
  });

  it('returns NOT_FOUND when no row matches', async () => {
    const tool = getTool(makeDeps(null));
    const r = await tool.execute({ audit_id: '00000000-0000-0000-0000-000000000999' });
    expect((r as any).error.code).toBe('NOT_FOUND');
  });

  it('open to all roles (does not gate on role)', async () => {
    const row = {
      id: 'a', klaviyoJobId: 'j', status: 'queued',
      listId: null, listName: null,
      channels: ['email'], totalSubmitted: 1, totalImported: 1, totalInvalidRejected: 0,
      succeededCount: null, alreadySubscribedCount: null, failedCount: null,
      startedAt: '2026-05-05T10:00:00Z', completedAt: null, errorSummary: null,
    };
    const deps = makeDeps(row);
    deps.usersRepo.getRole = vi.fn().mockResolvedValue('user');
    const tool = getTool(deps);
    const r = await tool.execute({ audit_id: '00000000-0000-0000-0000-000000000001' });
    expect((r as any).status).toBe('queued');
  });

  it('rejects args with neither audit_id nor klaviyo_job_id (Zod refine)', async () => {
    const tool = getTool(makeDeps(null));
    expect(tool.schema.safeParse({}).success).toBe(false);
  });
});
