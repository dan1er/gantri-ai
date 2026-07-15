import type Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { callClaudeWithResilience } from '../../../llm/resilient-claude.js';
import { logger } from '../../../logger.js';
import { DOMAIN_ENUM, type Facts } from './decide.js';
import type { DeliveryTier } from '../board-config.js';

/**
 * ONE small Haiku call extracts the fixed fact set from a single ticket. The LLM
 * ONLY reports facts; `decideTier` (pure) computes the tier. Temperature 0,
 * forced JSON + zod, resilient with a Sonnet fallback. The system prompt is the
 * public rubric file (`src/prompts/delivery-tier-standard.md`), sent with
 * `cache_control: ephemeral` so repeated calls in a poll window reuse the cached
 * system block. A malformed response is retried once, then throws
 * `TierExtractError` — the poller catches it and skips the task for this tick.
 */

const EXTRACT_MODEL = 'claude-haiku-4-5-20251001';
const EXTRACT_FALLBACK_MODELS = ['claude-sonnet-4-6'];
const EXTRACT_SITE = 'asana_delivery_tier_extract';
const MAX_OUTPUT_TOKENS = 1024;

const FactValueSchema = z.object({
  value: z.enum(['yes', 'no', 'unclear']),
  // Evidence is tolerant: the model occasionally omits it on a `no`/`unclear`.
  evidence: z.string().default(''),
});

const FactsSchema = z.object({
  ui_testable: FactValueSchema,
  behavior_change: FactValueSchema,
  cosmetic_only: FactValueSchema,
  // Tolerant: older / degraded outputs may omit the Version 3 restore signal — a
  // missing value degrades to `no` (the conservative default: no restore discount)
  // rather than failing the whole extraction.
  restores_approved_behavior: FactValueSchema.default({ value: 'no', evidence: '' }),
  money: FactValueSchema,
  irreversible_external: FactValueSchema,
  data_integrity: FactValueSchema,
  access_security: FactValueSchema,
  visual_blast_radius: FactValueSchema,
  // Domain is tolerant: an out-of-enum value degrades to `unknown` rather than
  // failing the whole extraction.
  domain: z
    .string()
    .transform((d) => (DOMAIN_ENUM.includes(d as (typeof DOMAIN_ENUM)[number]) ? d : 'unknown'))
    .pipe(z.enum(DOMAIN_ENUM)),
});

export class TierExtractError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
    this.name = 'TierExtractError';
  }
}

/** The ticket text the classifier reads. */
export interface ExtractInput {
  name: string;
  notes: string;
  typeName: string;
}

export interface ExtractDeps {
  claude: Pick<Anthropic, 'messages'>;
  /** The rubric markdown (loaded once via `loadTierStandard`). Used as the
   *  cache-primed system prompt. */
  prompt: string;
}

/** Parse the `Version: N` header line of the rubric prompt. Throws if absent so
 *  a malformed prompt file fails loudly at boot rather than silently versioning
 *  every classification as 0. */
export function parseTierPromptVersion(prompt: string): number {
  const m = prompt.match(/^\s*Version:\s*(\d+)\s*$/m);
  if (!m) throw new Error('delivery-tier prompt is missing a "Version: N" header line');
  return Number(m[1]);
}

/** Load the public rubric prompt. Resolved relative to THIS compiled module so
 *  it works in both tsx dev (src/…) and node dist (dist/…). The `.md` is copied
 *  into `dist/prompts/` by the build (copy-prompts.mjs + Dockerfile). */
export function loadTierStandard(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/connectors/asana/tier -> src/prompts (four levels up).
  const p = path.resolve(here, '..', '..', '..', 'prompts', 'delivery-tier-standard.md');
  return fs.readFileSync(p, 'utf8');
}

/** Content hash used for the classification cache: identical hash → identical
 *  facts → free reuse. Includes the prompt version AND the live rubric hash so a
 *  rubric change (a bumped version OR an in-place page edit at the same version)
 *  invalidates every prior classification and re-runs the ticket.
 *
 *  `rubricHash` defaults to '' and, when empty, the payload layout is IDENTICAL to
 *  the original two-argument version (`version\nname\nnotes\ntype`). This keeps
 *  fallback-mode callers — and every record persisted before the runtime rubric
 *  shipped — hash-stable, so the first tick after deploy does NOT re-classify the
 *  whole board just because the signature gained a hash slot. A non-empty rubric
 *  hash is spliced in so the SAME ticket under a DIFFERENT live rubric re-classifies. */
export function tierInputHash(promptVersion: number, input: ExtractInput, rubricHash = ''): string {
  const payload = rubricHash
    ? `${promptVersion}\n${rubricHash}\n${input.name}\n${input.notes}\n${input.typeName}`
    : `${promptVersion}\n${input.name}\n${input.notes}\n${input.typeName}`;
  return createHash('sha256').update(payload).digest('hex');
}

function buildUserContent(input: ExtractInput): string {
  return [
    'Classify this Software Board ticket. Extract the facts per the rubric and',
    'return ONLY the JSON object.',
    '',
    `Type: ${input.typeName || '(none)'}`,
    `Name: ${input.name}`,
    'Description:',
    input.notes,
  ].join('\n');
}

