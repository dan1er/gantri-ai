import type Anthropic from '@anthropic-ai/sdk';
import type { ConnectorRegistry } from '../connectors/base/registry.js';
import type { ReportPlan, BlockSpec } from './plan-types.js';
import { PLAN_SCHEMA_VERSION } from './plan-types.js';
import { executePlan, type ExecutePlanResult } from './plan-executor.js';
import { getByPath } from './step-refs.js';
import { logger } from '../logger.js';

export interface CompilePlanOptions {
  intent: string;
  registry: ConnectorRegistry;
  claude: Anthropic;
  model: string;
  /** When validating, the runAt used to resolve TimeRefs. */
  validationRunAt?: Date;
  timezone?: string;
  /** Max compile attempts (initial + N retries with feedback). Default 3. */
  maxAttempts?: number;
}

export interface CompilePlanResult {
  plan: ReportPlan;
  validation: ExecutePlanResult;
  attempts: number;
}

/**
 * Compile a user's natural-language intent into a validated ReportPlan.
 *
 * Each attempt asks Claude for a JSON plan, runs it through the executor,
 * and then validates that:
 *   1. No tool step errored.
 *   2. Every `${alias.path}` placeholder in text/header blocks resolves to
 *      a real value (the LLM tends to invent field names like `orderCount`
 *      that don't match the actual tool result shape).
 *   3. Every `from:` reference in table/csv blocks points to a real alias.
 *
 * If anything fails, we feed the issue list + the actual alias-map shape
 * back to Claude so it can correct the paths. Up to `maxAttempts` total.
 */
