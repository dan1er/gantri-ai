import { describe, it, expect } from 'vitest';
import { resolveRcaOwners } from '../../../../../src/connectors/asana/rca/rca-owners.js';
import type { AsanaStory } from '../../../../../src/connectors/asana/client.js';

let seq = 0;
function move(by: string | null, from: string, to: string, at: string): AsanaStory {
  seq += 1;
  return {
    gid: `s${seq}`,
    created_at: at,
    created_by: by ? { name: by } : null,
    resource_subtype: 'section_changed',
    text: `${by ?? 'Asana'} moved this task from "${from}" to "${to}" in Software Board`,
  };
}

/**
 * The story history of Hot-Fix "Unable to process a return due to tracking number
 * issue" (task 1216770088377401), as it reads on the live board. Eduardo wrote
 * the code; Matt verified it. The ticket's ASSIGNEE at the end is Matt, which is
 * exactly why the assignee cannot be used for the engineering half.
 */
const REAL_HISTORY: AsanaStory[] = [
  move('Eduardo Aranda', 'Backlog', 'In Progress', '2026-07-22T19:39:00Z'),
  move('Eduardo Aranda', 'In Progress', 'Code Review', '2026-07-22T22:22:00Z'),
  move('Eduardo Aranda', 'Code Review', '🔴 Verification Lane ', '2026-07-23T14:37:00Z'),
  move(null, '🔴 Verification Lane ', 'Done', '2026-07-23T18:25:00Z'), // Asana automation
  move('Matthew Fite', '🔴 Verification Lane ', 'Done', '2026-07-23T18:25:00Z'),
];

describe('resolveRcaOwners', () => {
  it('reads the dev and the QA off a real ticket history', () => {
    expect(resolveRcaOwners(REAL_HISTORY)).toEqual({
      dev: 'Eduardo Aranda',
      qa: 'Matthew Fite',
    });
  });

  it('never names Asana automation as an owner', () => {
    // The automation move into Done is the LAST terminal move; if it counted,
    // "Asana" would be credited as QA.
    const owners = resolveRcaOwners([
      move('Eduardo Aranda', 'In Progress', 'Code Review', '2026-07-22T22:22:00Z'),
      move(null, 'Code Review', 'Done', '2026-07-23T18:25:00Z'),
    ]);
    expect(owners.qa).toBeNull();
    expect(owners.dev).toBe('Eduardo Aranda');
  });

  it('credits the LAST dev when a ticket bounces back for rework', () => {
    const owners = resolveRcaOwners([
      move('Eduardo Aranda', 'In Progress', 'Code Review', '2026-07-22T10:00:00Z'),
      move('Matthew Fite', 'Code Review', 'Rework', '2026-07-22T12:00:00Z'),
      move('Francisco Bautista', 'Rework', 'Code Review', '2026-07-22T18:00:00Z'),
      move('Matthew Fite', 'QA Review', 'Done', '2026-07-23T10:00:00Z'),
    ]);
    expect(owners.dev).toBe('Francisco Bautista');
    expect(owners.qa).toBe('Matthew Fite');
  });

  it('recognises verification lanes the section constants do not list', () => {
    // The delivery-tier rollout added lanes that are not in SECTION_GIDS.
    for (const lane of ['QA Review', 'Post Release QA', '🔴 Verification Lane ']) {
      const owners = resolveRcaOwners([
        move('Eduardo Aranda', 'In Progress', 'Code Review', '2026-07-22T10:00:00Z'),
        move('Joshua Nie', lane, 'Done', '2026-07-23T10:00:00Z'),
      ]);
      expect(owners.qa).toBe('Joshua Nie');
    }
  });

  it('falls back to the mover out of active development when there is no Code Review step', () => {
    const owners = resolveRcaOwners([
      move('Eduardo Aranda', 'In Progress', 'Done', '2026-07-22T10:00:00Z'),
    ]);
    expect(owners.dev).toBe('Eduardo Aranda');
  });

  it('does not credit the dev as their own QA', () => {
    // Straight from In Progress to Done by one person: nobody verified it.
    expect(resolveRcaOwners([move('Eduardo Aranda', 'In Progress', 'Done', '2026-07-22T10:00:00Z')]))
      .toEqual({ dev: 'Eduardo Aranda', qa: null });
  });

  it('names nobody for a ticket with no history to read', () => {
    // A bug filed straight into Done — naming nobody beats naming the wrong person.
    expect(resolveRcaOwners([])).toEqual({ dev: null, qa: null });
  });

  it('ignores moves that happened on another board', () => {
    const foreign: AsanaStory = {
      gid: 'x',
      created_at: '2026-07-22T10:00:00Z',
      created_by: { name: 'Andrew Radomsky' },
      resource_subtype: 'section_changed',
      text: 'Andrew Radomsky moved this task from "To Do" to "Done" in Manufacturing Improvements POD Sprint 24',
    };
    expect(resolveRcaOwners([foreign])).toEqual({ dev: null, qa: null });
  });

  it('ignores comments and other story types', () => {
    const comment: AsanaStory = {
      gid: 'c',
      created_at: '2026-07-22T10:00:00Z',
      created_by: { name: 'Danny Estevez' },
      resource_subtype: 'comment_added',
      text: 'moved this task from "In Progress" to "Code Review" in Software Board',
    };
    expect(resolveRcaOwners([comment])).toEqual({ dev: null, qa: null });
  });
});
