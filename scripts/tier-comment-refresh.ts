/**
 * One-shot maintenance: re-render every existing delivery-tier bot comment on the
 * Asana Software Board into the NEW comment format (the readability redesign in
 * `src/connectors/asana/tier/comment.ts`). The old comments were rendered by the
 * previous template (line 1 began with an emoji headline); the new template's line 1
 * begins with `Decision:`. This walks every persisted classification record, recomputes
 * the decision from its stored facts against the currently-adopted rubric, rewrites the
 * stored raw evidence into a plain-English clause via one small Haiku call, and updates
 * the ticket's existing bot comment IN PLACE (never posts a new one, never touches a
 * human-overridden or completed ticket).
 *
 * DEFAULT = DRY RUN: no writes anywhere (still runs the Haiku rewrites so the printed
 * NEW text is exactly what would be posted). `--live` performs the writes (updateStory +
 * persisting the rewritten evidence back into the record). `--limit N` caps the number of
 * records processed (for testing).
 *
 * Read-only otherwise (plus Haiku calls). Run: `npx tsx scripts/tier-comment-refresh.ts`
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

import type { Facts, FactKey, Decision } from '../src/connectors/asana/tier/decide.js';
import type {
  TierClassificationRecord,
  TierUpsert,
} from '../src/storage/repositories/tier-classifications.js';
import type { AsanaApiError } from '../src/connectors/asana/client.js';
import type { AsanaStory, AsanaTask } from '../src/connectors/asana/client.js';

// ---------------------------------------------------------------------------
// Bootstrap — same pattern as scripts/update-story-smoke.ts.
// ---------------------------------------------------------------------------
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
try {
  process.loadEnvFile(path.join(repoRoot, '.env'));
} catch {
  try {
    process.loadEnvFile();
  } catch {
    /* env may already be populated by the shell */
  }
}
process.env.SLACK_BOT_TOKEN ??= 'refresh-unused';
process.env.SLACK_SIGNING_SECRET ??= 'refresh-unused';

const { readVaultSecret } = await import('../src/storage/supabase.js');
const { AsanaApiClient } = await import('../src/connectors/asana/client.js');
const { asanaTaskUrl } = await import('../src/connectors/asana/board-config.js');
const { decideTier } = await import('../src/connectors/asana/tier/decide.js');
const { renderTierComment, renderAuthoritativeComment } = await import(
  '../src/connectors/asana/tier/comment.js'
);
const { extractPrLinks } = await import('../src/connectors/asana/tier/authoritative-pass.js');
const { loadTierStandard } = await import('../src/connectors/asana/tier/extract.js');
const { RubricSource, DELIVERY_TIER_RUBRIC_PAGE_ID, splitStandard, buildFallbackRubric } =
  await import('../src/connectors/asana/tier/rubric-source.js');
const { TierClassificationsRepo } = await import(
  '../src/storage/repositories/tier-classifications.js'
);
const { TierRubricCacheRepo } = await import('../src/storage/repositories/tier-rubric-cache.js');
const { callClaudeWithResilience } = await import('../src/llm/resilient-claude.js');

// ---------------------------------------------------------------------------
// CLI args.
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const LIMIT = parseLimit(argv);

