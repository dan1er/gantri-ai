import {
  BOARD_NAME,
  BOUNCE_TARGET_SECTIONS,
  QA_STAGE_SECTIONS,
  REOPEN_FROM_SECTIONS,
  REOPEN_TO_SECTIONS,
  TYPE_FEATURE_OPTION_GID,
  TYPE_FIELD_GID,
} from './board-config.js';
import type { AsanaStory, AsanaTask } from './client.js';

/**
 * Pure, HTTP-free parsing of Asana task stories into QA-stage events and
 * bounces. Everything here is deterministic and unit-testable without a client.
 *
 * WINDOW SEMANTICS: callers pass the analysis window as UTC millisecond bounds
 * (inclusive on both ends). `pacificWindowToUtcMs` converts a
 * {startDate, endDate} (YYYY-MM-DD, interpreted as America/Los_Angeles wall
 * clock: [start 00:00:00.000, end 23:59:59.999]) into those bounds.
 */

const HOUR_MS = 60 * 60 * 1000;
const EVIDENCE_WINDOW_TIGHT_MS = 2 * HOUR_MS; // any comment within ±2h
const EVIDENCE_WINDOW_SAME_AUTHOR_MS = 36 * HOUR_MS; // same author within ±36h
const MAX_EVIDENCE_PER_BOUNCE = 6;
const EVIDENCE_CHAR_CAP = 600;

/** A single backward move that kicked a feature out of a QA stage (or reopened
 *  a completed one). `from`/`to` are Software Board section names. */
export interface Bounce {
  by: string;
  from: string;
  to: string;
  /** ISO timestamp of the section_changed story. */
  at: string;
  evidenceComments: string[];
}

export interface FeatureAnalysis {
  gid: string;
  name: string;
  url: string;
  /** True iff the feature had ≥1 QA-stage event inside the window (denominator). */
  hasQaActivityInWindow: boolean;
  /** In-window bounces (backward moves / reopens). */
  bounces: Bounce[];
  /** Union of `bounce.by` across in-window bounces. */
  finders: string[];
}

/** True iff the task's Type custom field resolves to the "Feature" enum option. */
export function isFeatureTask(task: AsanaTask): boolean {
  const cf = task.custom_fields ?? [];
  const type = cf.find((f) => f.gid === TYPE_FIELD_GID);
  return type?.enum_value?.gid === TYPE_FEATURE_OPTION_GID;
}

/** Parse a `section_changed` story text into `{ from, to }` — but ONLY when the
 *  move happened in the Software Board (a task may live on several projects and
 *  we must ignore moves in the others). Returns null otherwise.
 *
 *  Text shape (verified live): `<Name> moved this task from "A" to "B" in Software Board`. */
export function parseSectionMove(text: string | undefined): { from: string; to: string } | null {
  if (!text) return null;
  const suffix = ` in ${BOARD_NAME}`;
  if (!text.endsWith(suffix)) return null;
  const m = /\bmoved this task from "(.+?)" to "(.+?)" in /.exec(text);
  if (!m) return null;
  return { from: m[1], to: m[2] };
}

interface MoveEvent {
  by: string;
  from: string;
  to: string;
  atMs: number;
  atIso: string;
}
interface CommentEvent {
  by: string;
  text: string;
  atMs: number;
}

/** A section move is a QA-stage event when it touches a QA stage (in either
 *  direction) or is a reopen out of a terminal section. */
function isQaStageMove(from: string, to: string): boolean {
  if (QA_STAGE_SECTIONS.includes(from) || QA_STAGE_SECTIONS.includes(to)) return true;
  if (REOPEN_FROM_SECTIONS.includes(from) && REOPEN_TO_SECTIONS.includes(to)) return true;
  return false;
}

/** A QA-stage move is a BOUNCE when it is a backward move out of a QA stage, or
 *  a reopen out of a terminal section. */
