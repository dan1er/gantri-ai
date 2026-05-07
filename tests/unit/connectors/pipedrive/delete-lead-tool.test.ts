import { describe, it, expect, vi } from 'vitest';
import { PipedriveConnector } from '../../../../src/connectors/pipedrive/connector.js';

function makeDeps(opts: {
  callerRole?: 'admin' | 'marketing' | 'user' | null;
  getLead?: any;
  deleteLead?: any;
} = {}) {
  const insertedRows: any[] = [];
  return {
    client: {
      listPipelines: vi.fn(), listStages: vi.fn(), listUsers: vi.fn(),
      listDealFields: vi.fn(), listSourceOptions: vi.fn(),
      findPersonByEmail: vi.fn(), findOrganizationByName: vi.fn(),
      createPerson: vi.fn(), createOrganization: vi.fn(), createLead: vi.fn(),
      createNote: vi.fn(), createActivity: vi.fn(),
      getLead: opts.getLead ?? vi.fn().mockResolvedValue({ id: '550e8400-e29b-41d4-a716-446655440000', title: 'Foo Studio', person_id: null, organization_id: null }),
      deleteLead: opts.deleteLead ?? vi.fn().mockResolvedValue({ id: '550e8400-e29b-41d4-a716-446655440000' }),
    } as any,
    writesRepo: { insert: vi.fn(async (row: any) => { insertedRows.push(row); return { id: 'a', ...row, createdAt: 'now' }; }) } as any,
    usersRepo: { getRole: vi.fn().mockResolvedValue(opts.callerRole === undefined ? 'marketing' : opts.callerRole) } as any,
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U_LANA', slackChannelId: 'D1' }),
    insertedRows,
  };
}

function getTool(deps: any) {
  const conn = new PipedriveConnector(deps);
  return conn.tools.find((t) => t.name === 'pipedrive.delete_lead')!;
}

describe('pipedrive.delete_lead', () => {
  it('first call (confirm=false) returns awaiting_confirmation with the lead title; does NOT delete', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ leadId: '550e8400-e29b-41d4-a716-446655440000', confirm: false });
    expect((r as any).kind).toBe('awaiting_confirmation');
    expect((r as any).leadTitle).toBe('Foo Studio');
    expect((r as any).message).toMatch(/Foo Studio/);
    expect((r as any).message).toMatch(/recycle bin/i);
    expect(deps.client.deleteLead).not.toHaveBeenCalled();
    expect(deps.writesRepo.insert).not.toHaveBeenCalled();
  });

  it('second call (confirm=true) actually deletes + audits', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ leadId: '550e8400-e29b-41d4-a716-446655440000', confirm: true });
    expect((r as any).ok).toBe(true);
    expect(deps.client.deleteLead).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000');
    expect(deps.insertedRows[0].action).toBe('delete_lead');
    expect(deps.insertedRows[0].status).toBe('success');
    expect(deps.insertedRows[0].pipedriveResourceId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('preview when lead not found → LEAD_NOT_FOUND, no audit row', async () => {
    const deps = makeDeps({ getLead: vi.fn().mockResolvedValue(null) });
    const r = await getTool(deps).execute({ leadId: '550e8400-e29b-41d4-a716-446655440000', confirm: false });
    expect((r as any).error.code).toBe('LEAD_NOT_FOUND');
    expect(deps.client.deleteLead).not.toHaveBeenCalled();
    expect(deps.writesRepo.insert).not.toHaveBeenCalled();
  });

  it('confirm=true on Pipedrive 404 → audit failure, error returned', async () => {
    const deps = makeDeps({
      deleteLead: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { status: 404, body: { error: 'not found' } })),
    });
    const r = await getTool(deps).execute({ leadId: '550e8400-e29b-41d4-a716-446655440000', confirm: true });
    expect((r as any).error.code).toBe('PIPEDRIVE_ERROR');
    expect(deps.insertedRows[0].status).toBe('failure');
    expect(deps.insertedRows[0].action).toBe('delete_lead');
  });

  it('FORBIDDEN for role=user, no Pipedrive call made even on confirm=true', async () => {
    const deps = makeDeps({ callerRole: 'user' });
    const r = await getTool(deps).execute({ leadId: '550e8400-e29b-41d4-a716-446655440000', confirm: true });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(deps.client.deleteLead).not.toHaveBeenCalled();
    expect(deps.client.getLead).not.toHaveBeenCalled();
    expect(deps.writesRepo.insert).not.toHaveBeenCalled();
  });

  it('schema rejects non-UUID leadId', () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    expect(() => tool.schema.parse({ leadId: '12345', confirm: true })).toThrow();
  });

  it('schema defaults confirm to false when omitted', () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    const parsed = tool.schema.parse({ leadId: '550e8400-e29b-41d4-a716-446655440000' });
    expect((parsed as any).confirm).toBe(false);
  });
});
