import type Anthropic from '@anthropic-ai/sdk';
import type { ConnectorRegistry } from '../connectors/base/registry.js';
import { buildSystemPrompt } from './prompts.js';
import { describeCatalog } from '../connectors/northbeam/catalog.js';
import type { ReportAttachment } from '../connectors/reports/reports-connector.js';
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
  /** Files Claude requested to attach via the `reports.attach_file` tool. */
  attachments: ReportAttachment[];
}

export interface OrchestratorOptions {
  registry: ConnectorRegistry;
  claude: Anthropic;
  model: string;
  maxIterations?: number;
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
    // Anthropic requires tool names to match ^[a-zA-Z0-9_-]+$. Our internal
    // convention uses "." as a namespace separator (e.g. "northbeam.overview").
    // Map "." → "_" on the way out, and remember the inverse so we can resolve
    // the registry entry when Claude calls the tool back.
    const toSafeName = (n: string) => n.replace(/\./g, '_');
    const nameMap = new Map(tools.map((t) => [toSafeName(t.name), t.name]));
    const claudeTools: any[] = tools.map((t) => ({
      name: toSafeName(t.name),
      description: t.description,
      input_schema: t.jsonSchema as any,
    }));
    // Cache the system prompt + tools as one ephemeral block (5-minute TTL).
    // Each tool-use iteration re-sends the full system + tools — without
    // caching this blows past the 30k ITPM tier limit on multi-step questions.
    // Marking the last tool with cache_control caches everything up to and
    // including the tools array.
    if (claudeTools.length > 0) {
      claudeTools[claudeTools.length - 1].cache_control = { type: 'ephemeral' };
    }

    const systemText = buildSystemPrompt({
      todayISO: new Date().toISOString().slice(0, 10),
      toolNames: tools.map((t) => t.name),
      catalogSummary: describeCatalog(),
    });
    const system = [
      { type: 'text' as const, text: systemText, cache_control: { type: 'ephemeral' as const } },
    ];

    const messages: any[] = [];
    for (const turn of input.threadHistory) {
      messages.push({ role: 'user', content: turn.question });
      if (turn.response) messages.push({ role: 'assistant', content: turn.response });
    }
    messages.push({ role: 'user', content: input.question });

    const toolCalls: OrchestratorOutput['toolCalls'] = [];
    const attachments: ReportAttachment[] = [];
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
          attachments,
        };
      }

      messages.push({ role: 'assistant', content: resp.content });
      const toolResults: any[] = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        const registryName = nameMap.get(block.name) ?? block.name;
        const result = await this.opts.registry.execute(registryName, block.input);
        toolCalls.push({
          name: registryName,
          args: block.input,
          ok: result.ok,
          errorMessage: result.ok ? undefined : result.error?.message,
        });

        // Intercept reports.attach_file results: collect the attachment and
        // send Claude a trimmed confirmation instead of the full content (no
        // point feeding the blob back in).
        let toolContent: string;
        if (result.ok && registryName === 'reports.attach_file') {
          const data = result.data as { attachment?: ReportAttachment };
          if (data?.attachment) {
            attachments.push(data.attachment);
            toolContent = JSON.stringify({
              ok: true,
              attached: {
                filename: data.attachment.normalizedFilename,
                format: data.attachment.format,
                bytes: data.attachment.content.length,
              },
            });
          } else {
            toolContent = JSON.stringify(result.data);
          }
        } else if (result.ok) {
          toolContent = JSON.stringify(result.data);
        } else {
          toolContent = `ERROR: ${result.error?.message}`;
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: toolContent,
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
      attachments,
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
