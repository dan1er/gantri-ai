import { AsyncLocalStorage } from 'node:async_hooks';
import type Anthropic from '@anthropic-ai/sdk';
import type { ConnectorRegistry } from '../connectors/base/registry.js';
import { buildSystemPrompt } from './prompts.js';
import { describeCatalog } from '../connectors/northbeam/catalog.js';
import type { ReportAttachment } from '../connectors/reports/reports-connector.js';
import { callClaudeWithResilience } from '../llm/resilient-claude.js';
import { logger } from '../logger.js';

export interface ActorContext {
  slackUserId: string;
  slackChannelId?: string;
}

/** Slack thread anchor for the in-flight run — used by tools (e.g. feedback.flag_response)
 *  that need to pin the active thread regardless of where the question came from. */
export interface ThreadContext {
  channelId: string;
  threadTs: string;
}

/**
 * Per-call run context. Replaces the old singleton-mutable
 * `Orchestrator.activeActor` / `activeThread` fields. Both `orchestrator.run`
 * and the reports runner's `processOne` wrap their body in
 * `runWithContext(...)` so concurrent runs each see their own actor/thread.
 *
 * Tool connectors read context via the `getActiveActor()` / `getActiveThread()`
 * helpers below (which read from this AsyncLocalStorage). This eliminates
 * the previous race where the runner's `clearActiveActor()` in a `finally`
 * could wipe an in-flight orchestrator.run's actor.
 */
export interface RunContext {
  actor?: ActorContext;
  thread?: ThreadContext;
}

const runContextStorage = new AsyncLocalStorage<RunContext>();

/** Read the actor context for the in-flight call, if any. */
export function getActiveActor(): ActorContext | undefined {
  return runContextStorage.getStore()?.actor;
}

/** Read the Slack thread context for the in-flight call, if any. */
export function getActiveThread(): ThreadContext | undefined {
  return runContextStorage.getStore()?.thread;
}

/** Run `fn` with the given `RunContext` available via the `getActive*` helpers.
 *  Concurrent calls each get their own ALS frame; nothing leaks across them. */
export function runWithContext<T>(ctx: RunContext, fn: () => Promise<T> | T): Promise<T> {
  return Promise.resolve(runContextStorage.run(ctx, fn));
}

export interface OrchestratorPendingCsvContext {
  kind: 'klaviyo_csv_pending';
  filename: string;
  rowCount: number;
  channels: ('email' | 'sms')[];
  availableLists: Array<{ id: string; name: string }>;
}

export interface OrchestratorInput {
  question: string;
  threadHistory: Array<{ question: string; response: string | null }>;
  /** Identifies the user driving this run; threaded into per-call context for tools that need it (reports.* tools). Optional for back-compat with scripted callers. */
  actor?: ActorContext;
  /** Slack thread context for the in-flight run; consumed by feedback.* tools that
   *  need to capture or link back to the active thread. */
  thread?: ThreadContext;
  /**
   * Fired right before each tool execution starts. Used by the Slack handler
   * to update the in-progress placeholder with the connectors actually being
   * queried. Errors thrown by the callback are caught and logged — they never
   * block the underlying tool call.
   */
  onToolCall?: (toolName: string) => void | Promise<void>;
  /**
   * Fired right after each tool execution finishes (success or failure).
   * Lets the Slack handler show "running" vs "done" status per tool.
   */
  onToolFinish?: (toolName: string, ok: boolean, elapsedMs: number) => void | Promise<void>;
  /** When the user's reply arrives in a thread holding a klaviyo_csv_pending row,
   *  the slack handler builds this and passes it through. The orchestrator appends
   *  a non-cached system block describing the pending state + available lists so
   *  the LLM can interpret the reply as list-selection / creation intent. */
  pendingContext?: OrchestratorPendingCsvContext;
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
  /** Fallback model ids tried (in order) when the primary model exhausts its
   *  retry budget. Anthropic provisions capacity per model family, so a
   *  cross-family fallback (e.g. Sonnet -> Haiku) survives an overloaded
   *  Sonnet pool. Empty / undefined = no failover. */
  fallbackModels?: string[];
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

