import { describe, it, expect, vi } from 'vitest';
import { PipedriveConnector } from '../../../../src/connectors/pipedrive/connector.js';

function makeDeps(opts: { callerRole?: 'admin' | 'marketing' | 'user' | null; createActivity?: any } = {}) {
  const insertedRows: any[] = [];
  return {
    client: {
      listPipelines: vi.fn(), listStages: vi.fn(), listUsers: vi.fn(),
      listDealFields: vi.fn(), listSourceOptions: vi.fn(),
      findPersonByEmail: vi.fn(), findOrganizationByName: vi.fn(),
      createPerson: vi.fn(), createOrganization: vi.fn(), createLead: vi.fn(),
      createNote: vi.fn(),
      createActivity: opts.createActivity ?? vi.fn().mockResolvedValue({ id: 8801, subject: 'Follow up' }),
    } as any,
    writesRepo: { insert: vi.fn(async (row: any) => { insertedRows.push(row); return { id: 'a', ...row, createdAt: 'now' }; }) } as any,
    usersRepo: { getRole: vi.fn().mockResolvedValue(opts.callerRole === undefined ? 'marketing' : opts.callerRole) } as any,
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U_LANA', slackChannelId: 'D1' }),
    insertedRows,
  };
}

function getTool(deps: any) {
  const conn = new PipedriveConnector(deps);
  return conn.tools.find((t) => t.name === 'pipedrive.create_activity')!;
}

describe('pipedrive.create_activity', () => {
  it('minimal task succeeds', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ subject: 'Follow up', type: 'task' });
    expect((r as any).activityId).toBe(8801);
    expect(deps.client.createActivity).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Follow up', type: 'task',
    }));
    expect(deps.insertedRows[0].action).toBe('create_activity');
    expect(deps.insertedRows[0].pipedriveResourceId).toBe('8801');
  });

  it('full call activity with attachment to lead', async () => {
    const deps = makeDeps();
    await getTool(deps).execute({
      subject: 'Follow up', type: 'call',
      dueDate: '2026-05-12', dueTime: '15:00',
      durationMinutes: 30, note: 'Talk pricing',
      attachToType: 'lead', attachToId: '550e8400-e29b-41d4-a716-446655440000',
      assigneeUserId: 42,
    });
    expect(deps.client.createActivity).toHaveBeenCalledWith({
      subject: 'Follow up', type: 'call',
      dueDate: '2026-05-12', dueTime: '15:00',
      durationMinutes: 30, note: 'Talk pricing',
      leadId: '550e8400-e29b-41d4-a716-446655440000',
      userId: 42,
    });
  });

  it('attach to deal (integer)', async () => {
    const deps = makeDeps();
    await getTool(deps).execute({
      subject: 'X', type: 'meeting',
      attachToType: 'deal', attachToId: '12345',
    });
    expect(deps.client.createActivity).toHaveBeenCalledWith(expect.objectContaining({
      dealId: 12345,
    }));
  });

  it('attach to lead with non-UUID → INVALID_ARGS', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({
      subject: 'X', type: 'task', attachToType: 'lead', attachToId: '12345',
    });
    expect((r as any).error.code).toBe('INVALID_ARGS');
    expect(deps.client.createActivity).not.toHaveBeenCalled();
  });

  it('FORBIDDEN for role=user', async () => {
    const deps = makeDeps({ callerRole: 'user' });
    const r = await getTool(deps).execute({ subject: 'X', type: 'task' });
    expect((r as any).error.code).toBe('FORBIDDEN');
  });

  it('schema rejects unknown type', () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    expect(() => tool.schema.parse({ subject: 'X', type: 'wizard' })).toThrow();
  });
});