function isBounceMove(from: string, to: string): boolean {
  if (QA_STAGE_SECTIONS.includes(from) && BOUNCE_TARGET_SECTIONS.includes(to)) return true;
  if (REOPEN_FROM_SECTIONS.includes(from) && REOPEN_TO_SECTIONS.includes(to)) return true;
  return false;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Analyze one feature's stories against a UTC window.
 *
 * @param task     the feature task (name/url pulled from here)
 * @param stories  all of the task's stories (any order)
 * @param startMs  inclusive UTC window start
 * @param endMs    inclusive UTC window end
 */
export function analyzeFeature(
  task: AsanaTask,
  stories: AsanaStory[],
  startMs: number,
  endMs: number,
): FeatureAnalysis {
  const moves: MoveEvent[] = [];
  const comments: CommentEvent[] = [];
  // marked_complete precedes a marked_incomplete reopen — we only treat an
  // un-complete as a reopen when the task had actually been completed first.
  let hadCompletion = false;
  const rawIncompletes: Array<{ by: string; atMs: number; atIso: string }> = [];

  for (const s of stories) {
    const atMs = s.created_at ? Date.parse(s.created_at) : NaN;
    if (Number.isNaN(atMs)) continue;
    const by = s.created_by?.name ?? '(unknown)';
    switch (s.resource_subtype) {
      case 'section_changed': {
        const move = parseSectionMove(s.text);
        if (move) moves.push({ by, from: move.from, to: move.to, atMs, atIso: s.created_at as string });
        break;
      }
      case 'comment_added': {
        if (s.text) comments.push({ by, text: s.text, atMs });
        break;
      }
      case 'marked_complete':
        hadCompletion = true;
        break;
      case 'marked_incomplete':
        rawIncompletes.push({ by, atMs, atIso: s.created_at as string });
        break;
      default:
        break;
    }
  }

  // QA-stage events (for the in-scope denominator): any qualifying move, plus a
  // genuine un-complete of a previously-completed task.
  let hasQaActivityInWindow = false;
  for (const mv of moves) {
    if (isQaStageMove(mv.from, mv.to) && mv.atMs >= startMs && mv.atMs <= endMs) {
      hasQaActivityInWindow = true;
      break;
    }
  }

  // Move-based bounces.
  const bounces: Bounce[] = [];
  for (const mv of moves) {
    if (mv.atMs < startMs || mv.atMs > endMs) continue;
    if (!isBounceMove(mv.from, mv.to)) continue;
    bounces.push({
      by: mv.by,
      from: mv.from,
      to: mv.to,
      at: mv.atIso,
      evidenceComments: gatherEvidence(mv.by, mv.atMs, comments),
    });
  }

  // Un-complete reopens (only when the task had been completed, and not already
  // captured by a near-simultaneous section-move reopen by the same person).
  if (hadCompletion) {
    for (const inc of rawIncompletes) {
      if (inc.atMs < startMs || inc.atMs > endMs) continue;
      const dupOfMove = bounces.some(
        (b) => b.by === inc.by && Math.abs(Date.parse(b.at) - inc.atMs) <= 2 * 60 * 1000,
      );
      if (dupOfMove) continue;
      hasQaActivityInWindow = true;
      bounces.push({
        by: inc.by,
        from: 'Done',
        to: '(reopened)',
        at: inc.atIso,
        evidenceComments: gatherEvidence(inc.by, inc.atMs, comments),
      });
    }
  }

  const finders = [...new Set(bounces.map((b) => b.by))];

  return {
    gid: task.gid,
    name: task.name,
    url: task.permalink_url ?? '',
    hasQaActivityInWindow,
    bounces,
    finders,
  };
}

/** Comments that explain a bounce: same author within ±36h, OR any author
 *  within ±2h. Truncated to 600 chars, capped at 6 per bounce. */
function gatherEvidence(bounceBy: string, bounceAtMs: number, comments: CommentEvent[]): string[] {
  const hits: Array<{ atMs: number; text: string }> = [];
  for (const c of comments) {
    const dt = Math.abs(c.atMs - bounceAtMs);
    const near = dt <= EVIDENCE_WINDOW_TIGHT_MS;
    const sameAuthor = c.by === bounceBy && dt <= EVIDENCE_WINDOW_SAME_AUTHOR_MS;
    if (near || sameAuthor) hits.push({ atMs: c.atMs, text: c.text });
  }
  hits.sort((a, b) => a.atMs - b.atMs);
  return hits.slice(0, MAX_EVIDENCE_PER_BOUNCE).map((h) => truncate(h.text, EVIDENCE_CHAR_CAP));
}

/**
 * Convert a {startDate, endDate} (YYYY-MM-DD, America/Los_Angeles wall clock)
 * into inclusive UTC millisecond bounds [start 00:00:00.000, end 23:59:59.999].
 * DST-aware: the LA UTC offset is resolved for each boundary instant.
 */
export function pacificWindowToUtcMs(startDate: string, endDate: string): { startMs: number; endMs: number } {
  return {
    startMs: pacificWallToUtcMs(startDate, 0, 0, 0, 0),
    endMs: pacificWallToUtcMs(endDate, 23, 59, 59, 999),
  };
}

function pacificWallToUtcMs(ymd: string, h: number, min: number, sec: number, ms: number): number {
  const [y, mo, d] = ymd.split('-').map(Number);
  // Treat the wall-clock components as if they were UTC, then subtract the LA
  // offset that applies at that instant. Day boundaries are far from the 2am
  // DST transition, so a single offset resolution is exact here.
  const guessUtc = Date.UTC(y, mo - 1, d, h, min, sec, ms);
  const offsetMin = laOffsetMinutes(guessUtc);
  return guessUtc - offsetMin * 60_000;
}

/** LA offset (minutes east of UTC; -420 in PDT, -480 in PST) at an instant. */
function laOffsetMinutes(instantMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(instantMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  // Zone offsets are always whole minutes; `asUtc` drops the sub-second part of
  // `instantMs`, so round to avoid a fractional-minute skew on end-of-day bounds.
  return Math.round((asUtc - instantMs) / 60_000);
}
