import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { logger } from '../../logger.js';
import { callClaudeWithResilience } from '../../llm/resilient-claude.js';
import type { ParsedCsvRow, RawCsvParseResult } from './csv-parser.js';

/**
 * LLM-driven CSV header validation + mapping. Replaces the brittle hardcoded
 * alias table that only knew English. Given raw headers + a few sample rows,
 * the LLM:
 *   - decides whether the CSV is feasible to import to Klaviyo (i.e., has at
 *     least one column that looks like an email),
 *   - maps each canonical Klaviyo column (email, first_name, last_name, phone,
 *     consent_source, consented_at) to whichever raw header carries it (or
 *     null if absent), in any language.
 *
 * If the LLM says infeasible, we throw an Error whose message is what the
 * user will see in Slack. The caller should catch and post it.
 *
 * Cost: one Haiku call per CSV upload, ~200-500 input tokens, ~100 output
 * tokens. <$0.001 per upload. Negligible.
 */

const HEADER_MAPPER_MODEL = 'claude-haiku-4-5';
/** Cross-pool fallback used when Haiku capacity is saturated. Sonnet costs
 *  more per token but the header-mapper prompt is <500 tokens so the cost
 *  delta is negligible — and a successful import beats a failed one. */
const HEADER_MAPPER_FALLBACK_MODELS = ['claude-sonnet-4-6'];

const MappingResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    mapping: z.object({
      email: z.string().min(1),
      first_name: z.string().nullable().optional(),
      last_name: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      consent_source: z.string().nullable().optional(),
      consented_at: z.string().nullable().optional(),
    }),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.string().min(1),
  }),
]);
type MappingResult = z.infer<typeof MappingResultSchema>;

export interface HeaderMapperDeps {
  /** Anthropic SDK client. We only call `messages.create`. */
  claude: Pick<Anthropic, 'messages'>;
}

/** Validate + map a raw-parsed CSV against Klaviyo's canonical schema. Returns
 *  canonical rows ready for `klaviyo.import_profiles`. Throws Error (with a
 *  user-facing message) if the LLM judges the CSV infeasible. */
export async function validateAndMapForKlaviyo(
  parsed: RawCsvParseResult,
  deps: HeaderMapperDeps,
): Promise<{ rows: ParsedCsvRow[]; warnings: string[] }> {
  if (parsed.headers.length === 0 || parsed.rows.length === 0) {
    throw new Error('CSV is empty or has no header row.');
  }

  const result = await callMapper(parsed, deps.claude);

  if (!result.ok) {
    logger.info(
      { headers: parsed.headers, reason: result.reason },
      'klaviyo_csv_header_mapper_infeasible',
    );
    throw new Error(result.reason);
  }

  const m = result.mapping;
  const canonicalKeys: Array<keyof ParsedCsvRow> = [
    'email', 'first_name', 'last_name', 'phone', 'consent_source', 'consented_at',
  ];
  const mappingForLog: Record<string, string | null> = {};
  for (const k of canonicalKeys) {
    if (k === 'rowIndex') continue;
    const raw = (m as Record<string, string | null | undefined>)[k];
    mappingForLog[k] = raw ?? null;
  }
  logger.info(
    { headers: parsed.headers, mapping: mappingForLog },
    'klaviyo_csv_header_mapper_resolved',
  );

  // Build canonical rows by pulling from each raw header named in the mapping.
  // Skip rows whose mapped email is empty — they can't be imported and would
  // fail Klaviyo's validation anyway.
  const warnings: string[] = [];
  const rows: ParsedCsvRow[] = [];
  parsed.rows.forEach((raw, i) => {
    const email = readMapped(raw, m.email);
    if (!email) return;
    const row: ParsedCsvRow = { rowIndex: i + 1, email };
    if (m.first_name) {
      const v = readMapped(raw, m.first_name);
      if (v) row.first_name = v;
    }
    if (m.last_name) {
      const v = readMapped(raw, m.last_name);
      if (v) row.last_name = v;
    }
    if (m.phone) {
      const v = readMapped(raw, m.phone);
      if (v) row.phone = v;
    }
    if (m.consent_source) {
      const v = readMapped(raw, m.consent_source);
      if (v) row.consent_source = v;
    }
    if (m.consented_at) {
      const v = readMapped(raw, m.consented_at);
      if (v) row.consented_at = v;
    }
    rows.push(row);
  });

  if (rows.length === 0) {
    throw new Error(
      "Could not find any importable rows: the column the bot picked for email is empty in every row. Check that the email column has values.",
    );
  }

  const droppedCount = parsed.rows.length - rows.length;
  if (droppedCount > 0) {
    warnings.push(
      `${droppedCount} row${droppedCount === 1 ? '' : 's'} skipped (empty email).`,
    );
  }

  return { rows, warnings };
}

