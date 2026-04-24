import type Anthropic from '@anthropic-ai/sdk';
import type { ConnectorRegistry } from '../connectors/base/registry.js';
import { buildSystemPrompt } from './prompts.js';
import { describeCatalog } from '../connectors/northbeam/catalog.js';
import { logger } from '../logger.js';

export interface OrchestratorInput {
  question: string;
  threadHistory: Array<{ question: string; response: string | null }>;
}

export interface OrchestratorOutput {
  response: string;
  model: string;
  toolCalls: Array<{ name: string; args: unknown; ok: boolean; errorMessage?: string }>;
  tokensInput: number;
  tokensOutput: number;
  iterations: number;
}

export interface OrchestratorOptions {
  registry: ConnectorRegistry;
  claude: Anthropic;
  model: string;
  maxIterations?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export class Orchestrator {
  private readonly maxIterations: number;
  private readonly maxOutputTokens: number;

  constructor(private readonly opts: OrchestratorOptions) {
    this.maxIterations = opts.maxIterations ?? 5;
    this.maxOutputTokens = opts.maxOutputTokens ?? 4096;
  }

  async run(input: OrchestratorInput): Promise<OrchestratorOutput> {
    const tools = this.opts.registry.getAllTools();
    const claudeTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.jsonSchema as any,
    }));

    const system = buildSystemPrompt({
      todayISO: new Date().toISOString().slice(0, 10),
      toolNames: tools.map((t) => t.name),
      catalogSummary: describeCatalog(),
    });

    const messages: any[] = [];
    for (const turn of input.threadHistory) {
      messages.push({ role: 'user', content: turn.question });
      if (turn.response) messages.push({ role: 'assistant', content: turn.response });
    }
    messages.push({ role: 'user', content: input.question });

    const toolCalls: OrchestratorOutput['toolCalls'] = [];
    let tokensInput = 0;
    let tokensOutput = 0;
    let lastModel = this.opts.model;

    for (let iter = 1; iter <= this.maxIterations; iter++) {
      const resp = await this.opts.claude.messages.create({
        model: this.opts.model,
        max_tokens: this.maxOutputTokens,
        system,
        tools: claudeTools,
        messages,
      });
      tokensInput += resp.usage.input_tokens;
      tokensOutput += resp.usage.output_tokens;
      lastModel = resp.model;

      if (resp.stop_reason !== 'tool_use') {
        const text = extractText(resp.content);
        return {
          response: text,
          model: lastModel,
          toolCalls,
          tokensInput,
          tokensOutput,
          iterations: iter,
        };
      }

      messages.push({ role: 'assistant', content: resp.content });
      const toolResults: any[] = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        const result = await this.opts.registry.execute(block.name, block.input);
        toolCalls.push({
          name: block.name,
          args: block.input,
          ok: result.ok,
          errorMessage: result.ok ? undefined : result.error?.message,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.ok ? JSON.stringify(result.data) : `ERROR: ${result.error?.message}`,
          is_error: !result.ok,
        });
      }
      messages.push({ role: 'user', content: toolResults });
      logger.debug({ iter, toolCalls: toolCalls.length }, 'orchestrator iteration');
    }

    return {
      response:
        "I couldn't converge on an answer within the iteration limit. Please try rephrasing or narrowing the question.",
      model: lastModel,
      toolCalls,
      tokensInput,
      tokensOutput,
      iterations: this.maxIterations,
    };
  }
}

function extractText(content: any[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
}
