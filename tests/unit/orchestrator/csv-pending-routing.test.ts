import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Orchestrator } from '../../../src/orchestrator/orchestrator.js';
import { ConnectorRegistry } from '../../../src/connectors/base/registry.js';
import type { Connector, ToolDef } from '../../../src/connectors/base/connector.js';

/**
 * Builds a registry pre-loaded with stub klaviyo tools that return canned
 * responses. The stubs let us assert the LLM's tool-call sequence without
 * touching real Klaviyo. Each test passes overrides for the tools whose
 * response shape it wants to control.
 */
function buildKlaviyoRegistry(overrides: {
  commitImport?: (args: any) => any;
  createList?: (args: any) => any;
  listLists?: () => any;
} = {}) {
  const commitImport: ToolDef = {
    name: 'klaviyo.commit_pending_csv_import',
    description: 'commit',
    schema: z.object({ list: z.string() }).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async (args) =>
      overrides.commitImport
        ? overrides.commitImport(args)
        : { kind: 'imported_directly', total_imported: 5, list: { id: 'L1', name: (args as any).list }, message: `Submitted 5 profiles to Klaviyo (list: ${(args as any).list}).` },
    ),
  };
  const createList: ToolDef = {
    name: 'klaviyo.create_list',
    description: 'create',
    schema: z.object({ name: z.string() }).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async (args) =>
      overrides.createList
        ? overrides.createList(args)
        : { ok: true, id: 'L_NEW', name: (args as any).name, message: `Created Klaviyo list "${(args as any).name}".` },
    ),
  };
  const listListsTool: ToolDef = {
    name: 'klaviyo.list_lists',
    description: 'list',
    schema: z.object({}).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async () =>
      overrides.listLists ? overrides.listLists() : { count: 0, lists: [] },
    ),
  };
  const conn: Connector = {
    name: 'klaviyo',
    tools: [commitImport, createList, listListsTool],
    async healthCheck() { return { ok: true }; },
  };
  const r = new ConnectorRegistry();
  r.register(conn);
  return { registry: r, commitImport, createList, listListsTool };
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

const PENDING_CTX = {
  kind: 'klaviyo_csv_pending' as const,
  filename: 'leads.csv',
  rowCount: 5,
  channels: ['email'] as ('email' | 'sms')[],
  availableLists: [
    { id: 'L_TRADE', name: 'Trade Show Leads' },
    { id: 'L_PRUEBA', name: 'lista de prueba' },
    { id: 'L_PRUEBA2', name: 'prueba' },
    { id: 'L_BDNY', name: 'BDNY 2026' },
  ],
};

const STD_USAGE = { input_tokens: 100, output_tokens: 20 };

