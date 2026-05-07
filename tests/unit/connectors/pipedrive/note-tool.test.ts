import { describe, it, expect, vi } from 'vitest';
import { PipedriveConnector } from '../../../../src/connectors/pipedrive/connector.js';

function makeDeps(opts: { callerRole?: 'admin' | 'marketing' | 'user' | null; createNote?: any } = {}) {
  const insertedRows: any[] = [];
  return {
    client: {
      listPipelines: vi.fn(), listStages: vi.fn(), listUsers: vi.fn(),
      listDealFields: vi.fn(), listSourceOptions: vi.fn(),
      findPersonByEmail: vi.fn(), findOrganizationByName: vi.fn(),
      createPerson: vi.fn(), createOrganization: vi.fn(), createLead: vi.fn(),
      createNote: opts.createNote ?? vi.fn().mockResolvedValue({ id: 5511, content: 'hello' }),
      createActivity: vi.fn(),
    } as any,
    writesRepo: { insert: vi.fn(async (row: any) => { insertedRows.push(row); return { id: 'a', ...row, createdAt: 'now' }; }) } as any,
    usersRepo: { getRole: vi.fn().mockResolvedValue(opts.callerRole === undefined ? 'marketing' : opts.callerRole) } as any,
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U_LANA', slackChannelId: 'D1' }),
    insertedRows,
  };
}

function getTool(deps: any) {
  const conn = new PipedriveConnector(deps);
  return conn.tools.find((t) => t.name === 'pipedrive.add_note')!;
}

describe('pipedrive.add_note', () => {
  it('lead UUID target → calls createNote with lead_id', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({
      targetType: 'lead',
      targetId: '550e8400-e29b-41d4-a716-446655440000',
      content: 'They want matte black',
    });
    expect((r as any).noteId).toBe(5511);
    expect(deps.client.createNote).toHaveBeenCalledWith({
      content: 'They want matte black',
      leadId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(deps.insertedRows[0].action).toBe('add_note');
    expect(deps.insertedRows[0].status).toBe('success');
  });

  it('deal integer target → calls createNote with deal_id', async () => {
    const deps = makeDeps();
    await getTool(deps).execute({ targetType: 'deal', targetId: '12345', content: 'deal note' });
    expect(deps.client.createNote).toHaveBeenCalledWith({ content: 'deal note', dealId: 12345 });
  });

  it('person target with non-integer id → INVALID_ARGS', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ targetType: 'person', targetId: 'abc', content: 'x' });
    expect((r as any).error.code).toBe('INVALID_ARGS');
  });

  it('lead target with non-UUID id → INVALID_ARGS', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ targetType: 'lead', targetId: '12345', content: 'x' });
    expect((r as any).error.code).toBe('INVALID_ARGS');
  });

  it('FORBIDDEN for role=user', async () => {
    const deps = makeDeps({ callerRole: 'user' });
    const r = await getTool(deps).execute({ targetType: 'deal', targetId: '12345', content: 'x' });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(deps.client.createNote).not.toHaveBeenCalled();
  });

  it('schema rejects empty content', () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    expect(() => tool.schema.parse({ targetType: 'lead', targetId: 'x', content: '' })).toThrow();
  });

  it('Pipedrive 400 → audit failure + error returned', async () => {
    const deps = makeDeps({
      createNote: vi.fn().mockRejectedValue(Object.assign(new Error('bad'), { status: 400, body: { error: 'bad' } })),
    });
    const r = await getTool(deps).execute({
      targetType: 'lead', targetId: '550e8400-e29b-41d4-a716-446655440000', content: 'x',
    });
    expect((r as any).error.code).toBe('PIPEDRIVE_ERROR');
    expect(deps.insertedRows[0].status).toBe('failure');
  });
});
