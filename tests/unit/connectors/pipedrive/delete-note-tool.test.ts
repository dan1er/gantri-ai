import { describe, it, expect, vi } from 'vitest';
import { PipedriveConnector } from '../../../../src/connectors/pipedrive/connector.js';

function makeDeps(opts: {
  callerRole?: 'admin' | 'marketing' | 'user' | null;
  getNote?: any;
  deleteNote?: any;
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
      getNote: opts.getNote ?? vi.fn().mockResolvedValue({ id: 5511, content: 'They want a custom matte black finish on the wave line', lead_id: 'lead-uuid', deal_id: null, person_id: null, org_id: null }),
      deleteNote: opts.deleteNote ?? vi.fn().mockResolvedValue({ id: 5511 }),
      getActivity: vi.fn(), deleteActivity: vi.fn(),
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
  return conn.tools.find((t) => t.name === 'pipedrive.delete_note')!;
}

describe('pipedrive.delete_note', () => {
  it('first call (confirm=false) returns awaiting_confirmation with content snippet; does NOT delete', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ noteId: 5511, confirm: false });
    expect((r as any).kind).toBe('awaiting_confirmation');
    expect((r as any).noteId).toBe(5511);
    expect((r as any).contentSnippet).toMatch(/matte black/);
    expect((r as any).message).toMatch(/recycle bin/i);
    expect(deps.client.deleteNote).not.toHaveBeenCalled();
    expect(deps.writesRepo.insert).not.toHaveBeenCalled();
  });

  it('strips HTML when rendering the snippet (Pipedrive stores notes as HTML)', async () => {
    const deps = makeDeps({
      getNote: vi.fn().mockResolvedValue({ id: 1, content: '<p>Hello <b>world</b></p>', lead_id: null, deal_id: 1, person_id: null, org_id: null }),
    });
    const r = await getTool(deps).execute({ noteId: 1, confirm: false });
    expect((r as any).contentSnippet).toBe('Hello world');
  });

  it('confirm=true deletes + audits success', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ noteId: 5511, confirm: true });
    expect((r as any).ok).toBe(true);
    expect(deps.client.deleteNote).toHaveBeenCalledWith(5511);
    expect(deps.insertedRows[0].action).toBe('delete_note');
    expect(deps.insertedRows[0].status).toBe('success');
    expect(deps.insertedRows[0].pipedriveResourceId).toBe('5511');
  });

  it('preview when note not found → NOTE_NOT_FOUND', async () => {
    const deps = makeDeps({ getNote: vi.fn().mockResolvedValue(null) });
    const r = await getTool(deps).execute({ noteId: 9999, confirm: false });
    expect((r as any).error.code).toBe('NOTE_NOT_FOUND');
  });

  it('FORBIDDEN for role=user, no Pipedrive call made', async () => {
    const deps = makeDeps({ callerRole: 'user' });
    const r = await getTool(deps).execute({ noteId: 5511, confirm: true });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(deps.client.deleteNote).not.toHaveBeenCalled();
    expect(deps.client.getNote).not.toHaveBeenCalled();
  });

  it('schema rejects non-positive integer noteId', () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    expect(() => tool.schema.parse({ noteId: 0, confirm: true })).toThrow();
    expect(() => tool.schema.parse({ noteId: -1, confirm: true })).toThrow();
    expect(() => tool.schema.parse({ noteId: 1.5, confirm: true })).toThrow();
  });

  it('confirm=true on Pipedrive 404 → audit failure, error returned', async () => {
    const deps = makeDeps({
      deleteNote: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { status: 404 })),
    });
    const r = await getTool(deps).execute({ noteId: 5511, confirm: true });
    expect((r as any).error.code).toBe('PIPEDRIVE_ERROR');
    expect(deps.insertedRows[0].status).toBe('failure');
    expect(deps.insertedRows[0].action).toBe('delete_note');
  });
});
