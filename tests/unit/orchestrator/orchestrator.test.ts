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
});
