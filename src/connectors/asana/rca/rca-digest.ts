import type { WebClient } from '@slack/web-api';
import type { AsanaApiClient, AsanaStory, AsanaTask } from '../client.js';
import type { RcaDigestsRepo } from '../../../storage/repositories/rca-digests.js';
import { mapWithConcurrency } from '../concurrency.js';
import {
  SOFTWARE_BOARD_PROJECT_GID,
  TYPE_FIELD_GID,
  asanaTaskUrl,
  isBugTask,
  isFeatureTemplateTask,
  isInDone,
} from '../board-config.js';
import { parseSectionMove } from '../story-analyzer.js';
import { logger } from '../../../logger.js';

/**
 * RCA reminder digest. A bug that reaches Done owes a root-cause analysis, and
 * the board records that as subtasks ("Engineering Escape RCA", "QA Escape RCA",
 * or the older "Root cause analysis"). Nobody notices when they stay unchecked,
 * so twice a day — 08:00 and 16:00 America/New_York — the bot posts ONE message
 * to the software channel listing every closed bug whose RCA subtasks are still
 * open.
 *
 * Deliberately a digest and not a per-ticket alert: the goal is a standing list
 * people can work off, not a notification every time someone closes a ticket.
 *
 * Delivery is idempotent through `rca_digests` (one row per slot), so the tick
 * cadence can be anything faster than the slot spacing, and a restart mid-slot
 * never double-posts.
 */

/** The two daily send times, as New York local hours. */
export const DIGEST_HOURS = [8, 16] as const;

const DIGEST_TZ = 'America/New_York';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Default statute of limitations: bugs closed longer ago than this drop off the
 *  list. Without it the digest would nag about tickets from years back forever. */
export const DEFAULT_LOOKBACK_DAYS = 30;
/** Max tickets rendered in the message; the rest collapse into a "+N more" line. */
const MAX_RENDERED = 20;
/** Subtask fetches in flight. Asana rate-limits fan-out hard. */
const SUBTASK_CONCURRENCY = 4;

/** opt_fields for the board scan: enough to decide done-ness, bug-ness, recency,
 *  and who to nudge — without a second read per task. */
const OPT_FIELDS_TASK = [
  'name',
  'completed',
  'completed_at',
  'modified_at',
  'num_subtasks',
  'assignee.name',
  'assignee.email',
  'custom_fields.gid',
  'custom_fields.enum_value.gid',
  'custom_fields.enum_value.name',
  'memberships.section.gid',
].join(',');

const OPT_FIELDS_SUBTASK = 'name,completed';

/** Just enough to find the section move that landed a ticket in Done. */
const OPT_FIELDS_STORY = 'created_at,resource_subtype,text';

/** The Done section's display name, as it appears in section-move story text. */
const DONE_SECTION_NAME = 'Done';

// --- Slot scheduling (pure) -------------------------------------------------

interface NyParts {
  y: number;
  m: number;
  d: number;
  hour: number;
}

function nyParts(d: Date): NyParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: DIGEST_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    // Intl renders midnight as "24" in some runtimes; normalize to 0.
    hour: Number(parts.hour) % 24,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The slot that is currently due, or null before the day's first send time.
 * Only the MOST RECENT elapsed slot is returned — a bot that was down all
 * morning sends the afternoon digest when it comes back, it does not replay the
 * morning one.
 */
