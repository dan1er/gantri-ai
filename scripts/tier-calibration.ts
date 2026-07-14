/**
 * Read-only retro-calibration of the Delivery Tier classifier against real
 * Software Board tickets.
 *
 * STRICTLY READ-ONLY: it GETs tasks from Asana and SELECTs the ASANA_ACCESS_TOKEN
 * vault secret, then runs the exact same `extractFacts` (ticket-text mode) +
 * `decideTier` pipeline the read-only `asana.delivery_tier_preview` tool uses. It
 * NEVER writes an Asana field/comment and NEVER inserts/updates a Supabase row.
 * Real Anthropic (Haiku) calls are expected (~55: 40 sampled tickets + 3×5 for the
 * stability check).
 *
 * Run: `npx tsx scripts/tier-calibration.ts`
 *
 * Flags:
 *   --tasks <file>   classify EXACTLY the task gids listed in <file> (one gid per
 *                    line, blank lines and `#` comments ignored), in file order,
 *                    instead of scanning + diversity-sampling the board. Use this to
 *                    re-run against the identical ticket set from a prior run.
 *   --golden <file>  GOLDEN-EVAL mode: read the committed golden set (JSON array of
 *                    `{ row, taskGid, name, expected: ["T1"] | ["T0","T1"] }`),
 *                    classify each gid with the live extract+decide pipeline, and
 *                    score each row (PASS = computed tier ∈ `expected`). Prints a
 *                    per-row PASS/FAIL table + the total score and EXITS 1 if any row
 *                    NOT flagged `knownMiss` FAILS (ratchet: documented misses are
 *                    allowed; new misses and regressions are not). This is the
 *                    regression gate for the classifier.
 *   --label <name>   suffix the output basenames (`…-<name>.md/.json`) so a re-run
 *                    does not clobber a prior golden set.
 *
 * ⚠️  REGRESSION GATE — RUN THE GOLDEN EVAL BEFORE MERGING any change to the rubric
 *     prompt (`src/prompts/delivery-tier-standard.md`) or to `DOMAIN_BASE_TIER` /
 *     the `decideTier` logic in `src/connectors/asana/tier/decide.ts`:
 *
 *         npx tsx scripts/tier-calibration.ts --golden tests/golden/tier-golden.json --label v3
 *
 *     A non-zero exit means the change moved a calibrated ticket off its expected
 *     tier — reconcile the golden set (with a labelled diff-review) or fix the
 *     regression before merging. Do NOT merge on a red golden eval.
 *
 *     This gate also runs automatically in CI: `.github/workflows/tier-golden.yml`
 *     invokes exactly this command on any PR that touches `src/prompts/**`,
 *     `src/connectors/asana/tier/**`, or `tests/golden/**`.
 *
 * Outputs (to $TIER_CALIB_OUT_DIR, default os.tmpdir()/tier-calibration; NOT committed):
 *   - tier-calibration-results[-<label>].md   summary + human-readable table
 *   - tier-calibration-results[-<label>].json machine-readable facts per ticket
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
// Type-only imports are erased at compile time and never trigger runtime module
// evaluation — safe to keep static (they do NOT pull in the bot's logger/env).
import type { AsanaTask } from '../src/connectors/asana/client.js';
import type { ExtractDeps, ExtractInput } from '../src/connectors/asana/tier/extract.js';
import type { Decision, Facts, FactKey, DomainBaseTierMap } from '../src/connectors/asana/tier/decide.js';

// Load .env at the very top (native dotenv equivalent, built into Node >=20.12)
// BEFORE any bot source module is evaluated. Every src module transitively imports
// `logger.ts`, whose top-level `loadEnv()` validates the FULL env schema on import —
// so the src modules below are pulled in via DYNAMIC import AFTER this runs, and the
// two Slack fields the schema requires (but this read-only script never uses) get
// inert placeholders. dotenv is not a project dependency; process.loadEnvFile is the
// zero-dependency stand-in.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
try {
  process.loadEnvFile(path.join(repoRoot, '.env'));
} catch {
  // Fall back to a .env in cwd; if neither exists we rely on already-set env.
  try {
    process.loadEnvFile();
  } catch {
    /* env may already be populated by the shell */
  }
}
// Inert placeholders so `loadEnv`'s schema passes; never sent anywhere.
process.env.SLACK_BOT_TOKEN ??= 'calibration-unused';
process.env.SLACK_SIGNING_SECRET ??= 'calibration-unused';