  /** Replace the registry used for tool execution. Used by index.ts to swap
   *  in a CachingRegistry after all connectors are registered. The orchestrator
   *  reads tools lazily on each run, so late replacement is safe. */
  setRegistry(registry: ConnectorRegistry): void {
    // Cast through unknown because CachingRegistry implements the same surface
    // structurally but isn't a class extension. We rely on the orchestrator's
    // narrow use of `getAllTools()` and `execute()`.
    (this as unknown as { opts: { registry: ConnectorRegistry } }).opts.registry = registry;
  }

  /**
   * Execute a single tool directly with explicit actor/thread context, bypassing
   * the LLM dispatch loop. Used by the Slack `file_shared` handler to route a
   * CSV upload straight to `klaviyo.import_profiles` without making the LLM
   * "decide" — the user's intent is unambiguous when they share a CSV in DM.
   *
   * Wraps the registry execute call in `runWithContext(...)` so connector tools
   * see the correct ActorContext / ThreadContext via `getActiveActor()` /
   * `getActiveThread()`.
   */
  async runToolDirect(input: {
    toolName: string;
    args: unknown;
    actor: ActorContext;
    thread: ThreadContext;
  }): Promise<unknown> {
    return runWithContext({ actor: input.actor, thread: input.thread }, async () => {
      const result = await this.opts.registry.execute(input.toolName, input.args);
      if (result.ok) return result.data;
      // Surface the error in the same shape the underlying tool would have
      // returned for the LLM (the file_shared handler's formatImportReply
      // expects { error: { code, message } } for failure cases).
      return { error: result.error ?? { code: 'TOOL_EXEC_FAILED', message: 'unknown' } };
    });
  }

