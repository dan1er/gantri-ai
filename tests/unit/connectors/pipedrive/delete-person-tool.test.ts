import { describe, it, expect, vi } from 'vitest';
import { PipedriveConnector } from '../../../../src/connectors/pipedrive/connector.js';

function makeDeps(opts: {
  callerRole?: 'admin' | 'marketing' | 'user' | null;
  getPerson?: any;
  deletePerson?: any;
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
      getActivity: vi.fn(), deleteActivity: vi.fn(),
      getOrganization: vi.fn(), deleteOrganization: vi.fn(),
      getPerson: opts.getPerson ?? vi.fn().mockResolvedValue({ id: 2841, name: 'Jane Test', open_deals_count: 0, email: [{ value: 'jane@test.com' }] }),
      deletePerson: opts.deletePerson ?? vi.fn().mockResolvedValue({ id: 2841 }),
    } as any,
    writesRepo: { insert: vi.fn(async (row: any) => { insertedRows.push(row); return { id: 'a', ...row, createdAt: 'now' }; }) } as any,
    usersRepo: { getRole: vi.fn().mockResolvedValue(opts.callerRole === undefined ? 'marketing' : opts.callerRole) } as any,
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U_LANA' }),
    insertedRows,
  };
}

function getTool(deps: any) {
  const conn = new PipedriveConnector(deps);
  return conn.tools.find((t) => t.name === 'pipedrive.delete_person')!;
}

describe('pipedrive.delete_person', () => {
  it('preview returns name + email + no orphan warning when no open deals', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ personId: 2841, confirm: false });
    expect((r as any).kind).toBe('awaiting_confirmation');
    expect((r as any).personId).toBe(2841);
    expect((r as any).personName).toBe('Jane Test');
    expect((r as any).personEmail).toBe('jane@test.com');
    expect((r as any).message).toMatch(/Jane Test/);
    expect((r as any).message).not.toMatch(/⚠️/);
    expect(deps.client.deletePerson).not.toHaveBeenCalled();
  });

  it('preview with open_deals_count > 0 → orphan warning', async () => {
    const deps = makeDeps({
      getPerson: vi.fn().mockResolvedValue({ id: 1, name: 'Active Contact', open_deals_count: 3, email: null }),
    });
    const r = await getTool(deps).execute({ personId: 1, confirm: false });
    expect((r as any).message).toMatch(/⚠️/);
    expect((r as any).message).toMatch(/3 open deals/);
    expect((r as any).message).toMatch(/UNLINKED/);
  });

  it('singular pluralization for 1 open deal', async () => {
    const deps = makeDeps({
      getPerson: vi.fn().mockResolvedValue({ id: 1, name: 'Solo', open_deals_count: 1, email: null }),
    });
    const r = await getTool(deps).execute({ personId: 1, confirm: false });
    expect((r as any).message).toMatch(/1 open deal/);
    expect((r as any).message).not.toMatch(/1 open deals/);
  });

  it('confirm=true deletes + audits', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ personId: 2841, confirm: true });
    expect((r as any).ok).toBe(true);
    expect(deps.client.deletePerson).toHaveBeenCalledWith(2841);
    expect(deps.insertedRows[0].action).toBe('delete_person');
    expect(deps.insertedRows[0].pipedriveResourceId).toBe('2841');
  });

  it('preview when person 404 → PERSON_NOT_FOUND', async () => {
    const deps = makeDeps({
      getPerson: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { status: 404 })),
    });
    const r = await getTool(deps).execute({ personId: 9999, confirm: false });
    expect((r as any).error.code).toBe('PERSON_NOT_FOUND');
  });

  it('preview when getPerson resolves to null → PERSON_NOT_FOUND', async () => {
    const deps = makeDeps({ getPerson: vi.fn().mockResolvedValue(null) });
    const r = await getTool(deps).execute({ personId: 9999, confirm: false });
    expect((r as any).error.code).toBe('PERSON_NOT_FOUND');
  });

  it('FORBIDDEN for role=user', async () => {
    const deps = makeDeps({ callerRole: 'user' });
    const r = await getTool(deps).execute({ personId: 2841, confirm: true });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(deps.client.deletePerson).not.toHaveBeenCalled();
  });

  it('schema rejects non-positive personId', () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    expect(() => tool.schema.parse({ personId: 0, confirm: true })).toThrow();
    expect(() => tool.schema.parse({ personId: 1.5, confirm: true })).toThrow();
  });

  it('confirm=true on Pipedrive 500 → audit failure', async () => {
    const deps = makeDeps({
      deletePerson: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 500 })),
    });
    const r = await getTool(deps).execute({ personId: 2841, confirm: true });
    expect((r as any).error.code).toBe('PIPEDRIVE_ERROR');
    expect(deps.insertedRows[0].status).toBe('failure');
  });
});