function readMapped(raw: Record<string, string>, header: string): string | undefined {
  // Headers in `parsed` are lowercased + trimmed; the LLM sees those. Defensive
  // case-fold here in case the LLM echoes a slightly different casing.
  const lookup = header.trim().toLowerCase();
  const v = raw[lookup];
  return v && v.length > 0 ? v : undefined;
}

async function callMapper(
  parsed: RawCsvParseResult,
  claude: Pick<Anthropic, 'messages'>,
): Promise<MappingResult> {
  const sample = parsed.rows.slice(0, 3);
  const prompt = [
    'You are validating a CSV upload for Klaviyo profile import. Klaviyo accepts these canonical columns:',
    '- email (REQUIRED)',
    '- first_name, last_name, phone, consent_source, consented_at (optional)',
    '',
    'Given the CSV\'s actual headers (which may be in any language) and a few sample rows, decide:',
    '1. Which raw header maps to each canonical column? Match by meaning OR by sample-value shape (e.g., a header whose values look like email addresses maps to "email" even if the header is "Mail" or "Correo del usuario"). Use null for canonical columns that have no matching header.',
    '2. Is the import feasible? It\'s infeasible ONLY if no header maps to email.',
    '',
    'Output ONLY valid JSON, no commentary, no markdown fence, in this exact shape:',
    '',
    'If feasible:',
    '{"ok": true, "mapping": {"email": "<raw header>", "first_name": "<raw header> | null", "last_name": "<raw header> | null", "phone": "<raw header> | null", "consent_source": "<raw header> | null", "consented_at": "<raw header> | null"}}',
    '',
    'If infeasible:',
    '{"ok": false, "reason": "<short user-facing message explaining why, in the SAME language as the CSV headers (default English)>"}',
    '',
    'Inputs:',
    `Headers: ${JSON.stringify(parsed.headers)}`,
    'Sample rows:',
    sample.map((r) => `- ${JSON.stringify(r)}`).join('\n'),
  ].join('\n');

  const { response, modelUsed, attemptsUsed, failedOver } = await callClaudeWithResilience(
    {
      claude,
      model: HEADER_MAPPER_MODEL,
      fallbackModels: HEADER_MAPPER_FALLBACK_MODELS,
    },
    {
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    },
  );
  if (failedOver || attemptsUsed > 1) {
    logger.info(
      { event: 'anthropic_resilient_call', site: 'klaviyo_header_mapper', modelUsed, attemptsUsed, failedOver },
      'header mapper Anthropic call required retries/failover',
    );
  }

  const text = extractText(response.content);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(extractJsonObject(text));
  } catch (err) {
    logger.error(
      { rawText: text, err: err instanceof Error ? err.message : String(err) },
      'klaviyo_csv_header_mapper_unparseable_response',
    );
    throw new Error(
      "Couldn't validate CSV format (unexpected response from header mapper). Try re-uploading.",
    );
  }

  const safe = MappingResultSchema.safeParse(parsedJson);
  if (!safe.success) {
    logger.error(
      { rawText: text, zodIssues: safe.error.issues },
      'klaviyo_csv_header_mapper_schema_violation',
    );
    throw new Error(
      "Couldn't validate CSV format (header mapper returned an invalid shape). Try re-uploading.",
    );
  }
  return safe.data;
}

function extractText(content: Array<{ type: string; text?: string }> | undefined): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/** Pull the first {...} substring from `text`. Defensive — sometimes the model
 *  prepends/appends a sentence even when asked not to. If no JSON object is
 *  found, returns the original text and lets JSON.parse throw. */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  if (start < 0) return text;
  // Find the matching closing brace by walking with a depth counter. Handles
  // nested objects without a regex ride.
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text;
}