  async run(input: OrchestratorInput): Promise<OrchestratorOutput> {
    return runWithContext({ actor: input.actor, thread: input.thread }, async () => {
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
      const system: any[] = [
        { type: 'text' as const, text: systemText, cache_control: { type: 'ephemeral' as const } },
      ];
      if (input.pendingContext) {
        // No cache_control — pending state varies every turn; caching it would
        // poison the cache for the next conversation.
        system.push({ type: 'text' as const, text: buildPendingCsvSystemNote(input.pendingContext) });
      }

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
        const { response: resp, modelUsed, attemptsUsed, failedOver } = await callClaudeWithResilience(
          {
            claude: this.opts.claude,
            model: this.opts.model,
            fallbackModels: this.opts.fallbackModels,
          },
          {
            max_tokens: this.maxOutputTokens,
            system,
            tools: claudeTools,
            messages,
          } as Anthropic.MessageCreateParamsNonStreaming,
        );
        if (failedOver || attemptsUsed > 1) {
          logger.info(
            { event: 'anthropic_resilient_call', iter, modelUsed, attemptsUsed, failedOver },
            'orchestrator Anthropic call required retries/failover',
          );
        }
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
          if (input.onToolCall) {
            try {
              await Promise.resolve(input.onToolCall(registryName));
            } catch (err) {
              logger.warn({ err: err instanceof Error ? err.message : String(err), tool: registryName }, 'onToolCall callback threw');
            }
          }
          const toolStartedAt = Date.now();
          const result = await this.opts.registry.execute(registryName, block.input);
          if (input.onToolFinish) {
            try {
              await Promise.resolve(input.onToolFinish(registryName, result.ok, Date.now() - toolStartedAt));
            } catch (err) {
              logger.warn({ err: err instanceof Error ? err.message : String(err), tool: registryName }, 'onToolFinish callback threw');
            }
          }
          toolCalls.push({
            name: registryName,
            args: block.input,
            ok: result.ok,
            errorMessage: result.ok ? undefined : result.error?.message,
          });

          // Intercept any tool result that carries a downloadable attachment
          // (single `attachment` or an `attachments[]`): collect it for upload
          // and send Claude a trimmed confirmation instead of the full blob.
          // This generalizes the original `reports.attach_file`-only path so
          // server-side CSV builders (e.g. products.export_catalog) can return
          // a ReportAttachment the same way — and subsumes attach_file, whose
          // result is exactly `{ attachment }`.
          let toolContent: string;
          const collected = result.ok ? collectAttachments(result.data) : [];
          if (result.ok && collected.length > 0) {
            attachments.push(...collected);
            // Forward any non-attachment payload keys (counts, notes) so the
            // model can describe what it exported, plus a compact summary of
            // each attached file.
            const rest = { ...(result.data as Record<string, unknown>) };
            delete rest.attachment;
            delete rest.attachments;
            toolContent = JSON.stringify({
              ok: true,
              ...rest,
              attached: collected.map((a) => ({
                filename: a.normalizedFilename,
                format: a.format,
                bytes: a.content.length,
              })),
            });
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
    });
  }
}

/** Pull any ReportAttachment(s) out of a tool result payload. Supports both a
 *  single `{ attachment }` (e.g. reports.attach_file) and an `{ attachments: [] }`
 *  list. Returns only well-formed attachments (must have content + format). */
function collectAttachments(data: unknown): ReportAttachment[] {
  if (!data || typeof data !== 'object') return [];
  const out: ReportAttachment[] = [];
  const single = (data as { attachment?: unknown }).attachment;
  const many = (data as { attachments?: unknown }).attachments;
  const candidates: unknown[] = [];
  if (single) candidates.push(single);
  if (Array.isArray(many)) candidates.push(...many);
  for (const c of candidates) {
    if (
      c &&
      typeof c === 'object' &&
      typeof (c as ReportAttachment).content === 'string' &&
      typeof (c as ReportAttachment).format === 'string' &&
      typeof (c as ReportAttachment).normalizedFilename === 'string'
    ) {
      out.push(c as ReportAttachment);
    }
  }
  return out;
}

function extractText(content: any[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
}

function buildPendingCsvSystemNote(ctx: OrchestratorPendingCsvContext): string {
  const listsBlock = ctx.availableLists.length > 0
    ? ctx.availableLists.map((l) => `  - ${l.id} — ${l.name}`).join('\n')
    : '  (list directory unavailable — call klaviyo.list_lists if you need it)';
  return [
    `The user has a pending Klaviyo CSV import in this thread. Filename: ${ctx.filename}. Rows ready to import: ${ctx.rowCount}. Subscription channels chosen at upload: ${ctx.channels.join(', ')}.`,
    '',
    'Interpret the user\'s next message as one of:',
    '  - A list selection (e.g., "Trade Show Leads", "the welcome list", "no list") → call klaviyo.commit_pending_csv_import with that exact list name. Pass "no list" / "none" / "skip" / "sin lista" verbatim — the tool recognizes them and omits list-membership.',
    '  - An instruction that names a list AND asks you to create it if missing (e.g., "lista de prueba, créala si no existe") → call klaviyo.create_list({name}) FIRST, then klaviyo.commit_pending_csv_import({list:name}).',
    '  - A confirmation/decline of a previous question YOU asked (e.g., user replied "yes" after you asked "want me to create it?") → carry out the implied action.',
    '  - An off-topic message → answer normally; do NOT touch the pending import.',
    '',
    'Available Klaviyo lists in this account (id — name):',
    listsBlock,
    '',
    'Hard rules:',
    '  - DO NOT call klaviyo.import_profiles directly. The CSV rows live only in the pending row; only klaviyo.commit_pending_csv_import can access them.',
    '  - DO NOT invent list names. If the user named a list, pass that exact string to commit_pending_csv_import.',
    '  - The cancel verb ("cancel"/"cancelar"/"abort") is handled before you see the message; you will not be invoked for it.',
  ].join('\n');
}
