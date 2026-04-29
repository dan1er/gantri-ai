import type { Connector, ToolDef, ToolResult } from './connector.js';

/** Recursively JSON-parse string values that look like serialized objects or
 *  arrays. Anthropic tool calls usually send proper objects, but the LLM
 *  occasionally stringifies nested args (especially complex unions like
 *  DateRangeArg). Without this, Zod rejects the stringified payload because
 *  none of the union branches accept a raw string-encoded object. */
export function unstringifyJsonObjects(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const looksJson = (trimmed.startsWith('{') && trimmed.endsWith('}'))
      || (trimmed.startsWith('[') && trimmed.endsWith(']'));
    if (!looksJson) return value;
    try {
      const parsed = JSON.parse(trimmed);
      // Only return parsed if it's actually an object/array (not a
      // string-encoded primitive); otherwise keep the original string.
      if (parsed !== null && typeof parsed === 'object') {
        return unstringifyJsonObjects(parsed);
      }
      return value;
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(unstringifyJsonObjects);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = unstringifyJsonObjects(v);
    }
    return out;
  }
  return value;
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();
  private readonly tools = new Map<string, ToolDef>();

  register(connector: Connector): void {
    if (this.connectors.has(connector.name)) {
      throw new Error(`Connector '${connector.name}' already registered`);
    }
    this.connectors.set(connector.name, connector);
    for (const tool of connector.tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`Tool '${tool.name}' already registered`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  getAllTools(): ToolDef[] {
    return [...this.tools.values()];
  }

  getConnectors(): Connector[] {
    return [...this.connectors.values()];
  }

  async execute(toolName: string, rawArgs: unknown): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { ok: false, error: { code: 'TOOL_NOT_FOUND', message: `Unknown tool: ${toolName}` } };
    }
    // Defend against the LLM occasionally serializing nested args as JSON
    // strings (observed for `dateRange`). Recursively un-stringify before
    // Zod validation so every tool benefits without opting in.
    const preprocessed = unstringifyJsonObjects(rawArgs);
    const parsed = tool.schema.safeParse(preprocessed);
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: 'INVALID_ARGS', message: parsed.error.message },
      };
    }
    try {
      const data = await tool.execute(parsed.data);
      if (
        data &&
        typeof data === 'object' &&
        'ok' in (data as Record<string, unknown>)
      ) {
        return data as ToolResult;
      }
      return { ok: true, data };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'TOOL_EXEC_FAILED',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
