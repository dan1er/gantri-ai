import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Orchestrator } from '../../../src/orchestrator/orchestrator.js';
import { ConnectorRegistry } from '../../../src/connectors/base/registry.js';
import type { Connector, ToolDef } from '../../../src/connectors/base/connector.js';

function buildPipedriveRegistry(overrides: {
  createLead?: (args: any) => any;
  addNote?: (args: any) => any;
  createActivity?: (args: any) => any;
} = {}) {
  const createLead: ToolDef = {
    name: 'pipedrive.create_lead',
    description: 'create lead',
    schema: z.object({ title: z.string() }).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async (args) =>
      overrides.createLead ? overrides.createLead(args) : { leadId: 'lead-uuid-1', leadTitle: (args as any).title, personCreated: true, orgCreated: true },
    ),
  };
  const addNote: ToolDef = {
    name: 'pipedrive.add_note',
    description: 'add note',
    schema: z.object({ targetType: z.string(), targetId: z.string(), content: z.string() }).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async (args) =>
      overrides.addNote ? overrides.addNote(args) : { noteId: 5511 },
    ),
  };
  const createActivity: ToolDef = {
    name: 'pipedrive.create_activity',
    description: 'create activity',
    schema: z.object({ subject: z.string(), type: z.string() }).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async (args) =>
      overrides.createActivity ? overrides.createActivity(args) : { activityId: 8801 },
    ),
  };
  const conn: Connector = {
    name: 'pipedrive',
    tools: [createLead, addNote, createActivity],
    async healthCheck() { return { ok: true }; },
  };
  const r = new ConnectorRegistry();
  r.register(conn);
  return { registry: r, createLead, addNote, createActivity };
}

function fakeClaude(responses: any[]) {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        if (i >= responses.length) throw new Error(`fakeClaude exhausted at call ${i + 1}`);
        return responses[i++];
      }),
    },
  };
}

const STD_USAGE = { input_tokens: 100, output_tokens: 20 };

describe('pipedrive write routing — orchestrator + LLM mock', () => {
  it('A. single create_lead', async () => {
    const { registry, createLead } = buildPipedriveRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'pipedrive_create_lead', input: { title: 'Foo Studio', personEmail: 'jane@foo.com' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'Created lead Foo Studio (id: lead-uuid-1).' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'Add jane@foo.com as a lead', threadHistory: [] });
    expect(out.toolCalls.map((c) => c.name)).toEqual(['pipedrive.create_lead']);
    expect((createLead.execute as any).mock.calls[0][0]).toMatchObject({ title: 'Foo Studio', personEmail: 'jane@foo.com' });
  });

  it('B. compound conversational turn — create_lead → add_note → create_activity', async () => {
    const { registry, createLead, addNote, createActivity } = buildPipedriveRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'pipedrive_create_lead', input: { title: 'Foo Studio', personEmail: 'jane@foostudio.com', orgName: 'Foo Studio' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'tool_use', id: 't2', name: 'pipedrive_add_note', input: { targetType: 'lead', targetId: 'lead-uuid-1', content: 'They want a matte black finish' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'tool_use', id: 't3', name: 'pipedrive_create_activity', input: { subject: 'Follow up with Foo Studio', type: 'call', dueDate: '2026-05-12', dueTime: '15:00', attachToType: 'lead', attachToId: 'lead-uuid-1' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'Created lead, pinned the note, scheduled the follow-up.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({
      question: 'I had a great call with Foo Studio (jane@foostudio.com). Add them as a lead, note that they want matte black, and remind me to follow up Tuesday at 3pm',
      threadHistory: [],
    });
    expect(out.toolCalls.map((c) => c.name)).toEqual([
      'pipedrive.create_lead', 'pipedrive.add_note', 'pipedrive.create_activity',
    ]);
    expect((addNote.execute as any).mock.calls[0][0]).toMatchObject({ targetType: 'lead', targetId: 'lead-uuid-1' });
    expect((createActivity.execute as any).mock.calls[0][0]).toMatchObject({ attachToType: 'lead', attachToId: 'lead-uuid-1' });
  });

  it('C. role gate: tool returns FORBIDDEN, LLM relays to user', async () => {
    const { registry } = buildPipedriveRegistry({
      createLead: () => ({ error: { code: 'FORBIDDEN', message: 'Pipedrive write tools require role=admin or role=marketing.' } }),
    });
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'pipedrive_create_lead', input: { title: 'X', personEmail: 'x@y.com' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: "Sorry — Pipedrive write tools require the admin or marketing role. Ping Danny if you need it." }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'Add a lead', threadHistory: [] });
    expect(out.toolCalls).toHaveLength(1);
    expect(out.response).toMatch(/admin or marketing/i);
  });

  it('D. analytics question does NOT auto-fire write tools', async () => {
    const { registry, createLead, addNote, createActivity } = buildPipedriveRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'text', text: 'Looking that up requires a read tool — I would call pipedrive.list_deals (not a write tool).' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'How many leads did we create last week?', threadHistory: [] });
    expect((createLead.execute as any)).not.toHaveBeenCalled();
    expect((addNote.execute as any)).not.toHaveBeenCalled();
    expect((createActivity.execute as any)).not.toHaveBeenCalled();
  });
});
