import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Orchestrator } from '../../../src/orchestrator/orchestrator.js';
import { ConnectorRegistry } from '../../../src/connectors/base/registry.js';
import type { Connector, ToolDef } from '../../../src/connectors/base/connector.js';

function buildRegistry(execResult: unknown = { summary: { actual: { spend: 700 } } }) {
  const tool: ToolDef = {
    name: 'northbeam.overview',
    description: 'overview',
    schema: z.object({}).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async () => execResult),
  };
  const conn: Connector = { name: 'northbeam', tools: [tool], async healthCheck() { return { ok: true }; } };
  const r = new ConnectorRegistry();
  r.register(conn);
  return { registry: r, tool };
}

function fakeClaude(responses: any[]) {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => responses[i++]),
    },
  };
}

describe('Orchestrator', () => {
  it('passes final text back when Claude stops without tool use', async () => {
    const { registry } = buildRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'text', text: 'Hello there.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({
      registry,
      claude: claude as any,
      model: 'claude-sonnet-4-6',
      maxIterations: 3,
    });
    const out = await orch.run({ question: 'hi', threadHistory: [] });
    expect(out.response).toBe('Hello there.');
    expect(out.toolCalls).toEqual([]);
  });

  it('executes a tool, feeds the result back, and returns final text', async () => {
    const { registry, tool } = buildRegistry();
    const claude: any = fakeClaude([
      {
        content: [
          { type: 'text', text: 'Let me check…' },
          { type: 'tool_use', id: 'toolu_1', name: 'northbeam.overview', input: { dateRange: { startDate: '2026-04-17', endDate: '2026-04-23' } } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 20 },
        model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'You spent $700.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 200, output_tokens: 10 },
        model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({
      registry,
      claude: claude as any,
      model: 'claude-sonnet-4-6',
      maxIterations: 3,
    });
    const out = await orch.run({ question: 'spend last week', threadHistory: [] });
    expect(out.response).toBe('You spent $700.');
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]).toMatchObject({ name: 'northbeam.overview' });
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  it('stops after maxIterations and returns a graceful message', async () => {
    const { registry } = buildRegistry();
    const loopResponse = {
      content: [{ type: 'tool_use', id: 't', name: 'northbeam.overview', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-6',
    };
    const claude: any = fakeClaude(Array(10).fill(loopResponse));
    const orch = new Orchestrator({
      registry,
      claude: claude as any,
      model: 'claude-sonnet-4-6',
      maxIterations: 2,
    });
    const out = await orch.run({ question: 'infinite', threadHistory: [] });
    expect(out.response).toMatch(/didn't converge|iteration limit/i);
  });

  it('appends a non-cached pending CSV system block when pendingContext is provided', async () => {
    const { registry } = buildRegistry();
    const create = vi.fn(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-6',
    }));
    const orch = new Orchestrator({
      registry,
      claude: { messages: { create } } as any,
      model: 'claude-sonnet-4-6',
      maxIterations: 3,
    });
    await orch.run({
      question: 'lista de prueba',
      threadHistory: [],
      pendingContext: {
        kind: 'klaviyo_csv_pending',
        filename: 'leads.csv',
        rowCount: 5,
        channels: ['email'],
        availableLists: [
          { id: 'L1', name: 'Trade Show Leads' },
          { id: 'L2', name: 'lista de prueba' },
        ],
      },
    });
    const callArgs = create.mock.calls[0][0];
    expect(Array.isArray(callArgs.system)).toBe(true);
    expect(callArgs.system).toHaveLength(2);
    // Block 0: base system prompt, cached.
    expect(callArgs.system[0].cache_control).toEqual({ type: 'ephemeral' });
    // Block 1: pending CSV note, NOT cached (varies per turn).
    expect(callArgs.system[1].cache_control).toBeUndefined();
    const note = callArgs.system[1].text as string;
    expect(note).toMatch(/leads\.csv/);
    expect(note).toMatch(/Rows ready to import: 5/);
    expect(note).toMatch(/Trade Show Leads/);
    expect(note).toMatch(/lista de prueba/);
    expect(note).toMatch(/klaviyo\.commit_pending_csv_import/);
    expect(note).toMatch(/klaviyo\.create_list/);
    expect(note).toMatch(/DO NOT call klaviyo\.import_profiles/);
  });

  it('does not append a pending CSV system block when pendingContext is omitted', async () => {
    const { registry } = buildRegistry();
    const create = vi.fn(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-6',
    }));
    const orch = new Orchestrator({
      registry,
      claude: { messages: { create } } as any,
      model: 'claude-sonnet-4-6',
      maxIterations: 3,
    });
    await orch.run({ question: 'hi', threadHistory: [] });
    const callArgs = create.mock.calls[0][0];
    expect(callArgs.system).toHaveLength(1);
  });

  it('handles availableLists empty (e.g., listLists() failed) without crashing', async () => {
    const { registry } = buildRegistry();
    const create = vi.fn(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-6',
    }));
    const orch = new Orchestrator({
      registry,
      claude: { messages: { create } } as any,
      model: 'claude-sonnet-4-6',
      maxIterations: 3,
    });
    await orch.run({
      question: 'lista de prueba',
      threadHistory: [],
      pendingContext: {
        kind: 'klaviyo_csv_pending',
        filename: 'leads.csv',
        rowCount: 5,
        channels: ['email'],
        availableLists: [],
      },
    });
    const note = (create.mock.calls[0][0].system as any[])[1].text as string;
    // Should still produce a coherent note even without list directory.
    expect(note).toMatch(/leads\.csv/);
    expect(note).toMatch(/list directory unavailable/i);
  });
});
