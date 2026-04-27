import type Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../logger.js';
import { LiveReportSpec, type LiveReportSpec as Spec } from '../../reports/live/spec.js';

const SYSTEM_PROMPT = `You are the Live Reports compiler. The user asks for a "live report" in natural language; you emit a STRICT JSON spec that the deterministic runtime will execute on every visit.

Output: a single JSON object matching this TypeScript type (validated by Zod):

  type LiveReportSpec = {
    version: 1;
    title: string;          // ALWAYS in English, ≤80 chars
    subtitle?: string;
    description?: string;   // 1-3 sentences explaining what the report shows
    data: DataStep[];       // 1..20 entries; each runs a whitelisted tool with args
    ui: UiBlock[];          // 1..60 entries; rendered top-to-bottom
    cacheTtlSec?: number;   // default 300
  }
  type DataStep = { id: string; tool: WhitelistedTool; args: object };
  type UiBlock =
    | { type: 'kpi'; label: string; value: string; delta?: { from: string; format?: 'percent' | 'absolute' }; format?: 'currency' | 'number' | 'percent'; width?: 1 | 2 | 3 | 4 }
    | { type: 'chart'; variant: 'line' | 'area' | 'bar' | 'donut' | 'horizontal_bar'; title: string; data: string; x: string; y: string | string[]; yFormat?: 'currency' | 'number' | 'percent'; height?: 'sm' | 'md' | 'lg' }
    | { type: 'table'; title?: string; data: string; columns: { field: string; label: string; format?: 'currency' | 'number' | 'percent' | 'date_pt' | 'admin_order_link' | 'pct_delta'; align?: 'left' | 'right' | 'center' }[]; sortBy?: { field: string; direction?: 'asc' | 'desc' }; pageSize?: number }
    | { type: 'text'; markdown: string }
    | { type: 'divider' };

Rules:
- Output ONLY the JSON object. No prose, no code fences.
- Title MUST be in English, even if the user wrote in Spanish.
- 'data' steps: one DataStep per tool call. The 'id' is referenced by ui blocks via "id.path.to.field" (e.g. "rev.rows[0].rev"). Use parallel-safe ids (no dependency between steps).
- Build a logical layout: 1 row of KPI cards (4 max), then a chart, then a table. Add a divider between sections if useful.
- Prefer specialized tools when they exist: gantri.late_orders_report over composing orders_query, ga4.page_engagement_summary over manual run_report+filter.

Available tools and their args:
{TOOL_CATALOG}

Return the JSON object now.`;

export interface CompileLiveReportInput {
  intent: string;
  claude: Anthropic;
  model: string;
  toolCatalog: string;
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
      system: SYSTEM_PROMPT.replace('{TOOL_CATALOG}', input.toolCatalog),
      messages: [{ role: 'user', content: userMsg }],
    });
    totalIn += resp.usage?.input_tokens ?? 0;
    totalOut += resp.usage?.output_tokens ?? 0;
    const text = (resp.content.find((b: { type: string }) => b.type === 'text') as { text?: string } | undefined)?.text ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.trim());
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