// Runtime symbols from the bot's source, imported only AFTER env is populated so
// the transitive logger/env boot does not blow up.
const { readVaultSecret } = await import('../src/storage/supabase.js');
const { AsanaApiClient } = await import('../src/connectors/asana/client.js');
const { NotionApiClient } = await import('../src/connectors/notion/client.js');
const { extractFacts, loadTierStandard } = await import('../src/connectors/asana/tier/extract.js');
const { decideTier } = await import('../src/connectors/asana/tier/decide.js');
const { RubricSource, splitStandard, buildFallbackRubric, DELIVERY_TIER_RUBRIC_PAGE_ID } = await import(
  '../src/connectors/asana/tier/rubric-source.js'
);
const { SOFTWARE_BOARD_PROJECT_GID, TYPE_FIELD_GID, isFeatureTemplateTask, isTierExcludedType } =
  await import('../src/connectors/asana/board-config.js');

// --- Tunables ------------------------------------------------------------------

/** Only sample tickets created within this window (days). */
const WINDOW_DAYS = 60;
/** Target sample size. */
const SAMPLE_SIZE = 40;
/** Minimum description length to classify (matches the poller's gate). */
const MIN_NOTES_CHARS = 40;
/** How many main classifications to run in parallel. */
const CLASSIFY_CONCURRENCY = 3;
/** Stability check: first N tickets, classified this many times each. */
const STABILITY_TICKETS = 3;
const STABILITY_RUNS = 5;
/** Max evidence quote length in the markdown table. */
const EVIDENCE_MAX = 80;

const OUT_DIR =
  process.env.TIER_CALIB_OUT_DIR ?? path.join(os.tmpdir(), 'tier-calibration');

/** Minimal CLI parse: `--tasks <file>` fixes the ticket set; `--golden <file>`
 *  switches to golden-eval mode; `--label <name>` suffixes the output basenames so a
 *  re-run does not clobber a prior golden set. */
function parseArgs(argv: string[]): { tasksFile: string | null; goldenFile: string | null; label: string } {
  let tasksFile: string | null = null;
  let goldenFile: string | null = null;
  let label = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tasks') tasksFile = argv[++i] ?? null;
    else if (argv[i] === '--golden') goldenFile = argv[++i] ?? null;
    else if (argv[i] === '--label') label = argv[++i] ?? '';
  }
  return { tasksFile, goldenFile, label };
}

/** Read a `--tasks` file into an ordered list of task gids (blank lines and `#`
 *  comments ignored). Preserves order so the re-run keeps the prior indices. */
