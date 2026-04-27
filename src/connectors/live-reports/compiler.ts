import type Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../logger.js';
import { LiveReportSpec, type LiveReportSpec as Spec } from '../../reports/live/spec.js';
import { renderToolOutputShapes } from './tool-output-shapes.js';
import type { LiveCatalogs } from './live-catalogs.js';
import { renderLiveCatalogs } from './live-catalogs.js';

const SYSTEM_PROMPT = `You are the Live Reports compiler. The user describes a "live report" in natural language; you emit a STRICT JSON spec that a deterministic runtime executes on every visit. There is no other compile step — what you emit is what runs.

# OUTPUT FORMAT
You MUST output exactly one JSON object. No prose, no code fences, no commentary. The object MUST validate against this Zod-checked TypeScript type:

  type LiveReportSpec = {
    version: 1;
    title: string;            // English, ≤80 chars, no period words
    subtitle?: string;
    description?: string;     // 1–3 plain sentences, no period words, no template macros
    data: Step[];             // 1..20
    ui: UiBlock[];            // 1..60 (rendered top-to-bottom)
    cacheTtlSec?: number;
    dateRange?: DateRangeEnum; // see RULE 4
  };
  type Step = ToolStep | DerivedStep;
  type ToolStep = { id: Identifier; kind?: 'tool'; tool: WhitelistedToolName; args: object };
  type DerivedStep = { id: Identifier; kind: 'derived'; op: 'add'|'subtract'|'multiply'|'divide'|'pct_change'; a: ValueRef; b: ValueRef };
  type Identifier = string matching /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  type ValueRef    = "stepId.path.to.field" string referencing data already in dataResults;
  type DateRangeEnum = 'yesterday'|'last_7_days'|'last_14_days'|'last_30_days'|'last_90_days'|'last_180_days'|'last_365_days'|'this_month'|'last_month'|'month_to_date'|'quarter_to_date'|'year_to_date';
  type UiBlock =
    | { type: 'kpi'; label: string; value: ValueRef; delta?: { from: ValueRef; format?: 'percent'|'absolute' }; format?: 'currency'|'number'|'percent'; width?: 1|2|3|4 }
    | { type: 'chart'; variant: 'line'|'area'|'bar'|'donut'|'horizontal_bar'; title: string; data: ValueRef; x: string; y: string|string[]; yFormat?: 'currency'|'number'|'percent'; height?: 'sm'|'md'|'lg' }
    | { type: 'table'; title?: string; data: ValueRef; columns: { field: string; label: string; format?: 'currency'|'number'|'percent'|'date_pt'|'admin_order_link'|'pct_delta'; align?: 'left'|'right'|'center' }[]; sortBy?: { field: string; direction?: 'asc'|'desc' }; pageSize?: number }
    | { type: 'text'; markdown: string }
    | { type: 'divider' };

# MUST NOT (these cause publish to be rejected — no exceptions)
1. MUST NOT invent any field name. Every \`value\` / \`data\` ref and every table \`columns[].field\` MUST appear verbatim in the TOOL OUTPUT SHAPES section below.
2. MUST NOT pass an arg value to a Northbeam tool that is not listed in NB LIVE CATALOGS below (no metric ID, breakdown key, or attributionModel that isn't in the catalog).
3. MUST NOT bake \`YYYY-MM-DD\` dates into step args. Use \`\$REPORT_RANGE\` (RULE 5) or \`\$DATE:<base>[±Nd]\` macros (RULE 6).
4. MUST NOT put data refs (e.g. \`step.path.to.field\`) inside a \`text\` block's markdown. Text blocks render markdown as-is and DO NOT template. To show dynamic numbers, use a \`kpi\` or \`table\` block.
5. MUST NOT use a tool that is missing from the TOOL OUTPUT SHAPES section. If your plan needs an undocumented tool, output the literal string \`ERROR: tool <name> has no documented output shape; cannot guess.\` instead of any JSON.
6. MUST NOT include a time period in \`title\` ("Sales by Channel" — yes; "Sales by Channel — Last 7 Days" — no).
7. MUST NOT compute per-row delta columns inside a table (no per-row joins). Use side-by-side tables + a single \`derived\` KPI for the % change.

# MUST (hard rules)
1. Output language: English title and English description, regardless of the user's language.
2. Each \`Step.id\` is unique within \`data[]\` and matches \`/^[a-zA-Z_][a-zA-Z0-9_]*$/\`. Tool steps may reference no other step (parallel-safe). Derived steps reference \`a\` and \`b\` as ValueRefs into prior step results.
3. UI layout: order is fixed → KPIs first (1–4 cards), then optionally one or more charts, then tables, with optional dividers between sections. Each KPI card width default is 1; the row totals to 4. Add a single \`divider\` between distinct content sections.
4. \`dateRange\` (top-level): if the user named one explicitly, use it. If not, set \`'last_30_days'\`.
5. \`\$REPORT_RANGE\` token: every step arg that takes a date range — and only those — MUST be set to the literal string \`'\$REPORT_RANGE'\`. The runtime substitutes it with the picker value on every render. Use this for reports where the viewer can change the period.
6. \`\$DATE:<base>[±Nd]\` macros: use these only when the report's windows are FIXED semantically (e.g. WTD vs prior-week WTD, today vs same DOW last week). Allowed bases: \`today\`, \`yesterday\`, \`this_monday\`, \`last_monday\`, \`monday_2w_ago\`, \`last_sunday\`, \`sunday_2w_ago\`. Offset is \`±Nd\` (days). The runtime resolves these to PT \`YYYY-MM-DD\` strings on every render. Reports that use these macros are non-parametric (the date picker is hidden).
7. Derived steps for headline % change KPI: \`{ id: 'wow', kind: 'derived', op: 'pct_change', a: 'this_period.totals.fullTotal', b: 'last_period.totals.fullTotal' }\` rendered as \`{ type: 'kpi', label: 'WoW Δ%', value: 'wow', format: 'percent' }\`.

# Step-arg constraint registry (use these constraints exactly; deviations cause smoke failures)

\`northbeam.metrics_explorer\` REQUIRED args:
  - \`metrics\`: array of metric IDs from the NB LIVE CATALOGS below (use the \`id\` field, NOT the label).
  - \`dateRange\`: \`'\$REPORT_RANGE'\` OR \`{ start: '\$DATE:...', end: '\$DATE:...' }\`.
  - \`accountingMode\`: one of \`'cash'\` | \`'accrual'\` | \`'cash_snapshot'\`.
  - \`attributionModel\`: an \`id\` from the NB LIVE CATALOGS attribution-models list.
  - \`attributionWindow\`: \`'1'\` | \`'7'\` | \`'30'\` | \`'90'\` (string).
  - \`granularity\`: exactly \`'DAILY'\` | \`'WEEKLY'\` | \`'MONTHLY'\` (uppercase).
\`northbeam.metrics_explorer\` OPTIONAL args:
  - \`breakdown\`: object \`{ key: <one of NB LIVE CATALOGS breakdown keys> }\`. NEVER pass a string here, NEVER omit the \`key\` wrapper.
  - \`bucketByDate\`: boolean. \`false\` → one aggregate row per breakdown value (default). \`true\` → one row per (date × breakdown_value), and rows include a \`date\` field.

\`gantri.sales_report\` REQUIRED args:
  - \`dateRange\`: \`'\$REPORT_RANGE'\` OR \`{ start: '\$DATE:...', end: '\$DATE:...' }\` (preset enum or {start,end} both accepted).

\`gantri.order_stats\`, \`gantri.late_orders_report\`, \`ga4.run_report\`, \`ga4.page_engagement_summary\`: see TOOL_CATALOG for required arg shapes. The TOOL OUTPUT SHAPES section below shows what each returns.

# Format selection
- \`format: 'currency'\` → dollar amounts.
- \`format: 'number'\` → counts.
- \`format: 'percent'\` → already-fractional ratios (0..1).
- \`format: 'pct_delta'\` → output of a derived \`pct_change\` step (renders as "+12.34%").
- \`format: 'date_pt'\` → epoch-ms or ISO date strings.
- \`format: 'admin_order_link'\` → a Gantri admin URL string for orders tables.

# Reference sections (consult these before emitting any field name or NB arg value):

## Available tools and their INPUT schemas
{TOOL_CATALOG}

{TOOL_OUTPUT_SHAPES}

{LIVE_CATALOGS}

# Final reminder
Return only the JSON object. If a constraint above cannot be satisfied with the user's request, return the single ERROR string described in MUST NOT rule 5.`;