export async function compilePlan(opts: CompilePlanOptions): Promise<CompilePlanResult> {
  const tools = opts.registry.getAllTools();
  const toolCatalog = tools
    .map((t) => `- ${t.name}: ${t.description}\n  args: ${JSON.stringify(t.jsonSchema)}`)
    .join('\n');

  const runAt = opts.validationRunAt ?? new Date();
  const tz = opts.timezone ?? 'America/Los_Angeles';
  const maxAttempts = opts.maxAttempts ?? 3;

  let feedback: string | null = null;
  let lastPlan: ReportPlan | null = null;
  let lastValidation: ExecutePlanResult | null = null;
  let lastIssues: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = buildCompilerPrompt({ intent: opts.intent, toolCatalog, feedback });
    const resp = await opts.claude.messages.create({
      model: opts.model,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = extractText(resp.content);
    const plan = parsePlanJson(text);
    lastPlan = plan;

    const validation = await executePlan({ plan, registry: opts.registry, runAt, timezone: tz });
    lastValidation = validation;

    if (validation.status === 'error') {
      const errMsgs = validation.errors.map((e) => `${e.alias}: ${e.message}`).join('; ');
      if (attempt === maxAttempts) {
        throw new Error(`Plan validation failed after ${attempt} attempts (no steps succeeded): ${errMsgs}`);
      }
      feedback = `On the previous attempt, ${validation.errors.length} step${validation.errors.length === 1 ? '' : 's'} threw an error. Errors: ${errMsgs}.\nFix the args (probably wrong shape against the tool's input schema) and try again.`;
      lastIssues = validation.errors.map((e) => `step ${e.alias}: ${e.message}`);
      logger.warn({ attempt, errMsgs }, 'plan compile attempt failed (step errors)');
      continue;
    }

    const issues = findRenderingIssues(plan, validation.aliasMap);
    if (issues.length === 0) {
      logger.info(
        { intent: opts.intent, stepCount: plan.steps.length, status: validation.status, attempt },
        'plan compiled',
      );
      return { plan, validation, attempts: attempt };
    }

    lastIssues = issues;
    if (attempt === maxAttempts) {
      throw new Error(
        `Plan validation failed after ${attempt} attempts. Rendering issues: ${issues.join(' | ')}`,
      );
    }

    feedback = buildFeedback(plan, validation, issues);
    logger.warn({ attempt, issueCount: issues.length }, 'plan compile attempt has rendering issues, retrying');
  }

  // Unreachable, but keeps TS happy.
  throw new Error(
    `Plan compile exhausted attempts. Last issues: ${lastIssues.join(' | ')}. Last plan steps: ${lastPlan?.steps.length}, validation status: ${lastValidation?.status}`,
  );
}

/**
 * Walk the plan's output blocks and identify references that don't resolve
 * against the actual alias map produced by the validation run. The compiler
 * uses these to give the LLM concrete feedback on what to fix.
 */
function findRenderingIssues(
  plan: ReportPlan,
  aliasMap: Record<string, unknown>,
): string[] {
  const issues: string[] = [];
  for (let i = 0; i < plan.output.blocks.length; i++) {
    const block = plan.output.blocks[i];
    issues.push(...issuesInBlock(block, i, aliasMap));
  }
  // narrativeWrapup template (if present)
  if (plan.narrativeWrapup) {
    for (const path of extractPlaceholders(plan.narrativeWrapup.promptTemplate)) {
      const v = getByPath(aliasMap, path);
      if (v === undefined) {
        issues.push(`narrativeWrapup template references \${${path}} which does not resolve.`);
      }
    }
  }
  return issues;
}

function issuesInBlock(
  block: BlockSpec,
  index: number,
  aliasMap: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  switch (block.type) {
    case 'header':
      // headers are static text; no interpolation, nothing to validate.
      return [];
    case 'text': {
      for (const path of extractPlaceholders(block.text)) {
        const v = getByPath(aliasMap, path);
        if (v === undefined) {
          out.push(`block #${index} (text): placeholder \${${path}} resolves to undefined.`);
        }
      }
      // Detect hand-built ASCII tables (≥3 lines with pipe-delimited cells).
      // Slack does not align them and the columns visibly misregister; the
      // LLM must use a `table` block instead.
      const lines = block.text.split('\n');
      const pipeRows = lines.filter((l) => /\|.*\|/.test(l)).length;
      if (pipeRows >= 3) {
        out.push(
          `block #${index} (text) contains a hand-built ASCII table (${pipeRows} pipe-delimited rows). Slack will not align it. Use a \`table\` block whose \`from\` points at an array-of-objects, OR rewrite as plain prose / multiple short text blocks.`,
        );
      }
      return out;
    }
    case 'table':
    case 'csv_attachment': {
      const v = getByPath(aliasMap, block.from);
      if (!Array.isArray(v)) {
        const aliasNames = Object.keys(aliasMap).join(', ');
        out.push(
          `block #${index} (${block.type}): from "${block.from}" did not resolve to an array. Available aliases: [${aliasNames}].`,
        );
      }
      return out;
    }
  }
}

function extractPlaceholders(template: string): string[] {
  const re = /\$\{([^}]+)\}/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

function buildFeedback(
  _plan: ReportPlan,
  validation: ExecutePlanResult,
  issues: string[],
): string {
  const aliasShapes = Object.entries(validation.aliasMap)
    .map(([alias, value]) => {
      let preview: string;
      try {
        preview = JSON.stringify(value);
      } catch {
        preview = String(value);
      }
      if (preview.length > 800) preview = preview.slice(0, 800) + '… (truncated)';
      return `  ${alias}: ${preview}`;
    })
    .join('\n');

  return [
    'Your previous plan had rendering issues. Fix the paths and re-output the corrected plan.',
    '',
    'Issues found:',
    ...issues.map((i) => `- ${i}`),
    '',
    'Here is the actual shape of each step result (so you know which field names exist):',
    aliasShapes || '  (no successful step results)',
    '',
    'Common pitfalls:',
    '- gantri.order_stats returns: totalOrders, totalRevenueDollars, avgOrderValueDollars, statusBreakdown, typeBreakdown — NOT orderCount or totalRevenue.',
    '- grafana.sql returns: { fields: string[], rows: unknown[][], rowCount: number } — to count rows use ${alias.rowCount}, to read a value use ${alias.rows[0][0]}; tables use from: "alias.rows" only when each row is an OBJECT, otherwise use a text block.',
    '- For wow_compare_pt, results land under ${alias.current.*} and ${alias.previous.*}.',
    '- "from:" must point at an array of OBJECTS. If your data is rows-of-arrays (grafana.sql) or a flat object (gantri.order_stats), prefer text blocks instead.',
    '',
    'Re-output the entire corrected plan as a single JSON object, no prose.',
  ].join('\n');
}

function buildCompilerPrompt(args: { intent: string; toolCatalog: string; feedback: string | null }): string {
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

KNOWN TOOL RESULT SHAPES (use these field names exactly):
- gantri.order_stats: { period, typesFilter, totalOrders, totalRevenueDollars, avgOrderValueDollars, statusBreakdown: [{status, count, revenueDollars}], typeBreakdown: [{type, count, revenueDollars}], truncated }
- gantri.orders_query: { totalMatching, maxPages, page, returnedCount, orders: [{id, type, status, customerName, email, userId, totalDollars, subtotalDollars, shippingDollars, taxDollars, createdAt, shipsAt, completedAt, adminLink, ...}] }
- grafana.sql: { period, fields: string[], rowCount, rows: unknown[][], durationMs }   // rows are arrays-of-cells in column order; for tables build a derived shape via SQL aliases or use a text block
- grafana.run_dashboard: { dashboard, period, panels: [{ panelId, title, fields, rows, error? }] }
- northbeam.overview: top-level metrics object (spend, revenue, ROAS, …) — names depend on the metric ids selected
- northbeam.sales: { rows: [...], summary: {...} }
- northbeam.orders_summary: per-period rollup
- northbeam.orders_list: { orders: [...], allOrders, page, ... }

OUTPUT TIPS:
- **NEVER hand-build ASCII tables inside a text block.** Do not write \`| col | col |\` rows or \`---\` dividers in a text. Slack will not align them and the columns will visibly misregister. If you want tabular presentation, ALWAYS use the \`table\` block type — it auto-aligns columns at render time.
- The \`table\` block requires \`from\` to resolve to an array of OBJECTS, where each object has the fields named in \`columns[].field\`. Two ways to produce that:
  - **Single grafana.sql step** with one row per period using UNION ALL and explicit aliases. Example for "this week vs last week":
    \`\`\`sql
    SELECT 'Current Week' AS period, COUNT(*) AS orders, SUM((amount->>'total')::bigint)/100.0 AS revenue
    FROM "Transactions" t
    WHERE t.type IN ('Order','Wholesale','Trade','Third Party')
      AND t."createdAt" >= timestamp '<this_week_start>' AND t."createdAt" <= timestamp '<this_week_end>'
    UNION ALL
    SELECT 'Previous Week', COUNT(*), SUM((amount->>'total')::bigint)/100.0
    FROM "Transactions" t
    WHERE t.type IN ('Order','Wholesale','Trade','Third Party')
      AND t."createdAt" >= timestamp '<prev_week_start>' AND t."createdAt" <= timestamp '<prev_week_end>'
    \`\`\`
    Pair this with a \`table\` block whose \`from\` is e.g. \`"comparison.rows"\` and \`columns\` are \`[{header:'Period',field:'period'},{header:'Orders',field:'orders',format:'integer'},{header:'Revenue',field:'revenue',format:'currency_dollars'}]\`. Note: grafana.sql returns rows as arrays-of-cells positioned in column order, so to use a table block you must use a JSON-object-shaped step result instead — see next bullet.
  - **CAVEAT:** \`grafana.sql\` returns \`{ fields: [...], rows: [[...]] }\` — \`rows\` is an array of CELL ARRAYS, not objects. \`table\` blocks won't pull \`row.period\` from a cell array. To use a \`table\` block with grafana.sql you have two choices: (a) prefer text blocks for grafana.sql results and reference \`\${alias.rows[0][0]}\` style; or (b) use Porter API tools (\`gantri.order_stats\`, \`gantri.orders_query\`) which return proper objects.
- For comparing two periods of \`gantri.order_stats\` results: run two steps (one per period) and use TWO text blocks (one per period) with bold labels like \`*Current week:* \${current.totalOrders} orders, \${current.totalRevenueDollars} dollars\`. No manual table needed. The deltas can be a third text line written narratively, e.g. \`Net change: \${current.totalOrders} vs \${previous.totalOrders} orders\`. Templates do NOT support arithmetic — do not write \`\${a - b}\` or \`\${a} − \${b} = ...\`.${args.feedback ? `\n\nFEEDBACK FROM PREVIOUS ATTEMPT:\n${args.feedback}` : ''}

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