/** The ticket text PLUS the real PR diff — the diff is the authoritative source
 *  for a re-check, the ticket description is context only. */
export interface ExtractDiffInput extends ExtractInput {
  diff: string;
  /** True when the diff was truncated to a size limit (classify conservatively). */
  truncated: boolean;
}

function buildDiffUserContent(input: ExtractDiffInput): string {
  const lines = [
    'Re-classify this ticket using the actual PR DIFF as the AUTHORITATIVE source.',
    'The diff is what the code really does; the ticket description is context only.',
    'Judge each rubric fact by what the diff changes, not by what the ticket claims,',
    'and return ONLY the JSON object.',
  ];
  if (input.truncated) {
    lines.push(
      'NOTE: the diff was truncated to a size limit — classify from what is shown and treat unseen changes conservatively.',
    );
  }
  lines.push(
    '',
    `Type: ${input.typeName || '(none)'}`,
    `Name: ${input.name}`,
    'Ticket description (context):',
    input.notes || '(none)',
    '',
    'PR diff (authoritative):',
    input.diff,
  );
  return lines.join('\n');
}

/** Extract the outermost {...} object, tolerating code fences / stray prose. */
function stripToJsonObject(raw: string): string | null {
  if (!raw) return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

function tryParse(raw: string): Facts | null {
  const candidate = stripToJsonObject(raw);
  if (!candidate) return null;
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (json === null || typeof json !== 'object') return null;
  // The rubric page asks for `{ tier, domain, why, evidence, signals }`. The bot
  // recomputes the tier from `signals` (the deterministic contract) — but it ALSO
  // keeps the model's own `tier` for the calibration cross-check: if the LLM tier
  // disagrees with the code-computed tier, the result is floored to T1 and the
  // miss is counted in the Monday report. Tolerate a bare signals object at the
  // top level too (older / degraded outputs).
  const obj = json as Record<string, unknown>;
  const signals = obj.signals && typeof obj.signals === 'object' ? obj.signals : obj;
  const domain = (obj as { domain?: unknown }).domain ?? (signals as { domain?: unknown }).domain;
  const parsed = FactsSchema.safeParse({ ...(signals as Record<string, unknown>), domain });
  if (!parsed.success) return null;
  const llmTier = normalizeLlmTier((obj as { tier?: unknown }).tier);
  return { ...(parsed.data as Omit<Facts, 'llmTier'>), llmTier } as Facts;
}

/** Read the model's own `tier` field, or null if it is missing / not one of the
 *  three tiers. Used only for the calibration cross-check, never as the tier. */
function normalizeLlmTier(raw: unknown): DeliveryTier | null {
  if (raw === 'T0' || raw === 'T1' || raw === 'T2') return raw;
  return null;
}

function extractText(response: Anthropic.Message): string {
  return (response.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();
}

async function callModel(deps: ExtractDeps, userContent: string): Promise<string> {
  const { response, modelUsed, attemptsUsed, failedOver } = await callClaudeWithResilience(
    { claude: deps.claude, model: EXTRACT_MODEL, fallbackModels: EXTRACT_FALLBACK_MODELS },
    {
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      system: [{ type: 'text', text: deps.prompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }],
    } as Anthropic.MessageCreateParamsNonStreaming,
  );
  if (failedOver || attemptsUsed > 1) {
    logger.info(
      { event: 'anthropic_resilient_call', site: EXTRACT_SITE, modelUsed, attemptsUsed, failedOver },
      'delivery-tier extract required retries/failover',
    );
  }
  return extractText(response);
}

/**
 * Run one extraction from a prepared user prompt. Retries the parse ONCE on a
 * malformed response with a "JSON only" nudge, then throws `TierExtractError`.
 * Shared by ticket-text extraction and PR-diff re-extraction.
 */
async function runExtraction(userContent: string, deps: ExtractDeps): Promise<Facts> {
  let raw = await callModel(deps, userContent);
  const first = tryParse(raw);
  if (first) return first;

  logger.warn({ site: EXTRACT_SITE }, 'delivery-tier extract output was not valid JSON — retrying once');
  const retryUser = `${userContent}

Your previous response could not be parsed. Return ONLY the JSON object described in the output contract — no prose, no code fences.`;
  raw = await callModel(deps, retryUser);
  const second = tryParse(raw);
  if (second) return second;

  throw new TierExtractError('delivery-tier facts could not be parsed after one retry', raw);
}

/** Extract the fact set for one ticket from its text (name + description + type). */
export async function extractFacts(input: ExtractInput, deps: ExtractDeps): Promise<Facts> {
  return runExtraction(buildUserContent(input), deps);
}

/**
 * Re-extract the fact set from the real PR diff (the authoritative source per the
 * framework). Same rubric prompt file, same JSON contract — only the user block
 * changes to point the model at the diff instead of the ticket text.
 */
export async function extractFactsFromDiff(input: ExtractDiffInput, deps: ExtractDeps): Promise<Facts> {
  return runExtraction(buildDiffUserContent(input), deps);
}
