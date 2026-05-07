import { describe, it, expect, vi } from 'vitest';
import { PipedriveConnector } from '../../../../src/connectors/pipedrive/connector.js';

interface Opts {
  callerRole?: 'admin' | 'marketing' | 'user' | null;
  findPerson?: any;
  findOrg?: any;
  createPerson?: any;
  createOrg?: any;
  createLead?: any;
  createNote?: any;
}

function makeDeps(opts: Opts = {}) {
  const insertedRows: any[] = [];
  return {
    client: {
      // read methods (unused by lead tool but typed)
      listPipelines: vi.fn(), listStages: vi.fn(), listUsers: vi.fn(),
      listDealFields: vi.fn(), listSourceOptions: vi.fn(),
      // write methods
      findPersonByEmail: opts.findPerson ?? vi.fn().mockResolvedValue(null),
      findOrganizationByName: opts.findOrg ?? vi.fn().mockResolvedValue(null),
      createPerson: opts.createPerson ?? vi.fn().mockResolvedValue({ id: 9012, name: 'Jane Doe' }),
      createOrganization: opts.createOrg ?? vi.fn().mockResolvedValue({ id: 7843, name: 'Foo Studio' }),
      createLead: opts.createLead ?? vi.fn().mockResolvedValue({ id: 'lead-uuid', title: 'Foo Studio', person_id: 9012, organization_id: 7843 }),
      createNote: opts.createNote ?? vi.fn().mockResolvedValue({ id: 5511, content: 'note' }),
    } as any,
    writesRepo: {
      insert: vi.fn(async (row: any) => { insertedRows.push(row); return { id: 'audit-row', ...row, createdAt: 'now' }; }),
    } as any,
    usersRepo: {
      getRole: vi.fn().mockResolvedValue(opts.callerRole === undefined ? 'marketing' : opts.callerRole),
    } as any,
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U_LANA', slackChannelId: 'D1' }),
    insertedRows,
  };
}

function getTool(deps: any) {
  const conn = new PipedriveConnector(deps);
  return conn.tools.find((t) => t.name === 'pipedrive.create_lead')!;
}

describe('pipedrive.create_lead', () => {
  it('marketing role → creates new person + new org + lead', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({
      title: 'Foo Studio',
      personEmail: 'jane@foo.com',
      personName: 'Jane Doe',
      orgName: 'Foo Studio',
      value: 5000,
      currency: 'USD',
    });
    expect((r as any).leadId).toBe('lead-uuid');
    expect((r as any).personCreated).toBe(true);
    expect((r as any).orgCreated).toBe(true);
    expect(deps.client.findPersonByEmail).toHaveBeenCalledWith('jane@foo.com');
    expect(deps.client.createPerson).toHaveBeenCalledWith({ name: 'Jane Doe', email: 'jane@foo.com', phone: undefined, orgId: 7843 });
    expect(deps.client.createOrganization).toHaveBeenCalledWith({ name: 'Foo Studio' });
    expect(deps.client.createLead).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Foo Studio', personId: 9012, orgId: 7843, value: { amount: 5000, currency: 'USD' },
    }));
    expect(deps.writesRepo.insert).toHaveBeenCalled();
    expect(deps.insertedRows[0].action).toBe('create_lead');
    expect(deps.insertedRows[0].status).toBe('success');
    expect(deps.insertedRows[0].pipedriveResourceId).toBe('lead-uuid');
  });

  it('email matches existing person → reuses, personCreated=false', async () => {
    const deps = makeDeps({
      findPerson: vi.fn().mockResolvedValue({ id: 4521, name: 'Jane Doe' }),
    });
    const r = await getTool(deps).execute({
      title: 'Lead — Jane',
      personEmail: 'jane@foo.com',
    });
    expect((r as any).personId).toBe(4521);
    expect((r as any).personCreated).toBe(false);
    expect(deps.client.createPerson).not.toHaveBeenCalled();
  });

  it('orgName exact match → reuses, orgCreated=false', async () => {
    const deps = makeDeps({
      findOrg: vi.fn().mockResolvedValue({ id: 9999, name: 'Foo Studio' }),
    });
    const r = await getTool(deps).execute({
      title: 'Foo Studio',
      personEmail: 'jane@foo.com',
      orgName: 'Foo Studio',
    });
    expect((r as any).orgId).toBe(9999);
    expect((r as any).orgCreated).toBe(false);
    expect(deps.client.createOrganization).not.toHaveBeenCalled();
  });

  it('FORBIDDEN for role=user, no Pipedrive call made', async () => {
    const deps = makeDeps({ callerRole: 'user' });
    const r = await getTool(deps).execute({ title: 'X', personEmail: 'x@y.com' });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(deps.client.createLead).not.toHaveBeenCalled();
    expect(deps.writesRepo.insert).not.toHaveBeenCalled();
  });

  it('schema rejects title with no person/org info', () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    expect(() => tool.schema.parse({ title: 'just a title' })).toThrow();
  });

  it('Pipedrive 400 on createLead → audit failure with partial=true (person/org leaked)', async () => {
    const deps = makeDeps({
      createLead: vi.fn().mockRejectedValue(Object.assign(new Error('bad request'), { status: 400, body: { error: 'bad' } })),
    });
    const r = await getTool(deps).execute({
      title: 'X',
      personEmail: 'jane@foo.com',
      orgName: 'Foo Studio',
    });
    expect((r as any).error.code).toBe('PIPEDRIVE_ERROR');
    expect(deps.insertedRows[0].status).toBe('failure');
    expect(deps.insertedRows[0].responsePayload).toMatchObject({
      partial: true,
      personIdLeaked: 9012,
      orgIdLeaked: 7843,
    });
  });

  it('note attached after lead creation; note failure does not roll back', async () => {
    const deps = makeDeps({
      createNote: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 500 })),
    });
    const r = await getTool(deps).execute({
      title: 'X',
      personEmail: 'jane@foo.com',
      note: 'they want matte black',
    });
    expect((r as any).leadId).toBe('lead-uuid');
    expect((r as any).noteSubmitted).toBe(false);
    expect((r as any).noteError).toMatch(/boom/);
  });
});
