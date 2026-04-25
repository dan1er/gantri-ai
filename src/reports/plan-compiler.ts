import type Anthropic from '@anthropic-ai/sdk';
import type { ConnectorRegistry } from '../connectors/base/registry.js';
import type { ReportPlan } from './plan-types.js';
import { PLAN_SCHEMA_VERSION } from './plan-types.js';
import { executePlan, type ExecutePlanResult } from './plan-executor.js';
import { logger } from '../logger.js';

export interface CompilePlanOptions {
  intent: string;
  registry: ConnectorRegistry;
  claude: Anthropic;
  model: string;
  /** When validating, the runAt used to resolve TimeRefs. */
  validationRunAt?: Date;
  timezone?: string;
  maxIterations?: number;
}

export interface CompilePlanResult {
  plan: ReportPlan;
  validation: ExecutePlanResult;
}

/**
 * Compile a user's natural-language intent into a validated ReportPlan.
 *
 * Uses a single non-tool call to Claude to generate the JSON, then runs the
 * plan once via the executor as the validation step. If validation produces
 * an "error" status (zero successful steps), throws — the caller surfaces
 * that to the user. "partial" is acceptable on first compile.
 *
 * The compiler does not give Claude tool access on purpose — we want one
 * deterministic JSON output, not exploratory iteration. The validation step
 * exercises the tools end-to-end via the executor.
 */
export async function compilePlan(opts: CompilePlanOptions): Promise<CompilePlanResult> {
  const tools = opts.registry.getAllTools();
  const toolCatalog = tools
    .map(
      (t) =>
        `- ${t.name}: ${t.description}\n  args: ${JSON.stringify(t.jsonSchema)}`,
    )
    .join('\n');

  const compilerPrompt = buildCompilerPrompt({
    intent: opts.intent,
    toolCatalog,
  });

  const resp = await opts.claude.messages.create({
    model: opts.model,
    max_tokens: 4000,
    messages: [{ role: 'user', content: compilerPrompt }],
  });

  const text = extractText(resp.content);
  const plan = parsePlanJson(text);

  // Validate by executing once.
  const runAt = opts.validationRunAt ?? new Date();
  const tz = opts.timezone ?? 'America/Los_Angeles';
  const validation = await executePlan({ plan, registry: opts.registry, runAt, timezone: tz });

  if (validation.status === 'error') {
    const errMsgs = validation.errors.map((e) => `${e.alias}: ${e.message}`).join('; ');
    throw new Error(`Plan validation failed (no steps succeeded): ${errMsgs}`);
  }

  logger.info(
    { intent: opts.intent, stepCount: plan.steps.length, status: validation.status },
    'plan compiled',
  );

  return { plan, validation };
}

function buildCompilerPrompt(args: { intent: string; toolCatalog: string }): string {
  return `You are compiling a deterministic execution plan for a recurring scheduled report inside Gantri's internal Slack bot.

USER REQUEST (this is what the report should produce on every fire):
${args.intent}

AVAILABLE TOOLS:
${args.toolCatalog}

Output a single JSON object — and nothing else, no prose, no markdown fences — matching this TypeScript type:

\`\`\`ts
type ReportPlan = {
  schemaVersion: 1;
  steps: PlanStep[];                                    // max 8
  output: { blocks: BlockSpec[] };
  narrativeWrapup?: { promptTemplate: string; maxTokens?: number };
};

type PlanStep = {
  alias: string;                                        // unique within plan
  tool: string;                                         // exact name from the catalog above
  args: Record<string, unknown>;                        // may include TimeRef / StepRef tokens
  dependsOn?: string[];
};

type TimeRef =
  | { $time: 'today_pt' }
  | { $time: 'yesterday_pt' }
  | { $time: 'this_week_pt' }
  | { $time: 'last_week_pt' }
  | { $time: 'this_month_pt' }
  | { $time: 'last_month_pt' }
  | { $time: 'last_n_days_pt'; n: number }
  | { $time: 'wow_compare_pt' };                        // expands to current+previous; results land under \${alias.current.*} and \${alias.previous.*}

type StepRef = { $ref: 'aliasName.path.into.result[0].field' };

type BlockSpec =
  | { type: 'header'; text: string }
  | { type: 'text'; text: string }                      // \${aliasName.path} placeholders
  | { type: 'table'; from: string; columns: ColumnSpec[]; maxRows?: number }
  | { type: 'csv_attachment'; from: string; filename: string };

type ColumnSpec = {
  header: string;
  field: string;                                        // dot-path into a row
  format?: 'currency_dollars'|'integer'|'datetime_pt'|'date_pt'|'admin_order_link'|'percent';
};
\`\`\`

CONSTRAINTS:
- schemaVersion must be 1.
- Maximum 8 steps total.
- All tool names must exactly match the catalog. Validate args against each tool's input schema.
- Use TimeRef tokens for any date range; do NOT hard-code dates in SQL or args.
- Prefer grafana.sql for aggregations across the Porter schema (Transactions, StockAssociations, Stocks, Users, Products). Use Porter API tools only when you need data the read-replica doesn't expose.
- Money in Porter SQL is JSON cents: divide \`(amount->>'total')::bigint\` by 100 for dollars.
- Default to \`t.type IN ('Order','Wholesale','Trade','Third Party')\` for "sold" questions.
- output.blocks should be tight and Slack-friendly; ASCII tables render in Slack code blocks.
- Skip narrativeWrapup unless the user explicitly asked for analysis or commentary.

Output the JSON now.`;
}

function extractText(content: any[]): string {
  for (const block of content) {
    if (block.type === 'text') return block.text;
  }
  throw new Error('compiler returned no text block');
}

function parsePlanJson(text: string): ReportPlan {
  // The model might wrap the JSON in fences; strip them.
  const trimmed = text
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`compiler did not return valid JSON: ${trimmed.slice(0, 300)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('compiler output is not an object');
  }
  const plan = parsed as ReportPlan;
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new Error(`unexpected schemaVersion: ${(plan as any).schemaVersion}`);
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > 8) {
    throw new Error(`plan must have 1..8 steps, got ${plan.steps?.length}`);
  }
  if (!plan.output || !Array.isArray(plan.output.blocks)) {
    throw new Error('plan must have output.blocks');
  }
  // Alias uniqueness.
  const aliases = new Set<string>();
  for (const s of plan.steps) {
    if (!s.alias || typeof s.alias !== 'string') throw new Error('step missing alias');
    if (aliases.has(s.alias)) throw new Error(`duplicate alias: ${s.alias}`);
    aliases.add(s.alias);
    if (!s.tool || typeof s.tool !== 'string') throw new Error(`step ${s.alias} missing tool`);
  }
  return plan;
}