function readTaskGids(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** opt_fields required to gate + classify a task and read its section/type. */
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

// --- Small helpers -------------------------------------------------------------

/** The display name of a task's Type field option, or '' if unset. */
function typeName(task: AsanaTask): string {
  const cf = (task.custom_fields ?? []).find((f) => f.gid === TYPE_FIELD_GID);
  return cf?.enum_value?.name ?? '';
}

/** The Software Board section a task currently sits in, or '(none)'. */
function sectionName(task: AsanaTask): string {
  const m = (task.memberships ?? []).find((mm) => mm.project?.gid === SOFTWARE_BOARD_PROJECT_GID);
  return m?.section?.name ?? '(none)';
}

const asanaTaskUrl = (gid: string) => `https://app.asana.com/0/${SOFTWARE_BOARD_PROJECT_GID}/${gid}`;

/** Escape a value for a single markdown table cell (no pipes / newlines). */
function cell(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** Human one-liner for the fired rule. */
function whyLine(firedRule: string, evidenceFact: FactKey | null): string {
  const fact = evidenceFact ? ` (${evidenceFact})` : '';
  switch (firedRule) {
    case 'not_ui_testable':
      return 'No UI surface to test -> T0';
    case 'cosmetic':
      return 'Cosmetic only, no behaviour change -> T0';
    case 'behavior_preserving':
      return 'Visible but behaviour-preserving -> min(base,T1)';
    case 'restore_approved':
      return 'Restores approved behaviour (logic untouched) -> min(base,T1)';
    case 't2_risk_trigger':
      return `Behaviour change + risk trigger${fact} -> T2`;
    case 'behavior_at_base':
      return `Behaviour change at domain base tier${fact}`;
    case 'inconclusive':
      return 'Inconclusive (unclear signals) -> floored to T1';
    default:
      return firedRule;
  }
}

/** The evidence quote the read-only preview tool would surface. */
function evidenceFor(facts: Facts, decision: Decision): string {
  if (decision.evidenceFact && decision.firedRule !== 'inconclusive') {
    return facts[decision.evidenceFact].evidence ?? '';
  }
  return '';
}

/** Canonical signature of the extracted signals + computed tier — used to detect
 *  drift across repeated stability runs. */
function signalSignature(facts: Facts, tier: string): string {
  const keys: FactKey[] = [
    'ui_testable',
    'behavior_change',
    'cosmetic_only',
    'restores_approved_behavior',
    'money',
    'irreversible_external',
    'data_integrity',
    'access_security',
    'visual_blast_radius',
  ];
  const sig: Record<string, string> = { domain: facts.domain, tier, llmTier: facts.llmTier ?? 'null' };
  for (const k of keys) sig[k] = facts[k].value;
  return JSON.stringify(sig);
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// --- Diversity sampling --------------------------------------------------------

interface Candidate {
  task: AsanaTask;
  typeName: string;
  section: string;
}

/** Round-robin a list across a key, for an even spread. */
function roundRobinBy<T>(list: T[], keyOf: (item: T) => string): T[] {
  const groups = new Map<string, T[]>();
  for (const item of list) {
    const k = keyOf(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(item);
  }
  const keys = [...groups.keys()];
  const cursors = new Map(keys.map((k) => [k, 0]));
  const out: T[] = [];
  let progress = true;
  while (out.length < list.length && progress) {
    progress = false;
    for (const k of keys) {
      const arr = groups.get(k)!;
      const i = cursors.get(k)!;
      if (i < arr.length) {
        out.push(arr[i]);
        cursors.set(k, i + 1);
        progress = true;
      }
    }
  }
  return out;
}

/** Stratified sample: spread across Types, and within each Type across sections.
 *  Deterministic (input is gid-sorted, Maps keep insertion order) so the golden
 *  set is reproducible. */
function diverseSample(cands: Candidate[], target: number): Candidate[] {
  const byType = new Map<string, Candidate[]>();
  for (const c of cands) {
    const k = c.typeName || '(none)';
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k)!.push(c);
  }
  // Within each Type, order candidates so sections alternate.
  const orderedByType = new Map<string, Candidate[]>();
  for (const [t, list] of byType) {
    orderedByType.set(t, roundRobinBy(list, (c) => c.section));
  }
  // Round-robin across Types.
  const typeKeys = [...orderedByType.keys()];
  const cursors = new Map(typeKeys.map((k) => [k, 0]));
  const out: Candidate[] = [];
  let progress = true;
  while (out.length < target && progress) {
    progress = false;
    for (const t of typeKeys) {
      if (out.length >= target) break;
      const list = orderedByType.get(t)!;
      const i = cursors.get(t)!;
      if (i < list.length) {
        out.push(list[i]);
        cursors.set(t, i + 1);
        progress = true;
      }
    }
  }
  return out;
}

// --- Result shapes -------------------------------------------------------------

interface TicketResult {
  index: number;
  taskGid: string;
  url: string;
  name: string;
  typeName: string;
  section: string;
  createdAt: string | undefined;
  completed: boolean;
  domain: string | null;
  tier: string | null;
  baseTier: string | null;
  firedRule: string | null;
  evidenceFact: FactKey | null;
  evidence: string;
  flags: string[];
  liftedByUnclear: boolean | null;
  uncertaintyFloorFired: boolean | null;
  calibrationMismatch: boolean | null;
  llmTier: string | null;
  facts: Facts | null;
  error?: string;
}

interface StabilityRun {
  run: number;
  signature: string;
  drift: string | null; // null on run 1; describes the diff vs run 1 otherwise
}

interface StabilityResult {
  index: number;
  taskGid: string;
  name: string;
  stable: boolean;
  runs: StabilityRun[];
}

// --- Golden eval ---------------------------------------------------------------

/** One committed golden expectation: a fixed ticket gid and the accepted tier(s). */
interface GoldenEntry {
  row: number;
  taskGid: string;
  name: string;
  /** Accepted tiers — PASS when the computed tier is any of these (e.g. `["T0","T1"]`). */
  expected: string[];
  /** Documented miss the team has accepted for now: it does NOT fail the gate, but a
   *  NEW miss on any unflagged row does (ratchet semantics). Remove the flag once the
   *  rubric change that fixes the row lands — the gate nudges when it starts passing. */
  knownMiss: boolean;
}

/** One scored golden row. */
interface GoldenRowResult {
  row: number;
  taskGid: string;
  url: string;
  name: string;
  expected: string[];
  actual: string | null;
  pass: boolean;
  knownMiss: boolean;
  domain: string | null;
  firedRule: string | null;
  evidence: string;
  reason: string;
  error?: string;
}

/** Read + shallow-validate the golden JSON file. */
function readGolden(file: string): GoldenEntry[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error(`golden file ${file} must be a JSON array`);
  return raw.map((e, i) => {
    const g = e as Partial<GoldenEntry>;
    if (!g.taskGid || !Array.isArray(g.expected) || g.expected.length === 0) {
      throw new Error(`golden entry ${i} is missing taskGid or a non-empty expected[]`);
    }
    return {
      row: typeof g.row === 'number' ? g.row : i + 1,
      taskGid: String(g.taskGid),
      name: g.name ?? '',
      expected: g.expected.map(String),
      knownMiss: g.knownMiss === true,
    };
  });
}

/**
 * GOLDEN-EVAL: classify each golden gid with the live extract+decide pipeline, score
 * PASS (computed tier ∈ expected) vs FAIL, print a per-row table + total, write the
 * md/json artifacts, and set exit code 1 if any row FAILS.
 */
async function runGolden(
  goldenFile: string,
  asana: InstanceType<typeof AsanaApiClient>,
  deps: ExtractDeps,
  rubricVersion: number,
  tableMap: DomainBaseTierMap,
  suffix: string,
): Promise<void> {
  const file = path.isAbsolute(goldenFile) ? goldenFile : path.resolve(repoRoot, goldenFile);
  const golden = readGolden(file);
  console.log(`[golden] loaded ${golden.length} golden rows from ${file}`);

  const outMd = path.join(OUT_DIR, `tier-calibration-results${suffix}.md`);
  const outJson = path.join(OUT_DIR, `tier-calibration-results${suffix}.json`);

  const rows: GoldenRowResult[] = await mapWithConcurrency(golden, CLASSIFY_CONCURRENCY, async (g) => {
    const url = asanaTaskUrl(g.taskGid);
    try {
      const t = await asana.getTask(g.taskGid, OPT_FIELDS);
      const tName = typeName(t);
      const input: ExtractInput = { name: t.name ?? '', notes: t.notes ?? '', typeName: tName };
      const facts = await extractFacts(input, deps);
      const decision = decideTier(facts, tableMap);
      const actual = decision.tier;
      const pass = g.expected.includes(actual);
      const reason = `${whyLine(decision.firedRule, decision.evidenceFact)}${decision.flags.length ? ` [${decision.flags.join(',')}]` : ''}`;
      const tag = pass ? (g.knownMiss ? 'PASS (was a known miss — remove knownMiss)' : 'PASS') : g.knownMiss ? 'MISS (known, allowed)' : 'FAIL';
      console.log(
        `[golden] #${g.row} ${g.taskGid} -> ${actual} exp[${g.expected.join('|')}] ${tag} (${decision.firedRule})`,
      );
      return {
        row: g.row,
        taskGid: g.taskGid,
        url,
        name: t.name ?? g.name,
        expected: g.expected,
        knownMiss: g.knownMiss,
        actual,
        pass,
        domain: facts.domain,
        firedRule: decision.firedRule,
        evidence: evidenceFor(facts, decision),
        reason,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[golden] #${g.row} ${g.taskGid} ERROR: ${message}`);
      return {
        row: g.row,
        taskGid: g.taskGid,
        url,
        name: g.name,
        expected: g.expected,
        knownMiss: g.knownMiss,
        actual: null,
        pass: false,
        domain: null,
        firedRule: null,
        evidence: '',
        reason: `ERROR: ${message}`,
        error: message,
      };
    }
  });

  const passCount = rows.filter((r) => r.pass).length;
  const failing = rows.filter((r) => !r.pass);
  const dist = { T0: 0, T1: 0, T2: 0, ERROR: 0 };
  for (const r of rows) {
    if (r.actual === 'T0' || r.actual === 'T1' || r.actual === 'T2') dist[r.actual]++;
    else dist.ERROR++;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outMd, renderGoldenMarkdown({ rubricVersion, file, rows, passCount, dist }));
  fs.writeFileSync(
    outJson,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: 'golden',
        rubricVersion,
        goldenFile: file,
        score: { pass: passCount, total: rows.length },
        distribution: dist,
        failing: failing.map((r) => ({ row: r.row, taskGid: r.taskGid, expected: r.expected, actual: r.actual, reason: r.reason })),
        rows,
      },
      null,
      2,
    ),
  );

  console.log(`\n[golden] score: ${passCount}/${rows.length}`);
  console.log(`[golden] distribution: T0=${dist.T0} T1=${dist.T1} T2=${dist.T2}${dist.ERROR ? ` ERROR=${dist.ERROR}` : ''}`);
  const hardFails = failing.filter((r) => !r.knownMiss);
  const allowedMisses = failing.filter((r) => r.knownMiss);
  if (hardFails.length) {
    console.log(`[golden] FAILING rows (${hardFails.length}) — new misses or regressions:`);
    for (const r of hardFails) {
      console.log(`  #${r.row} ${r.taskGid} got ${r.actual ?? 'ERROR'} expected [${r.expected.join('|')}] — ${r.reason}`);
    }
  }
  if (allowedMisses.length) {
    console.log(`[golden] known misses, allowed (${allowedMisses.length}): ${allowedMisses.map((r) => '#' + r.row).join(' ')}`);
  }
  console.log(`[golden] wrote ${outMd}`);
  console.log(`[golden] wrote ${outJson}`);

  // The regression gate (ratchet): a FAIL on any row NOT flagged knownMiss is a
  // non-zero exit so CI / a merge check catches new misses and regressions, while the
  // documented known misses stay visible without blocking.
  if (hardFails.length) process.exitCode = 1;
}

interface GoldenRenderArgs {
  rubricVersion: number;
  file: string;
  rows: GoldenRowResult[];
  passCount: number;
  dist: { T0: number; T1: number; T2: number; ERROR: number };
}

function renderGoldenMarkdown(a: GoldenRenderArgs): string {
  const lines: string[] = [];
  lines.push('# Delivery Tier Classifier — Golden Eval');
  lines.push('');
  lines.push(`Live extract+decide pipeline scored against the committed golden set. Rubric version ${a.rubricVersion}.`);
  lines.push(`Golden set: \`${a.file}\`.`);
  lines.push(`Generated ${new Date().toISOString()}.`);
  lines.push('');
  lines.push('## Score');
  lines.push('');
  lines.push(`- **${a.passCount}/${a.rows.length} PASS** (${a.rows.length - a.passCount} FAIL)`);
  lines.push(`- Distribution: T0=${a.dist.T0}, T1=${a.dist.T1}, T2=${a.dist.T2}${a.dist.ERROR ? `, ERROR=${a.dist.ERROR}` : ''}`);
  const failing = a.rows.filter((r) => !r.pass);
  if (failing.length) {
    lines.push('');
    lines.push('### Failing rows');
    lines.push('');
    for (const r of failing) {
      lines.push(`- **#${r.row}** [${cell(truncate(r.name, 60))}](${r.url}) — got \`${r.actual ?? 'ERROR'}\`, expected \`[${r.expected.join('|')}]\`. ${cell(r.reason)}`);
    }
  }
  lines.push('');
  lines.push('## Per-row');
  lines.push('');
  lines.push('| # | Ticket | Domain | Expected | Actual | Result | Why (fired rule) | Evidence |');
  lines.push('| - | ------ | ------ | -------- | ------ | ------ | ---------------- | -------- |');
  for (const r of a.rows) {
    lines.push(
      `| ${r.row} ` +
        `| [${cell(truncate(r.name, 55))}](${r.url}) ` +
        `| ${cell(r.domain ?? '')} ` +
        `| ${r.expected.join(' / ')} ` +
        `| ${r.actual ?? 'ERROR'} ` +
        `| ${r.pass ? 'PASS' : 'FAIL'} ` +
        `| ${cell(r.reason)} ` +
        `| ${cell(truncate(r.evidence, EVIDENCE_MAX))} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

// --- Main ----------------------------------------------------------------------

async function main(): Promise<void> {
  const { tasksFile, goldenFile, label } = parseArgs(process.argv.slice(2));
  const suffix = label ? `-${label}` : '';
  const outMd = path.join(OUT_DIR, `tier-calibration-results${suffix}.md`);
  const outJson = path.join(OUT_DIR, `tier-calibration-results${suffix}.json`);

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

  // Read-only Supabase client, purely to SELECT the vault secret. Built directly
  // (not via getSupabase/loadEnv) because loadEnv also requires Slack tokens the
  // calibration .env does not carry.
  const supabase = createClient(supabaseUrl!, supabaseKey!, { auth: { persistSession: false } });
  const asanaToken = await readVaultSecret(supabase, 'ASANA_ACCESS_TOKEN');
  console.log('[calib] vault: ASANA_ACCESS_TOKEN read OK');

  const asana = new AsanaApiClient({ accessToken: asanaToken });
  const claude = new Anthropic({ apiKey: anthropicKey });

  // Build the runtime rubric source: it reads the LIVE Notion page (so the golden
  // eval scores the classifier against exactly what production applies), falling back
  // to the committed snapshot when the Notion token / page is unavailable.
  const standardFile = loadTierStandard();
  const { appendix } = splitStandard(standardFile);
  const fallbackRubric = buildFallbackRubric(standardFile);
  let notionToken: string | null = null;
  try {
    notionToken = await readVaultSecret(supabase, 'NOTION_API_TOKEN');
  } catch {
    console.warn('[calib] NOTION_API_TOKEN not readable — using committed fallback rubric');
  }
  const rubricSource = new RubricSource({
    pageId: DELIVERY_TIER_RUBRIC_PAGE_ID,
    appendix,
    fallback: fallbackRubric,
    notion: notionToken ? new NotionApiClient({ token: notionToken }) : undefined,
  });
  await rubricSource.init();
  // Force a live pull so `--golden` evaluates against the current page, not just the
  // boot cache.
  await rubricSource.refresh({ notify: false });
  const rubric = rubricSource.getRubric();
  const rubricVersion = rubric.version;
  const deps: ExtractDeps = { claude, prompt: rubric.promptText };
  console.log(`[calib] rubric version ${rubricVersion} (hash ${rubric.hash.slice(0, 8)}) loaded from live page`);

  // GOLDEN-EVAL mode: score the live classifier against the committed golden set and
  // exit non-zero on any FAIL. This is the regression gate — no board scan / sampling.
  if (goldenFile) {
    await runGolden(goldenFile, asana, deps, rubricVersion, rubric.tableMap, suffix);
    return;
  }

  // 1. Build the sample. Either replay a fixed gid list (`--tasks`, identical set
  //    across runs) or run the full-history board scan + diversity sample.
  let tasksScanned: number;
  let candidateCount: number;
  let sample: Candidate[];

  if (tasksFile) {
    const gids = readTaskGids(tasksFile);
    console.log(`[calib] fixed task set: ${gids.length} gids from ${tasksFile}`);
    // Fetch each task by gid with the same opt_fields, preserving file order so the
    // per-ticket indices line up with the prior run. Read-only GETs.
    const fetched = await mapWithConcurrency(gids, CLASSIFY_CONCURRENCY, (gid) =>
      asana.getTask(gid, OPT_FIELDS),
    );
    sample = fetched.map((t) => ({ task: t, typeName: typeName(t) || '(none)', section: sectionName(t) }));
    tasksScanned = fetched.length;
    candidateCount = gids.length;
    console.log(`[calib] fetched ${sample.length} tickets by gid (no board scan / sampling)`);
  } else {
    // Full-history board scan (unbounded), then the candidate gate.
    const tasks = await asana.getProjectTasksUnbounded(SOFTWARE_BOARD_PROJECT_GID, OPT_FIELDS);
    console.log(`[calib] scanned ${tasks.length} board tasks`);

    const cutoffMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const candidates: Candidate[] = tasks
      .filter((t) => {
        if (isFeatureTemplateTask(t)) return false; // exclude the template artifact
        const createdMs = t.created_at ? Date.parse(t.created_at) : Number.NEGATIVE_INFINITY;
        if (!(createdMs >= cutoffMs)) return false; // last ~60 days
        if ((t.notes ?? '').trim().length < MIN_NOTES_CHARS) return false; // substantive
        if (isTierExcludedType(typeName(t))) return false; // Not a Bug / Qa Work / Research
        return true; // completed AND incomplete both kept
      })
      // Deterministic order for a reproducible sample.
      .sort((a, b) => a.gid.localeCompare(b.gid))
      .map((t) => ({ task: t, typeName: typeName(t) || '(none)', section: sectionName(t) }));

    console.log(`[calib] ${candidates.length} candidates in the last ${WINDOW_DAYS} days`);
    sample = diverseSample(candidates, SAMPLE_SIZE);
    tasksScanned = tasks.length;
    candidateCount = candidates.length;
    console.log(`[calib] sampled ${sample.length} tickets across types/sections`);
  }

  const typeSpread = tally(sample.map((c) => c.typeName));
  const sectionSpread = tally(sample.map((c) => c.section));
  console.log('[calib] type spread:', typeSpread);
  console.log('[calib] section spread:', sectionSpread);

  // 2. Classify each sampled ticket (extract ticket-text facts -> decide). Errors
  // are captured per ticket so one bad ticket never kills the run.
  const results: TicketResult[] = await mapWithConcurrency(sample, CLASSIFY_CONCURRENCY, async (c, i) => {
    const t = c.task;
    const base: TicketResult = {
      index: i + 1,
      taskGid: t.gid,
      url: asanaTaskUrl(t.gid),
      name: t.name ?? '(unnamed)',
      typeName: c.typeName,
      section: c.section,
      createdAt: t.created_at,
      completed: Boolean(t.completed),
      domain: null,
      tier: null,
      baseTier: null,
      firedRule: null,
      evidenceFact: null,
      evidence: '',
      flags: [],
      liftedByUnclear: null,
      uncertaintyFloorFired: null,
      calibrationMismatch: null,
      llmTier: null,
      facts: null,
    };
    try {
      const input: ExtractInput = { name: t.name ?? '', notes: t.notes ?? '', typeName: c.typeName === '(none)' ? '' : c.typeName };
      const facts = await extractFacts(input, deps);
      const decision = decideTier(facts);
      console.log(`[calib] #${i + 1} ${t.gid} -> ${decision.tier} (${decision.firedRule})`);
      return {
        ...base,
        domain: facts.domain,
        tier: decision.tier,
        baseTier: decision.baseTier,
        firedRule: decision.firedRule,
        evidenceFact: decision.evidenceFact,
        evidence: evidenceFor(facts, decision),
        flags: decision.flags,
        liftedByUnclear: decision.liftedByUnclear,
        uncertaintyFloorFired: decision.liftedByUnclear,
        calibrationMismatch: decision.calibrationMismatch,
        llmTier: facts.llmTier,
        facts,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[calib] #${i + 1} ${t.gid} ERROR: ${message}`);
      return { ...base, error: message };
    }
  });

  // 3. Stability check: first N tickets, classified STABILITY_RUNS times each.
  const stability: StabilityResult[] = [];
  for (const c of sample.slice(0, STABILITY_TICKETS)) {
    const t = c.task;
    const idx = sample.indexOf(c) + 1;
    const input: ExtractInput = { name: t.name ?? '', notes: t.notes ?? '', typeName: c.typeName === '(none)' ? '' : c.typeName };
    const runs: StabilityRun[] = [];
    let baseline = '';
    for (let r = 1; r <= STABILITY_RUNS; r++) {
      try {
        const facts = await extractFacts(input, deps);
        const decision = decideTier(facts);
        const signature = signalSignature(facts, decision.tier);
        if (r === 1) baseline = signature;
        const drift = r === 1 ? null : signature === baseline ? null : describeDrift(baseline, signature);
        runs.push({ run: r, signature, drift });
        console.log(`[calib] stability #${idx} run ${r} -> ${decision.tier}${drift ? ' DRIFT' : ''}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        runs.push({ run: r, signature: `ERROR: ${message}`, drift: `ERROR: ${message}` });
        console.error(`[calib] stability #${idx} run ${r} ERROR: ${message}`);
      }
    }
    const stable = runs.every((rr) => rr.drift === null);
    stability.push({ index: idx, taskGid: t.gid, name: t.name ?? '(unnamed)', stable, runs });
  }

  // 4. Summaries.
  const tierDist = { T0: 0, T1: 0, T2: 0, ERROR: 0 };
  let mismatchCount = 0;
  let unclearLiftCount = 0;
  for (const r of results) {
    if (r.error) tierDist.ERROR++;
    else if (r.tier === 'T0' || r.tier === 'T1' || r.tier === 'T2') tierDist[r.tier]++;
    if (r.calibrationMismatch) mismatchCount++;
    if (r.uncertaintyFloorFired) unclearLiftCount++;
  }
  const allStable = stability.length > 0 && stability.every((s) => s.stable);
  const stabilityVerdict = stability.length === 0
    ? 'not run'
    : allStable
      ? `STABLE (${STABILITY_TICKETS} tickets x ${STABILITY_RUNS} runs, identical signals+tier)`
      : `DRIFT DETECTED in ${stability.filter((s) => !s.stable).length}/${stability.length} tickets`;

  // 5. Emit markdown + JSON.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outMd, renderMarkdown({
    rubricVersion,
    scanned: tasksScanned,
    candidateCount,
    sampleSize: sample.length,
    tierDist,
    mismatchCount,
    unclearLiftCount,
    stabilityVerdict,
    typeSpread,
    sectionSpread,
    results,
    stability,
  }));
  fs.writeFileSync(outJson, JSON.stringify({
    generatedAt: new Date().toISOString(),
    rubricVersion,
    windowDays: WINDOW_DAYS,
    scanned: tasksScanned,
    candidateCount,
    sampleSize: sample.length,
    summary: { tierDist, mismatchCount, unclearLiftCount, stabilityVerdict },
    typeSpread,
    sectionSpread,
    tickets: results,
    stability,
  }, null, 2));

  console.log(`\n[calib] tier distribution: T0=${tierDist.T0} T1=${tierDist.T1} T2=${tierDist.T2} ERROR=${tierDist.ERROR}`);
  console.log(`[calib] calibration mismatches: ${mismatchCount} | uncertainty-floor lifts: ${unclearLiftCount}`);
  console.log(`[calib] stability: ${stabilityVerdict}`);
  console.log(`[calib] wrote ${outMd}`);
  console.log(`[calib] wrote ${outJson}`);
}

