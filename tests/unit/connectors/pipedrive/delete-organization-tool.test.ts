import { describe, it, expect, vi } from 'vitest';
import { PipedriveConnector } from '../../../../src/connectors/pipedrive/connector.js';

function makeDeps(opts: {
  callerRole?: 'admin' | 'marketing' | 'user' | null;
  getOrganization?: any;
  deleteOrganization?: any;
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
      getOrganization: opts.getOrganization ?? vi.fn().mockResolvedValue({ id: 7843, name: 'Foo Studio' }),
      deleteOrganization: opts.deleteOrganization ?? vi.fn().mockResolvedValue({ id: 7843 }),
    } as any,
    writesRepo: { insert: vi.fn(async (row: any) => { insertedRows.push(row); return { id: 'a', ...row, createdAt: 'now' }; }) } as any,
    usersRepo: { getRole: vi.fn().mockResolvedValue(opts.callerRole === undefined ? 'marketing' : opts.callerRole) } as any,
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U_LANA' }),
    insertedRows,
  };
}

function getTool(deps: any) {
  const conn = new PipedriveConnector(deps);
  return conn.tools.find((t) => t.name === 'pipedrive.delete_organization')!;
}

describe('pipedrive.delete_organization', () => {
  it('preview returns org name + the unlink warning, does NOT delete', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ orgId: 7843, confirm: false });
    expect((r as any).kind).toBe('awaiting_confirmation');
    expect((r as any).orgId).toBe(7843);
    expect((r as any).orgName).toBe('Foo Studio');
    expect((r as any).message).toMatch(/Foo Studio/);
    expect((r as any).message).toMatch(/UNLINKED/);
    expect((r as any).message).toMatch(/recycle bin/i);
    expect(deps.client.deleteOrganization).not.toHaveBeenCalled();
  });

  it('confirm=true deletes + audits', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ orgId: 7843, confirm: true });
    expect((r as any).ok).toBe(true);
    expect(deps.client.deleteOrganization).toHaveBeenCalledWith(7843);
    expect(deps.insertedRows[0].action).toBe('delete_organization');
    expect(deps.insertedRows[0].pipedriveResourceId).toBe('7843');
  });

  it('preview when org returns 404 → ORGANIZATION_NOT_FOUND, no delete', async () => {
    const deps = makeDeps({
      getOrganization: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { status: 404 })),
    });
    const r = await getTool(deps).execute({ orgId: 9999, confirm: false });
    expect((r as any).error.code).toBe('ORGANIZATION_NOT_FOUND');
    expect(deps.client.deleteOrganization).not.toHaveBeenCalled();
  });

  it('preview when getOrganization resolves to null → ORGANIZATION_NOT_FOUND', async () => {
    // Defensive guard: even if the v2 client returns null instead of throwing.
    const deps = makeDeps({ getOrganization: vi.fn().mockResolvedValue(null) });
    const r = await getTool(deps).execute({ orgId: 9999, confirm: false });
    expect((r as any).error.code).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('FORBIDDEN for role=user', async () => {
    const deps = makeDeps({ callerRole: 'user' });
    const r = await getTool(deps).execute({ orgId: 7843, confirm: true });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(deps.client.deleteOrganization).not.toHaveBeenCalled();
    expect(deps.client.getOrganization).not.toHaveBeenCalled();
  });

  it('schema rejects float orgId', () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    expect(() => tool.schema.parse({ orgId: 1.5, confirm: true })).toThrow();
  });

  it('confirm=true on Pipedrive 500 → audit failure', async () => {
    const deps = makeDeps({
      deleteOrganization: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 500, body: { error: 'internal' } })),
    });
    const r = await getTool(deps).execute({ orgId: 7843, confirm: true });
    expect((r as any).error.code).toBe('PIPEDRIVE_ERROR');
    expect(deps.insertedRows[0].status).toBe('failure');
  });
});
