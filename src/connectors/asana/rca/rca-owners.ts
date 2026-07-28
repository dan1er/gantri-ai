import type { AsanaStory } from '../client.js';
import { parseSectionMove } from '../story-analyzer.js';

/**
 * Who owes each half of the RCA.
 *
 * The obvious answer — the ticket's assignee — is wrong. A bug is reassigned all
 * the way down the chain as it moves (on one real ticket: Francisco → Eduardo →
 * Josh → Matt), so the FINAL assignee is whoever verified it, i.e. QA, every
 * time. Naming them next to a missing Engineering RCA points at the wrong
 * person. The RCA subtasks themselves carry no assignee at all.
 *
 * The board history does answer it, unambiguously:
 *   - whoever moved the ticket INTO Code Review finished the work → the dev;
 *   - whoever moved it OUT of a verification stage into a terminal section
 *     signed it off → the QA.
 *
 * Section moves are used rather than the `assigned` stories because assignment
 * text is not machine-readable — Asana renders self-assignment as "assigned to
 * you", where "you" is the PAT owner, not the actual person.
 */

/** Sections where QA verifies. Matched loosely on the NAME: the board keeps
 *  adding lanes (the delivery-tier rollout added "🔴 Verification Lane"), and a
 *  fixed gid list goes stale silently. */
const QA_STAGE_RE = /\bqa\b|verification|post release/i;

/** Sections a ticket lands in once it is finished. */
const TERMINAL_RE = /^(done|ready to deploy)$/i;

/** The section a dev hands off to when the code is written. */
const CODE_REVIEW_RE = /^code review$/i;

/** Sections that mean active development. */
const IN_PROGRESS_RE = /^(in progress|rework)$/i;

export interface RcaOwners {
  /** Who wrote the code — owes the Engineering RCA. */
  dev: string | null;
  /** Who verified it — owes the QA RCA. */
  qa: string | null;
}

interface Move {
  by: string;
  from: string;
  to: string;
  atMs: number;
}

/** Asana attributes its own automation moves to "Asana" or to nobody. Those are
 *  not people and must never be named as an owner. */
function isRealPerson(name: string | undefined | null): name is string {
  if (!name) return false;
  return name.trim() !== '' && name.trim().toLowerCase() !== 'asana';
}

function sectionMoves(stories: AsanaStory[]): Move[] {
  const moves: Move[] = [];
  for (const s of stories) {
    if (s.resource_subtype !== 'section_changed') continue;
    const parsed = parseSectionMove(s.text);
    if (!parsed) continue;
    const by = s.created_by?.name;
    if (!isRealPerson(by)) continue;
    moves.push({
      by,
      from: parsed.from.trim(),
      to: parsed.to.trim(),
      atMs: s.created_at ? Date.parse(s.created_at) : 0,
    });
  }
  return moves.sort((a, b) => a.atMs - b.atMs);
}

/** The author of the LAST move matching `pred`, or null. Last rather than first:
 *  when a ticket bounces back for rework, the person who finished it is the one
 *  who owes the write-up. */
function lastMoverWhere(moves: Move[], pred: (m: Move) => boolean): string | null {
  for (let i = moves.length - 1; i >= 0; i -= 1) {
    if (pred(moves[i])) return moves[i].by;
  }
  return null;
}

/**
 * Resolve the dev and QA owners from a ticket's story history. Either can be
 * null — a ticket filed straight into Done has no handoffs to read, and naming
 * nobody is better than naming the wrong person.
 */
export function resolveRcaOwners(stories: AsanaStory[]): RcaOwners {
  const moves = sectionMoves(stories);

  // Dev: handed the work to review. Falls back to whoever moved it out of active
  // development, for tickets that skip the Code Review lane.
  const dev =
    lastMoverWhere(moves, (m) => CODE_REVIEW_RE.test(m.to)) ??
    lastMoverWhere(moves, (m) => IN_PROGRESS_RE.test(m.from) && !IN_PROGRESS_RE.test(m.to));

  // QA: signed it off out of a verification stage. Falls back to whoever moved it
  // into a terminal section at all, which on a verified ticket is the same person.
  const qa =
    lastMoverWhere(moves, (m) => QA_STAGE_RE.test(m.from) && TERMINAL_RE.test(m.to)) ??
    lastMoverWhere(moves, (m) => QA_STAGE_RE.test(m.from)) ??
    lastMoverWhere(moves, (m) => TERMINAL_RE.test(m.to));

  return {
    dev,
    // A ticket that went straight to Done without review would otherwise credit
    // the dev as its own QA. Only name QA when it is someone else.
    qa: qa && qa === dev ? null : qa,
  };
}
