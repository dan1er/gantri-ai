import { describe, it, expect, vi } from 'vitest';
import { PipedriveConnector } from '../../../../src/connectors/pipedrive/connector.js';

function makeDeps(opts: {
  callerRole?: 'admin' | 'marketing' | 'user' | null;
  getActivity?: any;
  deleteActivity?: any;
} = {}) {
  const insertedRows: any[] = [];
  return {
    client: {
      listPipelines: vi.fn(), listStages: vi.fn(), listUsers: vi.fn(),
      listDealFields: vi.fn(), listSourceOptions: vi.fn(),
      findPersonByEmail: vi.fn(), findOrganizationByName: vi.fn(),
      createPerson: vi.fn(), createOrganization: vi.fn(), createLead: vi.fn(),
      createNote: vi.fn(), createActivity: vi.fn(),
      getLead: vi.fn(), deleteLead: vi.fn(),
      getNote: vi.fn(), deleteNote: vi.fn(),
      getActivity: opts.getActivity ?? vi.fn().mockResolvedValue({ id: 8801, subject: 'Follow up with Foo Studio', type: 'call', due_date: '2026-05-12', due_time: '15:00', done: false }),
      deleteActivity: opts.deleteActivity ?? vi.fn().mockResolvedValue({ id: 8801 }),
      getOrganization: vi.fn(), deleteOrganization: vi.fn(),
    } as any,
    writesRepo: { insert: vi.fn(async (row: any) => { insertedRows.push(row); return { id: 'a', ...row, createdAt: 'now' }; }) } as any,
    usersRepo: { getRole: vi.fn().mockResolvedValue(opts.callerRole === undefined ? 'marketing' : opts.callerRole) } as any,
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U_LANA' }),
    insertedRows,
  };
}

function getTool(deps: any) {
  const conn = new PipedriveConnector(deps);
  return conn.tools.find((t) => t.name === 'pipedrive.delete_activity')!;
}

describe('pipedrive.delete_activity', () => {
  it('preview returns subject + type + formatted due date', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ activityId: 8801, confirm: false });
    expect((r as any).kind).toBe('awaiting_confirmation');
    expect((r as any).subject).toBe('Follow up with Foo Studio');
    expect((r as any).message).toMatch(/Follow up with Foo Studio/);
    expect((r as any).message).toMatch(/2026-05-12 15:00/);
    expect(deps.client.deleteActivity).not.toHaveBeenCalled();
  });

  it('preview without due date renders "no due date"', async () => {
    const deps = makeDeps({
      getActivity: vi.fn().mockResolvedValue({ id: 1, subject: 'Open task', type: 'task', due_date: null, due_time: null, done: false }),
    });
    const r = await getTool(deps).execute({ activityId: 1, confirm: false });
    expect((r as any).message).toMatch(/no due date/);
  });

  it('confirm=true deletes + audits', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ activityId: 8801, confirm: true });
    expect((r as any).ok).toBe(true);
    expect(deps.client.deleteActivity).toHaveBeenCalledWith(8801);
    expect(deps.insertedRows[0].action).toBe('delete_activity');
    expect(deps.insertedRows[0].pipedriveResourceId).toBe('8801');
  });

  it('preview when activity missing → ACTIVITY_NOT_FOUND', async () => {
    const deps = makeDeps({ getActivity: vi.fn().mockResolvedValue(null) });
    const r = await getTool(deps).execute({ activityId: 999, confirm: false });
    expect((r as any).error.code).toBe('ACTIVITY_NOT_FOUND');
  });

  it('FORBIDDEN for role=user', async () => {
    const deps = makeDeps({ callerRole: 'user' });
    const r = await getTool(deps).execute({ activityId: 8801, confirm: true });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(deps.client.deleteActivity).not.toHaveBeenCalled();
  });

  it('schema rejects negative activityId', () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    expect(() => tool.schema.parse({ activityId: -1, confirm: true })).toThrow();
  });
});
