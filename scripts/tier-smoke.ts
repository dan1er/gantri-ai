/**
 * End-to-end WRITE-path smoke of the Delivery Tier classifier against the REAL
 * Asana Software Board.
 *
 * Strictly scoped to ONE disposable task it creates and, unconditionally, deletes:
 *   1. Create a throwaway task on the Software Board whose description is crafted
 *      to fire the T2 "money" risk trigger. The Delivery Tier field is left empty.
 *   2. Run the poller's REAL per-task classify path (`TierPoller.processOne`) for
 *      THAT task gid only — never the board sweep, so no other ticket is touched.
 *      This performs the real Haiku extract, `decideTier`, the Asana enum-field
 *      write, the Asana comment, and the Supabase upsert.
 *   3. Assert the field value, the comment content, the Supabase row, and that the
 *      task fetch carries `memberships.section` (the opt_field the authoritative
 *      pass relies on).
 *   4. Clean up unconditionally (finally): DELETE the Asana task and the
 *      tier_classifications row, then verify both are gone.
 *
 * This makes REAL, billed Anthropic (Haiku) calls and REAL Asana writes. It writes
 * nothing that survives the run.
 *
 * Run: `npx tsx scripts/tier-smoke.ts`
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
// Type-only imports are erased at compile time and never trigger runtime module
// evaluation — safe to keep static (they do NOT pull in the bot's logger/env).
import type { AsanaTask } from '../src/connectors/asana/client.js';

// Load .env BEFORE any bot source module is evaluated. Every src module
// transitively imports logger.ts, whose top-level loadEnv() validates the FULL env
// schema on import — so the src modules below are pulled in via DYNAMIC import AFTER
// this runs, and the two Slack fields the schema requires (but this script never
// uses) get inert placeholders. dotenv is not a project dependency;
// process.loadEnvFile is the zero-dependency stand-in.
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
// Inert placeholders so loadEnv's schema passes; never sent anywhere.
process.env.SLACK_BOT_TOKEN ??= 'smoke-unused';
process.env.SLACK_SIGNING_SECRET ??= 'smoke-unused';

// Runtime symbols from the bot's source, imported only AFTER env is populated so
// the transitive logger/env boot does not blow up.
const { readVaultSecret } = await import('../src/storage/supabase.js');
const { AsanaApiClient } = await import('../src/connectors/asana/client.js');
const { TierPoller } = await import('../src/connectors/asana/tier/poller.js');
const { loadTierStandard, parseTierPromptVersion } = await import('../src/connectors/asana/tier/extract.js');
const { PROVISIONAL_LINE } = await import('../src/connectors/asana/tier/comment.js');
const { TierClassificationsRepo } = await import('../src/storage/repositories/tier-classifications.js');
const {
  ASANA_API_BASE,
  SOFTWARE_BOARD_PROJECT_GID,
  DELIVERY_TIER_FIELD_GID,
  DELIVERY_TIER_OPTION_GIDS,
} = await import('../src/connectors/asana/board-config.js');

// --- Fixture -------------------------------------------------------------------

const TASK_NAME = '[TIER-BOT SMOKE] — ignore, auto-deleted in minutes';
// Two sentences engineered to fire the T2 money trigger: an unambiguous change to
// how a refund amount (money) is calculated during customer cancellation at
// checkout — money=yes, behavior_change=yes, ui_testable=yes → t2_risk_trigger.
const TASK_NOTES = [
  'This changes how refund amounts are calculated when a customer cancels their order during checkout.',
  'Instead of refunding only the item subtotal, the customer is now refunded the full charge including',
  'shipping and tax back to their original payment method.',
].join(' ');

/** The T2 enum option gid the classifier must write (from the task spec). */
const EXPECTED_T2_OPTION_GID = '1216565279651996';

/** opt_fields the poller uses to classify + the memberships.section fields the
 *  authoritative pass relies on. */
const OPT_FIELDS = [
  'name',
  'notes',
  'completed',
  'created_at',
  'permalink_url',
  'custom_fields.gid',
  'custom_fields.name',
  'custom_fields.enum_value.gid',
  'custom_fields.enum_value.name',
  'memberships.project.gid',
  'memberships.section.gid',
  'memberships.section.name',
].join(',');

// --- Assertion recorder --------------------------------------------------------

