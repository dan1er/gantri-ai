import type { z } from 'zod';

export interface ToolDef<TArgs = unknown, TResult = unknown> {
  /** Fully-qualified name, e.g. "northbeam.sales". */
  name: string;
  /** Human-readable description passed to the LLM. */
  description: string;
  /** Zod schema validating the args object. */
  schema: z.ZodType<TArgs>;
  /** JSON Schema representation of `schema`, for the Claude tool manifest. */
  jsonSchema: Record<string, unknown>;
  /** Executes the tool with validated args. */
  execute(args: TArgs): Promise<TResult>;
}

export interface Connector {
  readonly name: string;
  readonly tools: readonly ToolDef[];
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}