/** Count occurrences of each value, insertion-ordered. */
function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Describe which signal fields differ between two signatures. */
function describeDrift(baseline: string, other: string): string {
  const a = JSON.parse(baseline) as Record<string, string>;
  const b = JSON.parse(other) as Record<string, string>;
  const diffs: string[] = [];
  for (const k of Object.keys(a)) {
    if (a[k] !== b[k]) diffs.push(`${k}: ${a[k]}->${b[k]}`);
  }
  return diffs.length ? diffs.join(', ') : 'signature differs';
}

interface RenderArgs {
  rubricVersion: number;
  scanned: number;
  candidateCount: number;
  sampleSize: number;
  tierDist: { T0: number; T1: number; T2: number; ERROR: number };
  mismatchCount: number;
  unclearLiftCount: number;
  stabilityVerdict: string;
  typeSpread: Record<string, number>;
  sectionSpread: Record<string, number>;
  results: TicketResult[];
  stability: StabilityResult[];
}

function renderMarkdown(a: RenderArgs): string {
  const spread = (m: Record<string, number>) =>
    Object.entries(m).map(([k, v]) => `${k}: ${v}`).join(', ');

  const lines: string[] = [];
  lines.push('# Delivery Tier Classifier — Retro-Calibration');
  lines.push('');
  lines.push(`Read-only run against real Software Board tickets. Rubric version ${a.rubricVersion}.`);
  lines.push(`Generated ${new Date().toISOString()}.`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Board tasks scanned: ${a.scanned}`);
  lines.push(`- Candidates (last ${WINDOW_DAYS}d, notes>=${MIN_NOTES_CHARS}, excl template/Not-a-Bug/Qa-Work/Research): ${a.candidateCount}`);
  lines.push(`- Sampled (diverse Types x sections): ${a.sampleSize}`);
  lines.push(`- **Tier distribution:** T0=${a.tierDist.T0}, T1=${a.tierDist.T1}, T2=${a.tierDist.T2}${a.tierDist.ERROR ? `, ERROR=${a.tierDist.ERROR}` : ''}`);
  lines.push(`- **Calibration mismatches (LLM tier != code tier):** ${a.mismatchCount}`);
  lines.push(`- **Uncertainty-floor lifts (unclear -> T1):** ${a.unclearLiftCount}`);
  lines.push(`- **Stability:** ${a.stabilityVerdict}`);
  lines.push(`- Type spread: ${spread(a.typeSpread)}`);
  lines.push(`- Section spread: ${spread(a.sectionSpread)}`);
  lines.push('');
  lines.push('## Per-ticket');
  lines.push('');
  lines.push('| # | Ticket | Type | Domain | Tier | Why (fired rule) | Evidence | Flags | LLM!=code? |');
  lines.push('| - | ------ | ---- | ------ | ---- | ---------------- | -------- | ----- | ---------- |');
  for (const r of a.results) {
    if (r.error) {
      lines.push(
        `| ${r.index} | [${cell(truncate(r.name, 60))}](${r.url}) | ${cell(r.typeName)} | ERROR | ERROR | ${cell(truncate(r.error, 70))} | | | |`,
      );
      continue;
    }
    const why = r.firedRule ? whyLine(r.firedRule, r.evidenceFact) : '';
    const llmCol = r.calibrationMismatch ? `yes (llm ${r.llmTier ?? '?'})` : 'no';
    lines.push(
      `| ${r.index} ` +
        `| [${cell(truncate(r.name, 60))}](${r.url}) ` +
        `| ${cell(r.typeName)} ` +
        `| ${cell(r.domain ?? '')} ` +
        `| ${r.tier ?? ''} ` +
        `| ${cell(why)} ` +
        `| ${cell(truncate(r.evidence, EVIDENCE_MAX))} ` +
        `| ${cell(r.flags.join(', '))} ` +
        `| ${llmCol} |`,
    );
  }
  lines.push('');
  lines.push('## Stability check');
  lines.push('');
  lines.push(`First ${a.stability.length} sampled tickets, classified ${STABILITY_RUNS}x each (temperature 0).`);
  lines.push('');
  for (const s of a.stability) {
    lines.push(`### #${s.index} — ${cell(truncate(s.name, 70))} (${s.taskGid})`);
    lines.push('');
    lines.push(`Verdict: ${s.stable ? 'STABLE (identical signals+tier across all runs)' : 'DRIFT'}`);
    for (const run of s.runs) {
      if (run.drift) lines.push(`- run ${run.run}: DRIFT — ${cell(run.drift)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

main().catch((err) => {
  console.error('[calib] fatal:', err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
