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
      // Headers are static text. Validate any ${alias.path} placeholders the
      // user may have embedded in the header text since the renderer now
      // interpolates them.
      for (const path of extractPlaceholders(block.text)) {
        const v = getByPath(aliasMap, path);
        if (v === undefined) {
          out.push(`block #${index} (header): placeholder \${${path}} resolves to undefined.`);
        }
      }
      return out;
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
      out.push(
        `block #${index} is a \`table\` block in chat output. Chat output.blocks MUST contain ONLY \`header\` and \`text\` block types. Per-row tables go in the CANVAS via the \`reports.create_canvas\` step's \`tables\` arg + \`<<table:NAME>>\` markers in the canvas markdown — never inline in chat.`,
      );
      return out;
    case 'csv_attachment':
      out.push(
        `block #${index} is a \`csv_attachment\` block in chat output. CSV exports go through the \`reports.attach_file\` tool as a separate plan step (with format=\\'csv\\') — not as an output block. Chat output.blocks MUST contain ONLY \`header\` and \`text\` block types.`,
      );
      return out;
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
- **TimeRef tokens go at the \`dateRange\` LEVEL, not inside \`startDate\`/\`endDate\`.** For tools whose args take \`{ dateRange: { startDate: string, endDate: string } }\` (gantri.sales_report, gantri.order_stats, gantri.orders_query, northbeam.list_orders, northbeam.metrics_explorer, etc.), pass the TimeRef as the WHOLE \`dateRange\` value:
    Correct:   \`"args": { "dateRange": {"$time": "yesterday_pt"} }\`
    Correct:   \`"args": { "dateRange": {"$time": "last_n_days_pt", "n": 7} }\`
    WRONG:     \`"args": { "dateRange": { "startDate": {"$time": "yesterday_pt"}, "endDate": {"$time": "today_pt"} } }\`  ← will fail validation, NEVER do this.
  At execution time the runner resolves \`{$time: ...}\` into \`{startDate, endDate, fromMs, toMs}\` and passes that whole object as the tool's \`dateRange\`. The extra \`fromMs\`/\`toMs\` keys are accepted (tools ignore them). For SQL placeholders inside grafana.sql, use the standard \`$__timeFrom()\` / \`$__timeTo()\` macros (which are filled from the same TimeRef-resolved range), not literal date strings.
- Prefer grafana.sql for aggregations across the Porter schema (Transactions, StockAssociations, Stocks, Users, Products). Use Porter API tools only when you need data the read-replica doesn't expose.
- Money in Porter SQL is JSON cents: divide \`(amount->>'total')::bigint\` by 100 for dollars.
- Default to \`t.type IN ('Order','Wholesale','Trade','Third Party')\` for "sold" questions.
- **\`output.blocks\` MAY ONLY contain \`header\` and \`text\` block types.** \`table\` and \`csv_attachment\` block types in chat output are HARD-REJECTED by the compiler (validation will fail and you will be asked to retry). Per-row tables go in the canvas via the \`reports.create_canvas\` step's \`tables\` arg + \`<<table:NAME>>\` markers in the canvas markdown. CSV exports are a separate \`reports.attach_file\` step (with \`format: 'csv'\`).
- Skip narrativeWrapup unless the user explicitly asked for analysis or commentary.

KNOWN TOOL RESULT SHAPES (use these field names exactly):
- gantri.sales_report: { period: {startDate, endDate}, source: 'grafana_sales_panel', rows: [{type, orders, items, giftCards, subtotal, shipping, tax, discount, credit, salesExclTax, fullTotal}], totals: {orders, items, giftCards, subtotal, shipping, tax, discount, credit, salesExclTax, fullTotal, ...snake_case + *Dollars aliases}, summary: <same as totals> }
- gantri.order_stats: { period, typesFilter, totalOrders, totalRevenueDollars, avgOrderValueDollars, statusBreakdown: [{status, count, revenueDollars}], typeBreakdown: [{type, count, revenueDollars}], truncated, source: 'porter' }
- gantri.orders_query: { totalMatching, maxPages, page, returnedCount, orders: [{id, type, status, customerName, email, userId, totalDollars, subtotalDollars, shippingDollars, taxDollars, createdAt, shipsAt, completedAt, adminLink, ...}] }
- grafana.sql: { period, fields: string[], rowCount, rows: unknown[][], durationMs }   // rows are arrays-of-cells in column order; for tables build a derived shape via SQL aliases or use a text block
- grafana.run_dashboard: { dashboard, period, panels: [{ panelId, title, fields, rows, error? }] }
- northbeam.metrics_explorer: { attributionModel, accountingMode, attributionWindow, metrics, rowCount, headers, rows: [{...metric/breakdown columns}] }
- northbeam.list_orders: { period, source: 'northbeam_v2_orders', count, totalReturned, cancelledOrDeletedExcluded, orders: [{order_id, customer_id, customer_name, customer_email, customer_phone_number, time_of_purchase, currency, purchase_total, tax, shipping_cost, discount_amount, order_tags, is_cancelled, is_deleted, ...}] }
- northbeam.list_metrics / list_breakdowns / list_attribution_models: discovery catalogs; rarely useful inside a scheduled plan.

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
- For comparing two periods of \`gantri.order_stats\` results: run two steps (one per period) and use TWO text blocks (one per period) with bold labels like \`*Current week:* \${current.totalOrders} orders, \${current.totalRevenueDollars} dollars\`. No manual table needed. The deltas can be a third text line written narratively, e.g. \`Net change: \${current.totalOrders} vs \${previous.totalOrders} orders\`. Templates do NOT support arithmetic — do not write \`\${a - b}\` or \`\${a} − \${b} = ...\`.

TABLES POLICY (READ CAREFULLY):
- **Per-row tables (>3 rows of structured data) ALWAYS belong in the canvas, never inline in chat \`output.blocks\`.** The canvas is where users go for the data; the chat reply is a short summary + a clickable canvas link.
- To put a per-row table in the canvas, schedule a \`reports.create_canvas\` step and pass a \`tables\` arg with one entry per table:
  \`\`\`json
  {
    "tool": "reports.create_canvas",
    "args": {
      "title": "Late wholesale orders — 2026-04-24",
      "markdown": "# Late wholesale orders\\n\\n**Total late:** \${lateOrders.totalLate}\\n\\n## Full list\\n\\n<<table:fullOrdersTable>>",
      "tables": [
        {
          "placeholder": "fullOrdersTable",
          "rows": { "$ref": "lateOrders.orders" },
          "columns": [
            { "header": "Order", "field": "id", "format": "admin_order_link" },
            { "header": "Customer", "field": "customerName" },
            { "header": "Days Late", "field": "daysLate", "format": "integer" },
            { "header": "Cause", "field": "causeSummary" }
          ]
        }
      ]
    }
  }
  \`\`\`
  The connector substitutes every \`<<table:fullOrdersTable>>\` marker with a real GFM markdown pipe-table that Slack Canvas renders natively.
- **The chat \`output.blocks\` for a tabular report should be a SHORT (2–4 line) text block** with the headline numbers + a link to the canvas. Example:
  \`\`\`json
  {
    "type": "text",
    "text": "*\${lateOrders.totalLate} late wholesale orders* — \${lateOrders.buckets.byDaysLate.15+} are 15+ days late.\\n\\n📋 Full report: <\${canvas.url}|Open canvas>"
  }
  \`\`\`
  No \`table\` block in the chat for the per-row data. No duplicated rows inline. Headline summary + canvas link only.
- The chat \`table\` block type still exists, but reserve it for tiny pivot tables (≤5 rows, ≤5 columns) that genuinely belong inline — e.g. a 3-row "this week vs last week vs delta" mini-summary. Anything bigger goes in the canvas via the \`tables\` arg.
- The \`markdown\` arg of \`reports.create_canvas\` is still a static string with \`\${alias.path}\` scalar interpolation only — no JS-style iteration. Per-row data is exclusively rendered via \`tables\` + \`<<table:NAME>>\` markers; do NOT try to hand-build pipe tables out of \`\${alias.rows[0]}\`-style scalar refs.${args.feedback ? `\n\nFEEDBACK FROM PREVIOUS ATTEMPT:\n${args.feedback}` : ''}

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