function parseLimit(args: string[]): number | null {
  const eq = args.find((a) => a.startsWith('--limit='));
  if (eq) return sanitizeLimit(eq.slice('--limit='.length));
  const idx = args.indexOf('--limit');
  if (idx >= 0 && idx + 1 < args.length) return sanitizeLimit(args[idx + 1]);
  return null;
}
function sanitizeLimit(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------
const GITHUB_OWNER = process.env.GITHUB_OWNER ?? 'gantri';
const REWRITE_MODEL = 'claude-haiku-4-5-20251001';
const REWRITE_FALLBACK_MODELS = ['claude-sonnet-4-6'];
/** opt_fields for the task read: enough to gate (completed) + render + resolve a PR. */
const TASK_OPT_FIELDS = 'name,notes,completed,permalink_url';
/** opt_fields for the stories read: comment text (old body + PR-link scan). */
const STORY_OPT_FIELDS = 'text,created_at,resource_subtype';
/** The new template's first line always starts with this; the old one never did. */
const NEW_FORMAT_PREFIX = 'Decision:';

// ---------------------------------------------------------------------------
// Result accounting.
// ---------------------------------------------------------------------------
type SkipReason =
  | 'no_comment'
  | 'human_override'
  | 'task_gone'
  | 'completed'
  | 'tier_mismatch'
  | 'comment_deleted'
  | 'already_refreshed';

const skipped: Record<SkipReason, number> = {
  no_comment: 0,
  human_override: 0,
  task_gone: 0,
  completed: 0,
  tier_mismatch: 0,
  comment_deleted: 0,
  already_refreshed: 0,
};
let refreshed = 0;
let failed = 0;
const mismatches: Array<{ taskGid: string; taskName: string; stored: string; recomputed: string }> =
  [];

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
function isAsanaApiError(err: unknown): err is AsanaApiError {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AsanaApiError';
}

function extractText(msg: Anthropic.Message): string {
  return (msg.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();
}

/** A copy of `facts` with a single signal's evidence string replaced. */
function withEvidence(facts: Facts, key: FactKey, evidence: string): Facts {
  return { ...facts, [key]: { ...facts[key], evidence } } as Facts;
}

/**
 * Rewrite one stored evidence string into a single plain-English clause a PM can read,
 * following the same rule as the machine appendix in delivery-tier-standard.md: ≤20
 * words, product terms, NEVER quoted code / JSON / identifiers / symbol names / file
 * paths. Returns null on a bad response (the caller then omits the clause).
 */
async function rewriteEvidence(
  claude: Anthropic,
  taskName: string,
  rawEvidence: string,
): Promise<string | null> {
  const system =
    'You clean up ONE piece of evidence text that appears verbatim on an Asana ticket ' +
    'explaining a delivery-tier decision to a product manager. Rewrite it as ONE ' +
    'plain-English clause of 20 words or fewer that describes WHAT THE CHANGE DOES in ' +
    'product terms a PM can read (e.g. "new orders now capture per-item sidemarks"). It ' +
    'must NEVER contain quoted code, JSON, identifiers, symbol or function names, file ' +
    'paths, or diff fragments — describe the effect, not the source. Do not wrap it in ' +
    'quotes. Return ONLY the clause, on a single line, and nothing else.';
  const user = `Ticket: ${taskName || '(untitled)'}\n\nEvidence to rewrite:\n${rawEvidence}`;
  let text: string;
  try {
    const { response } = await callClaudeWithResilience(
      { claude, model: REWRITE_MODEL, fallbackModels: REWRITE_FALLBACK_MODELS },
      {
        max_tokens: 200,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: user }],
      } as Anthropic.MessageCreateParamsNonStreaming,
    );
    text = extractText(response);
  } catch (err) {
    console.log(`    [haiku] rewrite failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  return sanitizeRewrite(text);
}

/** Sanity-guard a rewrite: single line, ≤200 chars, no `{`/`}`/`;`/`=>`. */
function sanitizeRewrite(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (/\r?\n/.test(s)) return null; // must be a single line
  // Strip surrounding quotes the model sometimes adds.
  s = s.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim();
  if (!s) return null;
  if (s.length > 200) return null;
  if (/[{};]/.test(s) || s.includes('=>')) return null;
  return s;
}

/**
 * Resolve a PR number forward from the ticket, mirroring the authoritative pass's
 * priority order: description (notes) → comments (newest-first) → "Notes for QA"
 * subtask. Only the number is needed for rendering (no GitHub fetch), so the open-PR
 * body-scan fallback is intentionally omitted. Returns null when the ticket names none.
 */
async function resolvePrNumberFromTicket(
  client: InstanceType<typeof AsanaApiClient>,
  task: AsanaTask,
  stories: AsanaStory[],
): Promise<number | null> {
  const inNotes = extractPrLinks(task.notes, GITHUB_OWNER);
  if (inNotes.length > 0) return inNotes[inNotes.length - 1].number;

  for (let i = stories.length - 1; i >= 0; i--) {
    const links = extractPrLinks(stories[i].text, GITHUB_OWNER);
    if (links.length > 0) return links[links.length - 1].number;
  }

  let subtasks: AsanaTask[];
  try {
    subtasks = await client.getTaskSubtasks(task.gid, 'name,notes');
  } catch {
    return null;
  }
  const qa = subtasks.find((s) => (s.name ?? '').toLowerCase().includes('notes for qa'));
  if (!qa) return null;
  const links = extractPrLinks(qa.notes, GITHUB_OWNER);
  return links.length > 0 ? links[links.length - 1].number : null;
}

/** Map a stored record + (optionally mutated) facts to a faithful upsert that changes
 *  nothing but the facts — preserves tier, stage, hashes, commentGid, etc. */
function recordToUpsert(record: TierClassificationRecord, facts: Facts): TierUpsert {
  return {
    taskGid: record.taskGid,
    inputHash: record.inputHash,
    promptVersion: record.promptVersion,
    facts,
    tier: record.tier,
    confirmedTier: record.confirmedTier,
    liftedByUnclear: record.liftedByUnclear,
    calibrationMismatch: record.calibrationMismatch,
    stage: record.stage,
    flags: record.flags,
    domain: record.domain,
    commentGid: record.commentGid,
  };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const asanaToken = await readVaultSecret(supabase, 'ASANA_ACCESS_TOKEN');
console.log('[refresh] vault: ASANA_ACCESS_TOKEN read OK');
const asana = new AsanaApiClient({ accessToken: asanaToken });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const repo = new TierClassificationsRepo(supabase);

// Load the adopted rubric exactly the way boot does: committed fallback (snapshot +
// machine appendix) plus the Supabase last-known-good cache. No Notion fetch.
const standardFile = loadTierStandard();
const { appendix } = splitStandard(standardFile);
const fallbackRubric = buildFallbackRubric(standardFile);
const rubricSource = new RubricSource({
  pageId: DELIVERY_TIER_RUBRIC_PAGE_ID,
  appendix,
  fallback: fallbackRubric,
  cache: new TierRubricCacheRepo(supabase),
});
await rubricSource.init();
const rubric = rubricSource.getRubric();
console.log(
  `[refresh] rubric adopted: Version ${rubric.version} (hash ${rubric.hash.slice(0, 8)})`,
);
console.log(`[refresh] mode: ${LIVE ? 'LIVE (writes enabled)' : 'DRY RUN (no writes)'}` +
  (LIMIT ? `, limit ${LIMIT}` : ''));

// Every bot-owned (non-overridden) classification, then the cheap filters.
const allBot = await repo.listActiveBot();
const withComment = allBot.filter((r) => r.decidedBy !== 'human_override' && r.commentGid);
// Count records dropped by the cheap pre-filter as skips so totals reconcile.
skipped.no_comment += allBot.filter((r) => !r.commentGid && r.decidedBy !== 'human_override').length;
skipped.human_override += allBot.filter((r) => r.decidedBy === 'human_override').length;

const records = LIMIT ? withComment.slice(0, LIMIT) : withComment;
console.log(
  `[refresh] ${allBot.length} bot records total; ${withComment.length} have a comment; ` +
    `processing ${records.length}\n`,
);

for (const record of records) {
  try {
    await processRecord(record);
  } catch (err) {
    failed += 1;
    console.log(
      `  [FAIL] task ${record.taskGid}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

printSummary();

async function processRecord(record: TierClassificationRecord): Promise<void> {
  const commentGid = record.commentGid!; // filtered to non-null above

  // Fetch the task. A gone / forbidden task (404/403) is skipped.
  let task: AsanaTask;
  try {
    task = await asana.getTask(record.taskGid, TASK_OPT_FIELDS);
  } catch (err) {
    if (isAsanaApiError(err) && (err.status === 404 || err.status === 403 || err.status === 410)) {
      skipped.task_gone += 1;
      console.log(`  [skip] task ${record.taskGid} gone (${err.status})`);
      return;
    }
    throw err;
  }
  const taskName = task.name ?? '';
  const permalink = task.permalink_url ?? asanaTaskUrl(record.taskGid);

  if (task.completed) {
    skipped.completed += 1;
    console.log(`  [skip] "${taskName}" is completed`);
    return;
  }

  // Recompute the decision from the STORED facts against the adopted rubric. The tier
  // MUST still match what the field carries — never post a comment that contradicts it.
  const decision: Decision = decideTier(record.facts, rubric.tableMap);
  if (decision.tier !== record.tier) {
    skipped.tier_mismatch += 1;
    mismatches.push({
      taskGid: record.taskGid,
      taskName,
      stored: record.tier,
      recomputed: decision.tier,
    });
    console.log(
      `  [SKIP-MISMATCH] "${taskName}" stored tier ${record.tier} but recomputed ${decision.tier} — NOT touching`,
    );
    return;
  }

  // Read the task's stories once (old comment body + PR-link scan).
  const stories = await asana.getTaskStories(record.taskGid, STORY_OPT_FIELDS);
  const story = stories.find((s) => s.gid === commentGid);
  if (!story) {
    skipped.comment_deleted += 1;
    console.log(`  [skip] "${taskName}" comment ${commentGid} no longer exists`);
    return;
  }
  const oldText = story.text ?? '';
  if (oldText.startsWith(NEW_FORMAT_PREFIX)) {
    skipped.already_refreshed += 1;
    console.log(`  [skip] "${taskName}" already in new format`);
    return;
  }

  // Evidence rewrite: the stored facts carry old-style raw code/JSON quotes. Rewrite the
  // cited signal's evidence into a plain-English clause. On a bad response, omit the
  // clause (render without it) rather than posting garbage.
  let renderFacts: Facts = record.facts;
  let rewritten: string | null = null;
  const ef = decision.evidenceFact;
  if (ef && record.facts[ef].evidence.trim().length > 0) {
    rewritten = await rewriteEvidence(claude, taskName, record.facts[ef].evidence);
    renderFacts = withEvidence(record.facts, ef, rewritten ?? '');
  }

  // Render in the NEW format. Authoritative-stage records resolve their PR number
  // forward from the ticket; provisional-stage records render the provisional comment.
  let rendered: { text: string; html: string };
  if (record.stage === 'authoritative') {
    const prNumber = await resolvePrNumberFromTicket(asana, task, stories);
    rendered = renderAuthoritativeComment({
      fromTier: null,
      toTier: record.tier,
      source: prNumber ? 'diff' : 'description',
      prNumber: prNumber ?? undefined,
      decision,
      facts: renderFacts,
      promptVersion: rubric.version,
    });
  } else {
    rendered = renderTierComment(decision, renderFacts, rubric.version, { provisional: true });
  }

  // Report this record (both modes).
  console.log(`  ${LIVE ? '[refresh]' : '[would-refresh]'} "${taskName}"`);
  console.log(`    permalink: ${permalink}`);
  console.log(`    stage: ${record.stage} · tier: ${record.tier}`);
  console.log(`    OLD:\n${indent(oldText)}`);
  console.log(`    NEW:\n${indent(rendered.text)}`);

  if (!LIVE) {
    refreshed += 1;
    console.log('');
    return;
  }

  // Live: update the comment in place. A 404 means a human deleted it since the read.
  try {
    await asana.updateStory(commentGid, rendered.text, rendered.html);
  } catch (err) {
    if (isAsanaApiError(err) && (err.status === 404 || err.status === 410)) {
      skipped.comment_deleted += 1;
      console.log(`    [skip] comment ${commentGid} deleted before update (${err.status})`);
      return;
    }
    throw err;
  }

  // Persist the rewritten evidence back into the record (only that signal) so later
  // re-renders don't regress to the old raw quote. Only when we have a valid rewrite.
  if (rewritten && ef) {
    await repo.upsertBot(recordToUpsert(record, withEvidence(record.facts, ef, rewritten)));
  }

  refreshed += 1;
  console.log('');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n');
}

function printSummary(): void {
  const totalSkipped = Object.values(skipped).reduce((a, b) => a + b, 0);
  console.log('\n========================= SUMMARY =========================');
  console.log(`mode:              ${LIVE ? 'LIVE' : 'DRY RUN'}`);
  console.log(`bot records total: ${refreshed + totalSkipped + failed}`);
  console.log(`${LIVE ? 'refreshed' : 'would-refresh'}:      ${refreshed}`);
  console.log(`skipped (total):   ${totalSkipped}`);
  for (const [reason, n] of Object.entries(skipped)) {
    if (n > 0) console.log(`   - ${reason}: ${n}`);
  }
  console.log(`failed:            ${failed}`);
  if (mismatches.length > 0) {
    console.log(`\ntier mismatches (recomputed != stored) — SKIPPED, review manually:`);
    for (const m of mismatches) {
      console.log(`   - "${m.taskName}" [${m.taskGid}] stored ${m.stored} → recomputed ${m.recomputed}`);
    }
  }
  console.log('===========================================================');
}