interface Check {
  label: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
function assert(label: string, pass: boolean, detail = ''): void {
  checks.push({ label, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${label}${detail ? ` :: ${detail}` : ''}`);
}

// --- Small helpers -------------------------------------------------------------

/** The gid of the task's Delivery Tier enum value, or null if the field is empty. */
function deliveryTierGid(task: AsanaTask): string | null {
  const cf = (task.custom_fields ?? []).find((f) => f.gid === DELIVERY_TIER_FIELD_GID);
  return cf?.enum_value?.gid ?? null;
}

/** The Software Board section membership of the task, or null. */
function boardSection(task: AsanaTask): { gid: string | null; name: string | null } | null {
  const m = (task.memberships ?? []).find((mm) => mm.project?.gid === SOFTWARE_BOARD_PROJECT_GID);
  if (!m) return null;
  return { gid: m.section?.gid ?? null, name: m.section?.name ?? null };
}

const asanaHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/json',
});

/** Create the disposable task on the Software Board (raw REST — the read client
 *  has no create method). Returns the created task gid. */
async function createSmokeTask(token: string): Promise<string> {
  const res = await fetch(`${ASANA_API_BASE}/tasks`, {
    method: 'POST',
    headers: { ...asanaHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: { name: TASK_NAME, notes: TASK_NOTES, projects: [SOFTWARE_BOARD_PROJECT_GID] },
    }),
  });
  if (!res.ok) {
    throw new Error(`create task failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const json = (await res.json()) as { data: { gid: string } };
  return json.data.gid;
}

/** DELETE a task. Returns the HTTP status. */
async function deleteTask(token: string, gid: string): Promise<number> {
  const res = await fetch(`${ASANA_API_BASE}/tasks/${gid}`, {
    method: 'DELETE',
    headers: asanaHeaders(token),
  });
  return res.status;
}

/** True if the task still exists (a deleted task returns 404). */
async function taskExists(token: string, gid: string): Promise<boolean> {
  const res = await fetch(`${ASANA_API_BASE}/tasks/${gid}?opt_fields=gid`, {
    headers: asanaHeaders(token),
  });
  return res.status !== 404;
}

// --- Main ----------------------------------------------------------------------

async function main(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const missing = [
    !supabaseUrl && 'SUPABASE_URL',
    !supabaseKey && 'SUPABASE_SERVICE_ROLE_KEY',
    !anthropicKey && 'ANTHROPIC_API_KEY',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(', ')} (expected in ${path.join(repoRoot, '.env')})`);
  }

  // Built directly (not via getSupabase/loadEnv) because loadEnv also requires
  // Slack tokens this .env does not carry.
  const supabase = createClient(supabaseUrl!, supabaseKey!, { auth: { persistSession: false } });
  const asanaToken = await readVaultSecret(supabase, 'ASANA_ACCESS_TOKEN');
  console.log('[smoke] vault: ASANA_ACCESS_TOKEN read OK');

  const asana = new AsanaApiClient({ accessToken: asanaToken });
  const claude = new Anthropic({ apiKey: anthropicKey });
  const prompt = loadTierStandard();
  const promptVersion = parseTierPromptVersion(prompt);
  const repo = new TierClassificationsRepo(supabase);
  console.log(`[smoke] rubric version ${promptVersion} loaded`);

  // The real poller, wired exactly like production minus the authoritative pass
  // (not needed: we invoke the per-task classify entry directly, never the sweep).
  const poller = new TierPoller({
    client: asana,
    repo,
    extract: { claude, prompt },
    promptVersion,
    rolloutDateMs: 0, // unused by processOne; the candidate gate is not on this path
    authoritative: undefined,
  });
  // processOne is the poller's per-task classify entry (private). Bind it so `this`
  // resolves; a typed cast keeps this honest without touching src.
  const classifyOne = (
    poller as unknown as { processOne(task: AsanaTask): Promise<string> }
  ).processOne.bind(poller);

  let createdGid: string | null = null;
  try {
    createdGid = await createSmokeTask(asanaToken);
    console.log(`[smoke] created disposable task ${createdGid} (https://app.asana.com/0/${SOFTWARE_BOARD_PROJECT_GID}/${createdGid})`);

    // Fetch with the poller's opt_fields, then run the REAL per-task write path.
    const taskForClassify = await asana.getTask(createdGid, OPT_FIELDS);
    assert('precondition: Delivery Tier starts empty', deliveryTierGid(taskForClassify) === null,
      `field=${deliveryTierGid(taskForClassify) ?? 'null'}`);

    const outcome = await classifyOne(taskForClassify);
    console.log(`[smoke] classify outcome: ${outcome}`);

    // --- Assertions ---
    const after = await asana.getTask(createdGid, OPT_FIELDS);

    const tierGid = deliveryTierGid(after);
    assert('Delivery Tier field == T2 option gid', tierGid === EXPECTED_T2_OPTION_GID,
      `got ${tierGid ?? 'null'}, expected ${EXPECTED_T2_OPTION_GID}`);
    // Sanity: the constant used by src matches the spec's literal.
    assert('board-config T2 gid matches spec literal',
      DELIVERY_TIER_OPTION_GIDS.T2 === EXPECTED_T2_OPTION_GID,
      `board-config=${DELIVERY_TIER_OPTION_GIDS.T2}`);

    const sec = boardSection(after);
    assert('task fetch includes memberships.section', !!(sec && (sec.gid || sec.name)),
      `section="${sec?.name ?? 'null'}" (gid ${sec?.gid ?? 'null'})`);

    const stories = await asana.getTaskStories(createdGid, 'text,resource_subtype,created_by.name');
    const comment = stories.find((s) => (s.text ?? '').includes(PROVISIONAL_LINE));
    const text = comment?.text ?? '';
    assert('comment: Provisional line present', text.includes(PROVISIONAL_LINE),
      comment ? `story ${comment.gid}` : 'no story containing the provisional line');
    assert('comment: "Rubric v2" present', text.includes('Rubric v2'));
    assert('comment: money rule fired', text.includes('changes money (Step 3)'));
    // Line 2 is the bare quoted evidence excerpt (no "Evidence:" prefix in the compact format).
    const evMatch = text.match(/^"([^"]+)"/m);
    assert('comment: quoted evidence present', !!(evMatch && evMatch[1].trim().length > 0),
      evMatch ? `evidence "${evMatch[1]}"` : 'no evidence quote');
    if (text) console.log(`[smoke] --- comment ---\n${text}\n[smoke] --- end comment ---`);

    const rec = await repo.get(createdGid);
    assert('tier_classifications row exists', !!rec, rec ? '' : 'no row');
    if (rec) {
      assert("row stage == 'provisional'", rec.stage === 'provisional', `got ${rec.stage}`);
      assert("row tier == 'T2'", rec.tier === 'T2', `got ${rec.tier}`);
      assert("row confirmed_tier == 'T2'", rec.confirmedTier === 'T2', `got ${rec.confirmedTier ?? 'null'}`);
      assert("row decided_by == 'bot'", rec.decidedBy === 'bot', `got ${rec.decidedBy}`);
    }
  } catch (err) {
    assert('run completed without unexpected error', false,
      err instanceof Error ? (err.stack ?? err.message) : String(err));
  } finally {
    // --- Mandatory cleanup (runs even on assertion failure) ---
    if (createdGid) {
      try {
        const status = await deleteTask(asanaToken, createdGid);
        const stillThere = await taskExists(asanaToken, createdGid);
        assert('cleanup: Asana task deleted + verified gone',
          status >= 200 && status < 300 && !stillThere,
          `delete status ${status}, exists=${stillThere}`);
      } catch (e) {
        assert('cleanup: Asana task deleted + verified gone', false, String(e));
      }
      try {
        const { error } = await supabase.from('tier_classifications').delete().eq('task_gid', createdGid);
        if (error) throw new Error(error.message);
        const gone = (await repo.get(createdGid)) === null;
        assert('cleanup: tier_classifications row deleted + verified gone', gone,
          gone ? '' : 'row still present');
      } catch (e) {
        assert('cleanup: tier_classifications row deleted + verified gone', false, String(e));
      }
    } else {
      console.log('[smoke] nothing created — no cleanup needed');
    }
  }

  const passed = checks.filter((c) => c.pass).length;
  console.log(`\n=== SMOKE SUMMARY: ${passed}/${checks.length} checks passed ===`);
  const failed = checks.filter((c) => !c.pass);
  if (failed.length) {
    console.log('FAILED CHECKS:');
    for (const f of failed) console.log(` - ${f.label}${f.detail ? `: ${f.detail}` : ''}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[smoke] fatal:', err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
