import type { Connector, ToolDef, ToolResult } from './connector.js';

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
    const parsed = tool.schema.safeParse(rawArgs);
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