describe('csv-pending reply routing — orchestrator + LLM mock', () => {
  it('1. bare list name, list exists → single commit_pending_csv_import call', async () => {
    const { registry, commitImport } = buildKlaviyoRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'klaviyo_commit_pending_csv_import', input: { list: 'lista de prueba' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'Submitted 5 profiles to Klaviyo (list: lista de prueba).' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'lista de prueba', threadHistory: [], pendingContext: PENDING_CTX });
    expect(out.toolCalls.map((c) => c.name)).toEqual(['klaviyo.commit_pending_csv_import']);
    expect((commitImport.execute as any).mock.calls[0][0]).toEqual({ list: 'lista de prueba' });
    expect(out.response).toMatch(/Submitted/);
  });

  it('2. compound intent (name + create-if-missing) → create_list THEN commit', async () => {
    const { registry, createList, commitImport } = buildKlaviyoRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'klaviyo_create_list', input: { name: 'lista nueva' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'tool_use', id: 't2', name: 'klaviyo_commit_pending_csv_import', input: { list: 'lista nueva' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'Created list "lista nueva". Submitted 5 profiles.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({
      question: 'I want to save them to lista nueva, crea la lista si no existe',
      threadHistory: [],
      pendingContext: PENDING_CTX,
    });
    expect(out.toolCalls.map((c) => c.name)).toEqual([
      'klaviyo.create_list',
      'klaviyo.commit_pending_csv_import',
    ]);
    expect((createList.execute as any).mock.calls[0][0]).toEqual({ name: 'lista nueva' });
    expect((commitImport.execute as any).mock.calls[0][0]).toEqual({ list: 'lista nueva' });
  });

  it('3. "no list" → commit with that exact string (connector handles skip token)', async () => {
    const { registry, commitImport } = buildKlaviyoRegistry({
      commitImport: () => ({ kind: 'imported_directly', total_imported: 5, list: null, message: 'Submitted 5 profiles to Klaviyo. They typically appear within ~1 minute.' }),
    });
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'klaviyo_commit_pending_csv_import', input: { list: 'no list' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'Submitted 5 profiles to Klaviyo. They typically appear within ~1 minute.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'no list', threadHistory: [], pendingContext: PENDING_CTX });
    expect((commitImport.execute as any).mock.calls[0][0]).toEqual({ list: 'no list' });
    expect(out.response).toMatch(/Submitted/);
  });

  it('4. short ambiguous "prueba" → treated as list-selection (not help request)', async () => {
    const { registry, commitImport } = buildKlaviyoRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'klaviyo_commit_pending_csv_import', input: { list: 'prueba' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'Submitted 5 profiles to Klaviyo (list: prueba).' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'prueba', threadHistory: [], pendingContext: PENDING_CTX });
    expect(out.toolCalls.map((c) => c.name)).toEqual(['klaviyo.commit_pending_csv_import']);
    expect((commitImport.execute as any).mock.calls[0][0]).toEqual({ list: 'prueba' });
  });

  it('5. off-topic mid-flow ("how many rows did you say?") → text reply, no tool calls', async () => {
    const { registry, commitImport } = buildKlaviyoRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'text', text: 'It was 5 rows from leads.csv. Reply with a list name when ready.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'how many rows did you say?', threadHistory: [], pendingContext: PENDING_CTX });
    expect(out.toolCalls).toEqual([]);
    expect((commitImport.execute as any)).not.toHaveBeenCalled();
    expect(out.response).toMatch(/5 rows/);
  });

  it('6. bare list name, list missing → commit returns LIST_NOT_FOUND → LLM asks user (no second tool call)', async () => {
    const { registry, commitImport, createList } = buildKlaviyoRegistry({
      commitImport: () => ({ error: { code: 'LIST_NOT_FOUND', message: 'No list matched "lista nueva"', details: { suggestions: [], normalizedName: 'lista nueva' } } }),
    });
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'klaviyo_commit_pending_csv_import', input: { list: 'lista nueva' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'There\'s no list called "lista nueva". Want me to create it? Reply yes to create, or pick a different list name.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'lista nueva', threadHistory: [], pendingContext: PENDING_CTX });
    expect(out.toolCalls.map((c) => c.name)).toEqual(['klaviyo.commit_pending_csv_import']);
    expect((createList.execute as any)).not.toHaveBeenCalled();
    expect(out.response).toMatch(/Want me to create/i);
    expect((commitImport.execute as any)).toHaveBeenCalledTimes(1);
  });

  it('7. multi-list ambiguity ("add to A and B") → LLM asks user, no commit', async () => {
    const { registry, commitImport } = buildKlaviyoRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'text', text: 'I can only import to one list at a time. Pick "Trade Show Leads" or "BDNY 2026"?' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({
      question: 'add them to Trade Show Leads and BDNY 2026',
      threadHistory: [],
      pendingContext: PENDING_CTX,
    });
    expect(out.toolCalls).toEqual([]);
    expect((commitImport.execute as any)).not.toHaveBeenCalled();
    expect(out.response).toMatch(/one list at a time/i);
  });
});