export function dueSlotKey(now: Date): string | null {
  const p = nyParts(now);
  const elapsed = DIGEST_HOURS.filter((h) => p.hour >= h);
  if (elapsed.length === 0) return null;
  const hour = elapsed[elapsed.length - 1];
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}:${pad2(hour)}`;
}

// --- RCA subtask matching (pure) --------------------------------------------

/** Subtask names that ARE the root-cause analysis. The board has accumulated
 *  several spellings over time — the current template writes "Engineering Escape
 *  RCA" / "QA Escape RCA", older tickets carry "Root cause analysis" or just
 *  "Root Cause" — so match the concept, not one exact string. */
const RCA_NAME_RE = /\brca\b|root\s*cause/i;

export type RcaKind = 'engineering' | 'qa' | 'general';

export interface OpenRca {
  /** The subtask name as it reads on the board. */
  name: string;
  kind: RcaKind;
}

/** Classify an RCA subtask by which half of the analysis it covers. Anything
 *  that names neither discipline (the legacy single "Root cause analysis"
 *  subtask) is `general`. */
export function rcaKind(name: string): RcaKind {
  if (/engineering|\beng\b/i.test(name)) return 'engineering';
  if (/\bqa\b|quality/i.test(name)) return 'qa';
  return 'general';
}

/** The unchecked RCA subtasks of a task, in board order. Empty when the task has
 *  no RCA subtasks at all, or when every one of them is already done. */
export function openRcaSubtasks(subtasks: { name?: string; completed?: boolean }[]): OpenRca[] {
  return subtasks
    .filter((s) => RCA_NAME_RE.test(s.name ?? '') && !s.completed)
    .map((s) => ({ name: (s.name ?? '').trim(), kind: rcaKind(s.name ?? '') }));
}

// --- Digest computation (pure) ----------------------------------------------

export interface RcaDigestEntry {
  taskGid: string;
  name: string;
  url: string;
  /** Type custom-field option name, or null when the ticket has no Type set. */
  type: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
  /** When the ticket reached Done, ISO. */
  doneAt: string;
  /** True when `doneAt` is the last-modified fallback (the ticket sits in the
   *  Done section but nobody ticked the completion checkbox). */
  doneAtApproximate: boolean;
  daysSinceDone: number;
  openRcas: OpenRca[];
}

export interface RcaDigestPayload {
  slotKey: string;
  entries: RcaDigestEntry[];
  /** Board tasks scanned, for the log line. */
  scanned: number;
}

export interface DoneAt {
  at: string;
  /** True when `at` is the last-modified fallback rather than a real completion
   *  or section-move timestamp — the rendered age hedges accordingly. */
  approximate: boolean;
}

/**
 * A CHEAP upper bound on when a ticket reached Done, with no extra API call.
 * `completed_at` is exact. A ticket parked in the Done section without the
 * completion checkbox has no such stamp, and `modified_at` stands in — it is a
 * genuine upper bound (a move cannot postdate the last modification), which is
 * what makes it safe to pre-filter on before the exact resolution below.
 */
export function doneTimestamp(task: AsanaTask): DoneAt | null {
  if (task.completed_at) return { at: task.completed_at, approximate: false };
  if (task.modified_at) return { at: task.modified_at, approximate: true };
  return null;
}

/**
 * The timestamp of the most recent "moved … to Done" story on a task, or null
 * when the board history has none. This is the exact answer for tickets parked
 * in Done without the completion checkbox, where `modified_at` would otherwise
 * date the ticket by its last EDIT — enough to sneak a long-parked ticket past a
 * same-day cutoff just because someone touched it this morning.
 */
export function lastMoveToDoneAt(stories: AsanaStory[]): string | null {
  let latest: string | null = null;
  for (const s of stories) {
    if (s.resource_subtype !== 'section_changed' || !s.created_at) continue;
    const move = parseSectionMove(s.text);
    if (move?.to !== DONE_SECTION_NAME) continue;
    if (!latest || Date.parse(s.created_at) > Date.parse(latest)) latest = s.created_at;
  }
  return latest;
}

function typeNameOf(task: AsanaTask): string | null {
  const cf = (task.custom_fields ?? []).find((f) => f.gid === TYPE_FIELD_GID);
  return cf?.enum_value?.name ?? null;
}

export interface RcaCandidate {
  task: AsanaTask;
  subtasks: { name?: string; completed?: boolean }[];
  /** The resolved done timestamp — exact where the board history allows. */
  doneAt: DoneAt;
}

/** Assemble the payload from candidates already paired with their subtasks and a
 *  resolved done timestamp. Pure, so the whole selection rule — including the
 *  cutoff — is testable without touching Asana. */
export function computeRcaDigest(
  slotKey: string,
  scanned: number,
  candidates: RcaCandidate[],
  now: Date,
  cutoffMs: number,
): RcaDigestPayload {
  const entries: RcaDigestEntry[] = [];
  for (const { task, subtasks, doneAt: done } of candidates) {
    const openRcas = openRcaSubtasks(subtasks);
    if (openRcas.length === 0) continue;
    // Re-applied here and not only in the scan gate: the exact done timestamp is
    // resolved AFTER the cheap pre-filter, and it can only move earlier.
    if (Date.parse(done.at) < cutoffMs) continue;
    entries.push({
      taskGid: task.gid,
      name: task.name,
      url: asanaTaskUrl(task.gid),
      type: typeNameOf(task),
      assigneeName: task.assignee?.name ?? null,
      assigneeEmail: task.assignee?.email ?? null,
      doneAt: done.at,
      doneAtApproximate: done.approximate,
      daysSinceDone: Math.max(0, Math.floor((now.getTime() - Date.parse(done.at)) / DAY_MS)),
      openRcas,
    });
  }
  // Oldest first: the ticket that has been sitting unanalysed the longest is the
  // one most likely to be forgotten.
  entries.sort((a, b) => b.daysSinceDone - a.daysSinceDone || a.taskGid.localeCompare(b.taskGid));
  return { slotKey, entries, scanned };
}

// --- Rendering (pure) -------------------------------------------------------

function ageLabel(entry: RcaDigestEntry): string {
  const d = entry.daysSinceDone;
  const base = d === 0 ? 'closed today' : d === 1 ? 'closed yesterday' : `closed ${d}d ago`;
  return entry.doneAtApproximate ? `in Done ${d === 0 ? 'today' : `${d}d`}` : base;
}

function rcaLabel(rca: OpenRca): string {
  return rca.name;
}

/**
 * Render the digest as a Slack message. Returns null when nothing is
 * outstanding — an all-clear ping twice a day is noise, so the slot is recorded
 * as delivered without posting.
 */
export function renderRcaDigest(
  payload: RcaDigestPayload,
  mentionFor: (entry: RcaDigestEntry) => string | null,
): string | null {
  const { entries } = payload;
  if (entries.length === 0) return null;

  const lines: string[] = [];
  const noun = entries.length === 1 ? 'bug' : 'bugs';
  lines.push(`🔍 *RCA follow-ups* — ${entries.length} closed ${noun} still owe a root cause analysis`);
  lines.push('');

  for (const e of entries.slice(0, MAX_RENDERED)) {
    const meta = [e.type, ageLabel(e)].filter(Boolean).join(' · ');
    // Labelled, because the assignee on a bug ticket is often whoever filed or
    // verified it rather than whoever owes the engineering half of the analysis.
    const who = mentionFor(e);
    lines.push(`• <${e.url}|${slackEscape(e.name)}> — ${meta}${who ? ` · assignee: ${who}` : ''}`);
    lines.push(`    ↳ open: ${e.openRcas.map(rcaLabel).join(', ')}`);
  }

  if (entries.length > MAX_RENDERED) {
    lines.push(`• _…and ${entries.length - MAX_RENDERED} more._`);
  }
  return lines.join('\n');
}

/** Slack link labels break on raw `<`, `>` and `&`. */
function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Orchestration (I/O) ----------------------------------------------------

export interface RcaDigestDeps {
  client: AsanaApiClient;
  repo: RcaDigestsRepo;
  slack: WebClient;
  /** The software channel the digest is posted to. */
  channelId: string;
  /** Bugs closed longer ago than this are dropped. Default 30 days. */
  lookbackDays?: number;
  /** Hard floor: nothing that reached Done before this instant is ever listed,
   *  no matter how wide the rolling window is. This is what keeps the rollout
   *  from opening with a wall of historical backlog. */
  startAtMs?: number;
  /** Asana assignee email → Slack user id, for @-mentions. Optional: without it
   *  the digest falls back to the assignee's Asana display name. */
  resolveSlackIdsByEmail?: () => Promise<Map<string, string>>;
  now?: () => Date;
}

export interface RcaDigestResult {
  sent: boolean;
  reason?: 'not_due' | 'already_sent' | 'all_clear';
  slotKey: string | null;
  tickets: number;
}

export class RcaDigestReporter {
  constructor(private readonly deps: RcaDigestDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Post the digest if a slot is due and has not been delivered yet. */
  async maybeSend(): Promise<RcaDigestResult> {
    const now = this.now();
    const slotKey = dueSlotKey(now);
    if (!slotKey) return { sent: false, reason: 'not_due', slotKey: null, tickets: 0 };

    const existing = await this.deps.repo.get(slotKey);
    if (existing) return { sent: false, reason: 'already_sent', slotKey, tickets: 0 };

    const payload = await this.collect(slotKey, now);
    const mentions = await this.mentionMap();
    const text = renderRcaDigest(payload, (e) => {
      const slackId = e.assigneeEmail ? mentions.get(e.assigneeEmail.toLowerCase()) : undefined;
      if (slackId) return `<@${slackId}>`;
      return e.assigneeName;
    });

    if (text) {
      await this.deps.slack.chat.postMessage({
        channel: this.deps.channelId,
        text,
        unfurl_links: false,
      });
    }
    // Record the slot either way — an all-clear slot is still delivered, and
    // without the row the runner would rescan the whole board every tick.
    await this.deps.repo.insert(slotKey, payload.entries.length, payload);
    logger.info(
      { slotKey, tickets: payload.entries.length, scanned: payload.scanned, posted: !!text },
      'rca_digest_sent',
    );
    return {
      sent: !!text,
      reason: text ? undefined : 'all_clear',
      slotKey,
      tickets: payload.entries.length,
    };
  }

  /**
   * The instant before which nothing is listed: the later of the rolling
   * lookback window and the hard rollout floor. The floor dominates right after
   * launch (no historical backlog wall); once it ages past the window, the
   * window takes over and bounds how long a ticket can be nagged about.
   */
  cutoffMs(now: Date): number {
    const lookbackMs = (this.deps.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * DAY_MS;
    return Math.max(now.getTime() - lookbackMs, this.deps.startAtMs ?? 0);
  }

  /** Scan the board and pair every candidate with its subtasks and done time. */
  private async collect(slotKey: string, now: Date): Promise<RcaDigestPayload> {
    const cutoff = this.cutoffMs(now);
    // Unbounded: the board keeps completed tasks, so the 50-page cap would drop
    // exactly the recently-closed tickets this digest is about.
    const tasks = await this.deps.client.getProjectTasksUnbounded(
      SOFTWARE_BOARD_PROJECT_GID,
      OPT_FIELDS_TASK,
    );
    const candidates = tasks.filter((t) => this.isCandidate(t, cutoff));
    const paired = await mapWithConcurrency(candidates, SUBTASK_CONCURRENCY, async (task) => {
      const [subtasks, doneAt] = await Promise.all([
        this.subtasksOf(task),
        this.resolveDoneAt(task),
      ]);
      return { task, subtasks, doneAt };
    });
    return computeRcaDigest(slotKey, tasks.length, paired, now, cutoff);
  }

  private async subtasksOf(task: AsanaTask): Promise<{ name?: string; completed?: boolean }[]> {
    try {
      return await this.deps.client.getTaskSubtasks(task.gid, OPT_FIELDS_SUBTASK);
    } catch (err) {
      logger.warn(
        { taskGid: task.gid, err: err instanceof Error ? err.message : String(err) },
        'rca_digest_subtask_fetch_failed',
      );
      return [];
    }
  }

  /**
   * Pin down when the ticket actually reached Done. `completed_at` is exact and
   * needs no extra call. For a ticket parked in the Done section WITHOUT the
   * completion checkbox, the cheap stand-in is `modified_at` — which dates the
   * ticket by its last edit, so a long-parked ticket someone merely touched this
   * morning would clear a same-day cutoff. Those tickets get a stories read and
   * the real "moved … to Done" timestamp.
   */
  private async resolveDoneAt(task: AsanaTask): Promise<DoneAt> {
    const cheap = doneTimestamp(task)!; // isCandidate already rejected the null case
    if (!cheap.approximate) return cheap;
    try {
      const stories = await this.deps.client.getTaskStories(task.gid, OPT_FIELDS_STORY);
      const movedAt = lastMoveToDoneAt(stories);
      if (movedAt) return { at: movedAt, approximate: false };
    } catch (err) {
      logger.warn(
        { taskGid: task.gid, err: err instanceof Error ? err.message : String(err) },
        'rca_digest_story_fetch_failed',
      );
    }
    return cheap;
  }

  /** Closed-bug gate. Cheap and I/O-free, so the expensive subtask fan-out only
   *  runs over tickets that could possibly owe an RCA. */
  private isCandidate(task: AsanaTask, cutoffMs: number): boolean {
    if (isFeatureTemplateTask(task)) return false;
    if (!task.completed && !isInDone(task)) return false;
    if (!isBugTask(task)) return false;
    // No subtasks at all → no RCA subtask to be missing. Saves a read per ticket.
    if (task.num_subtasks !== undefined && task.num_subtasks <= 0) return false;
    const done = doneTimestamp(task);
    if (!done) return false;
    return Date.parse(done.at) >= cutoffMs;
  }

  private async mentionMap(): Promise<Map<string, string>> {
    if (!this.deps.resolveSlackIdsByEmail) return new Map();
    try {
      return await this.deps.resolveSlackIdsByEmail();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'rca_digest_mention_map_failed',
      );
      return new Map();
    }
  }
}