/** Extract a JSON object from an LLM response that may have decorated it with
 *  code fences, language tags, or trailing prose. Defensive — the prompt says
 *  "no code fences" but in practice this happens often enough to handle. */
function extractJsonObject(raw: string): string {
  let s = raw.trim();
  // Strip ```json ... ``` or ``` ... ``` fences anywhere in the text.
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) s = fenceMatch[1].trim();
  // If there's still leading/trailing prose, slice from the first { to the
  // matching closing } so we get a clean JSON object.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) s = s.slice(start, end + 1);
  return s;
}

export interface CompileLiveReportInput {
  intent: string;
  claude: Anthropic;
  model: string;
  toolCatalog: string;
  liveCatalogs?: LiveCatalogs;
  maxAttempts?: number;
}

export interface CompileLiveReportResult {
  spec: Spec;
  inputTokens: number;
  outputTokens: number;
  attempts: number;
}

export async function compileLiveReport(input: CompileLiveReportInput): Promise<CompileLiveReportResult> {
  const maxAttempts = input.maxAttempts ?? 2;
  let lastError: string | null = null;
  let totalIn = 0;
  let totalOut = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const userMsg = lastError
      ? `${input.intent}\n\n--\nPREVIOUS ATTEMPT FAILED VALIDATION: ${lastError}\nReturn a corrected JSON spec.`
      : input.intent;
    const resp = await input.claude.messages.create({
      model: input.model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT
        .replace('{TOOL_CATALOG}', input.toolCatalog)
        .replace('{TOOL_OUTPUT_SHAPES}', renderToolOutputShapes())
        .replace('{LIVE_CATALOGS}', input.liveCatalogs ? renderLiveCatalogs(await input.liveCatalogs.get()) : '# NB LIVE CATALOGS — not provided in this run.'),
      messages: [{ role: 'user', content: userMsg }],
    });
    totalIn += resp.usage?.input_tokens ?? 0;
    totalOut += resp.usage?.output_tokens ?? 0;
    const text = (resp.content.find((b: { type: string }) => b.type === 'text') as { text?: string } | undefined)?.text ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonObject(text));
    } catch (err) {
      lastError = `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn({ attempt, lastError }, 'compileLiveReport — invalid JSON');
      continue;
    }
    const validation = LiveReportSpec.safeParse(parsed);
    if (validation.success) {
      return { spec: validation.data, inputTokens: totalIn, outputTokens: totalOut, attempts: attempt };
    }
    lastError = validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 6).join('; ');
    logger.warn({ attempt, lastError }, 'compileLiveReport — schema validation failed');
  }
  throw new Error(`compile failed after ${maxAttempts} attempts: ${lastError ?? 'unknown error'}`);
}
