import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { Connector, ToolDef } from '../../src/connectors/base/connector.js';
import { ConnectorRegistry } from '../../src/connectors/base/registry.js';

function fakeTool(name: string, execute = vi.fn()): ToolDef {
  return {
    name,
    description: `tool ${name}`,
    schema: z.object({}).passthrough(),
    jsonSchema: { type: 'object' },
    execute,
  };
}

function fakeConnector(name: string, tools: ToolDef[]): Connector {
  return {
    name,
    tools,
    async healthCheck() { return { ok: true }; },
  };
}

describe('ConnectorRegistry', () => {
  it('collects tools across connectors by qualified name', () => {
    const r = new ConnectorRegistry();
    r.register(fakeConnector('a', [fakeTool('a.one'), fakeTool('a.two')]));
    r.register(fakeConnector('b', [fakeTool('b.one')]));
    expect(r.getAllTools().map((t) => t.name).sort()).toEqual(['a.one', 'a.two', 'b.one']);
  });

  it('executes by qualified name', async () => {
    const exec = vi.fn().mockResolvedValue({ ok: true, data: 42 });
    const r = new ConnectorRegistry();
    r.register(fakeConnector('x', [fakeTool('x.go', exec)]));
    const result = await r.execute('x.go', { foo: 'bar' });
    expect(result).toEqual({ ok: true, data: 42 });
    expect(exec).toHaveBeenCalledWith({ foo: 'bar' });
  });

  it('returns an error result when tool does not exist', async () => {
    const r = new ConnectorRegistry();
    const result = await r.execute('missing.tool', {});
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TOOL_NOT_FOUND');
  });

  it('returns an error result when args fail schema validation', async () => {
    const schema = z.object({ n: z.number() });
    const tool: ToolDef<{ n: number }> = {
      name: 't.strict',
      description: '',
      schema,
      jsonSchema: {},
      execute: vi.fn(),
    };
    const r = new ConnectorRegistry();
    r.register(fakeConnector('t', [tool as ToolDef]));
    const result = await r.execute('t.strict', { n: 'not-a-number' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGS');
  });

  it('refuses duplicate connector names', () => {
    const r = new ConnectorRegistry();
    r.register(fakeConnector('dup', []));
    expect(() => r.register(fakeConnector('dup', []))).toThrow(/already registered/);
  });
});
