import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { logger } from '../../logger.js';
import { callClaudeWithResilience } from '../../llm/resilient-claude.js';

/**
 * ONE batched LLM call classifies every bounced feature as a genuine functional
 * bug vs process/environment noise. Deterministic detection (who bounced it,
 * when) happens upstream in the story-analyzer; the LLM only judges intent from
 * the bounce metadata + evidence (nearby comments and defect sub-tasks).
 *
 * CALIBRATION: a QA reviewer does not bounce a ticket out of QA without a cause,
 * and Gantri QA logs the defect detail in a sub-task rather than a comment — so
 * a QA bounce (`isQaBouncer=true`) DEFAULTS to isRealBug=true and is only flipped
 * to false by EXPLICIT non-bug evidence (merge conflicts, preview/staging/deploy
 * environment issues, outdated/unclear acceptance criteria including "expected
 * behavior" reclassifications, missing/unclear QA notes or testing-step
 * requests, ownership/scope/process disputes, stakeholder change requests,
 * waiting-on-dependency pauses, template artifacts). A bounce performed only by
 * non-QA people keeps a neutral default (thin evidence → isRealBug=false).
 *
 * If the call fails after resilience (or returns an unparseable shape), we
 * return `degraded: true` and an empty map — the connector then marks those
 * features 'unclassified' (counted in anyBounce, NOT in realBug).
 */

const CLASSIFIER_MODEL = 'claude-haiku-4-5';
const CLASSIFIER_FALLBACK_MODELS = ['claude-sonnet-4-6'];
const CLASSIFIER_SITE = 'asana_qa_classifier';

/**
 * Features per batched LLM call. The classifier emits one JSON row per feature
 * (~30-40 output tokens each), so a single call over a long window on the busy
 * board (year-to-date across ~130 features) would overflow the response token
 * budget, truncate the array mid-string, fail to parse, and silently degrade
 * the ENTIRE run to `unclassified`. Chunking bounds each call's output and
 * gives PARTIAL fallback: a truncated/failed chunk only loses its own features,
 * not the whole report. Still batched (not per-feature) per the methodology —
 * at most ~4 calls for the largest board.
 */
const CLASSIFIER_BATCH_SIZE = 40;

/**
 * Output token budget per batch. 40 rows * ~40 tokens ≈ 1600; 4096 leaves ample
 * headroom for verbose `reason` phrases so a batch never truncates.
 */
const CLASSIFIER_MAX_TOKENS = 4096;

/** One bounce as handed to the classifier. Mirrors story-analyzer's `Bounce`
 *  plus `isQaBouncer` — whether the person who performed the bounce is a QA
 *  reviewer, which drives the default classification. */
export interface ClassifierBounce {
  by: string;
  from: string;
  to: string;
  at: string;
  isQaBouncer: boolean;
  evidenceComments: string[];
}

export interface BouncedFeatureInput {
  gid: string;
  taskName: string;
  bounces: ClassifierBounce[];
}

export interface Classification {
  isRealBug: boolean;
  reason: string;
}

export interface ClassifyResult {
  /** gid → classification. Missing gids fall through to 'unclassified'. */
  classifications: Map<string, Classification>;
  /** True when the LLM call failed and NOTHING could be classified. */
  degraded: boolean;
}

const ClassificationRowSchema = z.object({
  gid: z.string().min(1),
  isRealBug: z.boolean(),
  reason: z.string(),
});
const ClassificationArraySchema = z.array(ClassificationRowSchema);

export interface QaClassifierDeps {
  /** Anthropic SDK client. We only call `messages.create`. */
  claude: Pick<Anthropic, 'messages'>;
}

export async function classifyBouncedFeatures(
  features: BouncedFeatureInput[],
  deps: QaClassifierDeps,
): Promise<ClassifyResult> {
  if (features.length === 0) {
    return { classifications: new Map(), degraded: false };
  }

  // Fan the features out into bounded batches so a large window can never
  // overflow one call's output-token budget and blank the whole run. Each gid
  // appears in exactly one batch, so merging the maps is conflict-free. A failed
  // batch leaves only its own features unclassified and flags `degraded`.
  const classifications = new Map<string, Classification>();
  let degraded = false;
  for (let i = 0; i < features.length; i += CLASSIFIER_BATCH_SIZE) {
    const batch = features.slice(i, i + CLASSIFIER_BATCH_SIZE);
    const result = await classifyBatch(batch, deps);
    if (result.degraded) {
      degraded = true;
      continue;
    }
    for (const [gid, cls] of result.classifications) classifications.set(gid, cls);
  }
  return { classifications, degraded };
}

/** Classify a SINGLE batch (≤ CLASSIFIER_BATCH_SIZE features) in one LLM call.
 *  A call/parse/schema failure returns `degraded: true` for this batch only. */
async function classifyBatch(
  features: BouncedFeatureInput[],
  deps: QaClassifierDeps,
): Promise<ClassifyResult> {
  const prompt = buildPrompt(features);

  let text: string;
  try {
    const { response, modelUsed, attemptsUsed, failedOver } = await callClaudeWithResilience(
      {
        claude: deps.claude,
        model: CLASSIFIER_MODEL,
        fallbackModels: CLASSIFIER_FALLBACK_MODELS,
      },
      {
        max_tokens: CLASSIFIER_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      },
    );
    if (failedOver || attemptsUsed > 1) {
      logger.info(
        { event: 'anthropic_resilient_call', site: CLASSIFIER_SITE, modelUsed, attemptsUsed, failedOver },
        'asana qa classifier Anthropic call required retries/failover',
      );
    }
    text = extractText(response.content);
  } catch (err) {
    logger.error(
      { site: CLASSIFIER_SITE, err: err instanceof Error ? err.message : String(err) },
      'asana_qa_classifier_call_failed',
    );
    return { classifications: new Map(), degraded: true };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(extractJsonArray(text));
  } catch (err) {
    logger.error(
      { site: CLASSIFIER_SITE, rawText: text, err: err instanceof Error ? err.message : String(err) },
      'asana_qa_classifier_unparseable_response',
    );
    return { classifications: new Map(), degraded: true };
  }

  const safe = ClassificationArraySchema.safeParse(parsedJson);
  if (!safe.success) {
    logger.error(
      { site: CLASSIFIER_SITE, rawText: text, zodIssues: safe.error.issues },
      'asana_qa_classifier_schema_violation',
    );
    return { classifications: new Map(), degraded: true };
  }

  const map = new Map<string, Classification>();
  for (const row of safe.data) {
    map.set(row.gid, { isRealBug: row.isRealBug, reason: row.reason.trim() });
  }
  return { classifications: map, degraded: false };
}

function buildPrompt(features: BouncedFeatureInput[]): string {
  const payload = features.map((f) => ({
    gid: f.gid,
    taskName: f.taskName,
    bounces: f.bounces.map((b) => ({
      by: b.by,
      from: b.from,
      to: b.to,
      at: b.at,
      isQaBouncer: b.isQaBouncer,
      evidenceComments: b.evidenceComments,
    })),
  }));

  return [
    'You are auditing an engineering QA board. Each item below is a FEATURE ticket that was bounced backward out of a QA stage (or reopened after being marked done). For EACH feature decide whether ANY of its bounces represents a GENUINE FUNCTIONAL BUG that QA (or a developer) found in the feature under test, versus PROCESS / ENVIRONMENT / CRITERIA noise.',
    '',
    'Each bounce carries an `isQaBouncer` flag (the person who performed the move is a QA reviewer). QA does not bounce a ticket out of QA without a cause, and logs the defect detail in a sub-task that may not appear in the comments. So apply these DEFAULTS:',
    '- Bounce with isQaBouncer=true → isRealBug=TRUE, UNLESS the evidence EXPLICITLY indicates a non-bug cause (see the false list). Thin, empty, or comment-less evidence on a QA bounce STILL means isRealBug=TRUE.',
    '- Bounce performed only by non-QA people (isQaBouncer=false) → judge purely from the evidence; when the evidence is thin or ambiguous, isRealBug=FALSE.',
    '',
    'isRealBug=TRUE signals: errors / broken / crash / "not working" / does not match the design or spec; a defect-sounding sub-task created around the bounce time; "issue found"; visual or layout defects; wrong or missing data shown; incorrect behavior.',
    '',
    'isRealBug=FALSE ONLY when the evidence EXPLICITLY shows one of these non-bug causes: merge conflicts or PR-review-pending process gaps; preview / staging / deploy environment issues; outdated or unclear acceptance criteria (including "expected behavior" reclassifications); missing or unclear QA notes or testing-steps requests; ownership / scope / process disputes; stakeholder-originated change requests; waiting-on-a-dependency pauses; template artifacts.',
    '',
    'A feature may have several bounces — mark isRealBug=TRUE if ANY qualifying bounce is a real functional finding under the rules above.',
    '',
    'Output ONLY valid JSON, no commentary, no markdown fence — an array with one object per input feature (same gids), in this exact shape:',
    '[{"gid": "<gid>", "isRealBug": true|false, "reason": "<one short phrase, at most 12 words>"}]',
    'Keep each "reason" to at most 12 words — a terse phrase, not a sentence.',
    '',
    'Features:',
    JSON.stringify(payload),
  ].join('\n');
}

function extractText(content: Array<{ type: string; text?: string }> | undefined): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/** Pull the first [...] JSON array substring from `text`. Defensive — the model
 *  sometimes wraps the array in a sentence even when asked not to. Falls back to
 *  the original text (letting JSON.parse throw) when no array is found. */
function extractJsonArray(text: string): string {
  const start = text.indexOf('[');
  if (start < 0) return text;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text;
}
