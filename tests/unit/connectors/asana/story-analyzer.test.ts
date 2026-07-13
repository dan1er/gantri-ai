import { describe, it, expect } from 'vitest';
import {
  analyzeFeature,
  attachSubtaskEvidence,
  isFeatureTask,
  parseSectionMove,
  pacificWindowToUtcMs,
  type Bounce,
  type SubtaskLike,
} from '../../../../src/connectors/asana/story-analyzer.js';
import { TYPE_FEATURE_OPTION_GID, TYPE_FIELD_GID } from '../../../../src/connectors/asana/board-config.js';
import type { AsanaStory, AsanaTask } from '../../../../src/connectors/asana/client.js';

const START = Date.parse('2026-06-01T00:00:00Z');
const END = Date.parse('2026-06-30T23:59:59Z');

let seq = 0;
function move(name: string, from: string, to: string, at: string, board = 'Software Board'): AsanaStory {
  return {
    gid: `s${seq++}`,
    created_at: at,
    created_by: { name },
    resource_subtype: 'section_changed',
    text: `${name} moved this task from "${from}" to "${to}" in ${board}`,
  };
}
function comment(name: string, text: string, at: string): AsanaStory {
  return { gid: `s${seq++}`, created_at: at, created_by: { name }, resource_subtype: 'comment_added', text };
}
function completion(at: string): AsanaStory {
  return { gid: `s${seq++}`, created_at: at, created_by: { name: 'Danny Estevez' }, resource_subtype: 'marked_complete', text: '' };
}
function incompletion(name: string, at: string): AsanaStory {
  return { gid: `s${seq++}`, created_at: at, created_by: { name }, resource_subtype: 'marked_incomplete', text: '' };
}

function featureTask(overrides: Partial<AsanaTask> = {}): AsanaTask {
  return {
    gid: 't1',
    name: 'Feature X',
    permalink_url: 'https://app.asana.com/0/1210754051061529/t1',
    custom_fields: [{ gid: TYPE_FIELD_GID, enum_value: { gid: TYPE_FEATURE_OPTION_GID } }],
    ...overrides,
  };
}

describe('isFeatureTask', () => {
  it('true when Type custom field resolves to the Feature option', () => {
    expect(isFeatureTask(featureTask())).toBe(true);
  });
  it('false for a non-Feature type', () => {
    expect(isFeatureTask(featureTask({ custom_fields: [{ gid: TYPE_FIELD_GID, enum_value: { gid: 'other' } }] }))).toBe(false);
  });
  it('false when the Type field is unset', () => {
    expect(isFeatureTask(featureTask({ custom_fields: [{ gid: TYPE_FIELD_GID, enum_value: null }] }))).toBe(false);
    expect(isFeatureTask(featureTask({ custom_fields: [] }))).toBe(false);
  });
});

describe('parseSectionMove', () => {
  it('parses a Software Board move', () => {
    expect(parseSectionMove('Matt moved this task from "QA Review" to "Rework" in Software Board'))
      .toEqual({ from: 'QA Review', to: 'Rework' });
  });
  it('ignores moves in other projects', () => {
    expect(parseSectionMove('Danny moved this task from "To do" to "Complete" in Product + Dev + QA')).toBeNull();
  });
  it('returns null for non-move text', () => {
    expect(parseSectionMove('Danny changed the description')).toBeNull();
    expect(parseSectionMove(undefined)).toBeNull();
  });
});

describe('analyzeFeature — QA-stage detection', () => {
  it('straight pass: QA activity in window, no bounce', () => {
    const stories = [
      move('Danny', 'Code Review', 'QA Review', '2026-06-10T10:00:00Z'),
      move('Matthew Fite', 'QA Review', 'Ready To Deploy', '2026-06-11T10:00:00Z'),
    ];
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.hasQaActivityInWindow).toBe(true);
    expect(a.bounces).toHaveLength(0);
    expect(a.finders).toEqual([]);
  });

  it('QA Review -> Rework counts as a bounce, attributed to the mover', () => {
    const stories = [move('Matthew Fite', 'QA Review', 'Rework', '2026-06-10T12:00:00Z')];
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.hasQaActivityInWindow).toBe(true);
    expect(a.bounces).toHaveLength(1);
    expect(a.bounces[0]).toMatchObject({ by: 'Matthew Fite', from: 'QA Review', to: 'Rework' });
    expect(a.finders).toEqual(['Matthew Fite']);
  });

  it('Post Release QA -> Code Review counts as a bounce', () => {
    const stories = [move('Joshua Nie', 'Post Release QA', 'Code Review', '2026-06-15T09:00:00Z')];
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.bounces).toHaveLength(1);
    expect(a.bounces[0]).toMatchObject({ from: 'Post Release QA', to: 'Code Review' });
  });

  it('reopen out of Done back to a review section counts as a bounce', () => {
    const stories = [move('Joshua Nie', 'Done', 'QA Review', '2026-06-20T09:00:00Z')];
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.hasQaActivityInWindow).toBe(true);
    expect(a.bounces).toHaveLength(1);
    expect(a.bounces[0]).toMatchObject({ by: 'Joshua Nie', from: 'Done', to: 'QA Review' });
  });

  it('forward move into QA Review is QA activity but NOT a bounce', () => {
    const stories = [move('Danny', 'Code Review', 'QA Review', '2026-06-10T10:00:00Z')];
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.hasQaActivityInWindow).toBe(true);
    expect(a.bounces).toHaveLength(0);
  });

  it('non-Software-Board moves are ignored entirely', () => {
    const stories = [move('Danny', 'QA Review', 'Rework', '2026-06-10T10:00:00Z', 'Product + Dev + QA')];
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.hasQaActivityInWindow).toBe(false);
    expect(a.bounces).toHaveLength(0);
  });

  it('marked_incomplete after a completion is a reopen bounce', () => {
    const stories = [
      completion('2026-06-05T10:00:00Z'),
      incompletion('Matthew Fite', '2026-06-20T10:00:00Z'),
    ];
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.hasQaActivityInWindow).toBe(true);
    expect(a.bounces).toHaveLength(1);
    expect(a.bounces[0]).toMatchObject({ by: 'Matthew Fite', from: 'Done', to: '(reopened)' });
  });

  it('marked_incomplete without a prior completion is NOT a bounce', () => {
    const stories = [incompletion('Matthew Fite', '2026-06-20T10:00:00Z')];
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.bounces).toHaveLength(0);
  });

  it('marked_incomplete collapses into a near-simultaneous section-move reopen (no double count)', () => {
    const stories = [
      completion('2026-06-05T10:00:00Z'),
      move('Joshua Nie', 'Done', 'QA Review', '2026-06-20T09:00:00Z'),
      incompletion('Joshua Nie', '2026-06-20T09:00:30Z'),
    ];
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.bounces).toHaveLength(1);
    expect(a.bounces[0]).toMatchObject({ from: 'Done', to: 'QA Review' });
  });
});

describe('analyzeFeature — window edges', () => {
  it('includes a move at exactly the window start (inclusive)', () => {
    const stories = [move('Matthew Fite', 'QA Review', 'Rework', new Date(START).toISOString())];
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.bounces).toHaveLength(1);
  });

  it('excludes a move after the window end', () => {
    const stories = [move('Matthew Fite', 'QA Review', 'Rework', '2026-07-05T00:00:00Z')];
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.hasQaActivityInWindow).toBe(false);
    expect(a.bounces).toHaveLength(0);
  });

  // The production window ends at 23:59:59.999 PT, not .000 — a story landing in
  // that final sub-second sliver of the last PT day must still be counted, and
  // the very next millisecond must not.
  it('includes a move at the true inclusive end (.999 ms) and excludes the next ms', () => {
    const { startMs, endMs } = pacificWindowToUtcMs('2026-06-01', '2026-06-30');
    const atEnd = analyzeFeature(
      featureTask(),
      [move('Matthew Fite', 'QA Review', 'Rework', new Date(endMs).toISOString())],
      startMs,
      endMs,
    );
    expect(atEnd.bounces).toHaveLength(1);
    const afterEnd = analyzeFeature(
      featureTask(),
      [move('Matthew Fite', 'QA Review', 'Rework', new Date(endMs + 1).toISOString())],
      startMs,
      endMs,
    );
    expect(afterEnd.hasQaActivityInWindow).toBe(false);
    expect(afterEnd.bounces).toHaveLength(0);
  });
});

describe('analyzeFeature — multi-bounce + evidence', () => {
  it('collects both finders across multiple in-window bounces', () => {
    const stories = [
      move('Matthew Fite', 'QA Review', 'Rework', '2026-06-05T10:00:00Z'),
      move('Danny', 'Rework', 'Code Review', '2026-06-06T10:00:00Z'), // not a bounce
      move('Danny', 'Code Review', 'QA Review', '2026-06-07T10:00:00Z'), // forward, not a bounce
      move('Joshua Nie', 'QA Review', 'Rework', '2026-06-08T10:00:00Z'),
    ];
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.bounces).toHaveLength(2);
    expect(a.finders.sort()).toEqual(['Joshua Nie', 'Matthew Fite']);
  });

  it('attaches the bouncer comment within ±72h, drops an unrelated far comment', () => {
    const stories = [
      move('Matthew Fite', 'QA Review', 'Rework', '2026-06-10T12:00:00Z'),
      comment('Matthew Fite', 'crash on submit', '2026-06-12T12:00:00Z'), // +48h, same author (was >36h, now kept)
      comment('Joshua Nie', 'unrelated note', '2026-06-13T12:00:00Z'), // +72h, other author (>12h, dropped)
    ];
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.bounces[0].evidenceComments).toEqual(['crash on submit']);
  });

  it('attaches any-author comment within ±12h (widened from ±2h)', () => {
    const stories = [
      move('Matthew Fite', 'QA Review', 'Rework', '2026-06-10T12:00:00Z'),
      comment('Francisco Bautista', 'this looks like expected behavior', '2026-06-10T22:00:00Z'), // +10h, other author
    ];
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.bounces[0].evidenceComments).toEqual(['this looks like expected behavior']);
  });

  it('drops an other-author comment just past ±12h', () => {
    const stories = [
      move('Matthew Fite', 'QA Review', 'Rework', '2026-06-10T12:00:00Z'),
      comment('Francisco Bautista', 'too far out', '2026-06-11T01:00:00Z'), // +13h, other author
    ];
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.bounces[0].evidenceComments).toEqual([]);
  });

  it('caps evidence comments at 8 per bounce', () => {
    const stories: AsanaStory[] = [move('Matthew Fite', 'QA Review', 'Rework', '2026-06-10T12:00:00Z')];
    // 10 same-author comments all within ±72h — only the first 8 (oldest) survive.
    for (let i = 0; i < 10; i++) {
      stories.push(comment('Matthew Fite', `note ${i}`, `2026-06-10T${String(13 + i).padStart(2, '0')}:00:00Z`));
    }
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.bounces[0].evidenceComments).toHaveLength(8);
    expect(a.bounces[0].evidenceComments[0]).toBe('note 0');
    expect(a.bounces[0].evidenceComments[7]).toBe('note 7');
  });
});

describe('attachSubtaskEvidence', () => {
  function bounce(at: string): Bounce {
    return { by: 'Matthew Fite', from: 'QA Review', to: 'Rework', at, evidenceComments: [] };
  }
  function subtask(name: string, at: string, by = 'Matthew Fite'): SubtaskLike {
    return { name, created_at: at, created_by: { name: by } };
  }

  it('appends a formatted line for a subtask created within ±72h of the bounce', () => {
    const b = bounce('2026-06-10T12:00:00Z');
    attachSubtaskEvidence([b], [subtask('Logo overlaps the title', '2026-06-11T12:00:00Z')]); // +24h
    expect(b.evidenceComments).toEqual(['subtask created by Matthew Fite: "Logo overlaps the title"']);
  });

  it('includes a subtask at the ±72h boundary and excludes one just past it', () => {
    const atBoundary = bounce('2026-06-10T12:00:00Z');
    attachSubtaskEvidence([atBoundary], [subtask('right at the edge', '2026-06-13T12:00:00Z')]); // +72h exactly
    expect(atBoundary.evidenceComments).toHaveLength(1);

    const pastBoundary = bounce('2026-06-10T12:00:00Z');
    attachSubtaskEvidence([pastBoundary], [subtask('too late', '2026-06-13T12:00:01Z')]); // +72h +1s
    expect(pastBoundary.evidenceComments).toEqual([]);
  });

  it('caps at 5 subtasks per bounce, oldest first', () => {
    const b = bounce('2026-06-10T12:00:00Z');
    const subs = Array.from({ length: 8 }, (_, i) =>
      subtask(`issue ${i}`, `2026-06-10T${String(13 + i).padStart(2, '0')}:00:00Z`),
    );
    attachSubtaskEvidence([b], subs);
    expect(b.evidenceComments).toHaveLength(5);
    expect(b.evidenceComments[0]).toBe('subtask created by Matthew Fite: "issue 0"');
    expect(b.evidenceComments[4]).toBe('subtask created by Matthew Fite: "issue 4"');
  });

  it('truncates the subtask title to 200 chars', () => {
    const b = bounce('2026-06-10T12:00:00Z');
    const longTitle = 'x'.repeat(250);
    attachSubtaskEvidence([b], [subtask(longTitle, '2026-06-10T13:00:00Z')]);
    const line = b.evidenceComments[0];
    // `subtask created by Matthew Fite: "` prefix + 200 chars + `…"` suffix.
    expect(line).toContain('x'.repeat(200) + '…"');
    expect(line).not.toContain('x'.repeat(201));
  });

  it('falls back to (unknown) when the subtask has no creator', () => {
    const b = bounce('2026-06-10T12:00:00Z');
    attachSubtaskEvidence([b], [{ name: 'orphan issue', created_at: '2026-06-10T13:00:00Z', created_by: null }]);
    expect(b.evidenceComments).toEqual(['subtask created by (unknown): "orphan issue"']);
  });

  it('ignores nameless or dateless subtasks and is a no-op with no bounces/subtasks', () => {
    const b = bounce('2026-06-10T12:00:00Z');
    attachSubtaskEvidence([b], [
      { name: '', created_at: '2026-06-10T13:00:00Z' },
      { name: 'no date', created_at: undefined },
    ]);
    expect(b.evidenceComments).toEqual([]);

    const b2 = bounce('2026-06-10T12:00:00Z');
    attachSubtaskEvidence([b2], []);
    expect(b2.evidenceComments).toEqual([]);
    attachSubtaskEvidence([], [subtask('anything', '2026-06-10T13:00:00Z')]); // no throw
  });

  it('attaches independently per bounce based on each bounce timestamp', () => {
    const early = bounce('2026-06-01T12:00:00Z');
    const late = bounce('2026-06-20T12:00:00Z');
    const sub = subtask('near the late bounce', '2026-06-20T13:00:00Z');
    attachSubtaskEvidence([early, late], [sub]);
    expect(early.evidenceComments).toEqual([]);
    expect(late.evidenceComments).toEqual(['subtask created by Matthew Fite: "near the late bounce"']);
  });
});

describe('pacificWindowToUtcMs', () => {
  it('maps summer (PDT, UTC-7) day bounds to UTC', () => {
    const { startMs, endMs } = pacificWindowToUtcMs('2026-06-01', '2026-06-30');
    expect(startMs).toBe(Date.parse('2026-06-01T07:00:00.000Z'));
    expect(endMs).toBe(Date.parse('2026-07-01T06:59:59.999Z'));
  });

  it('maps winter (PST, UTC-8) day bounds to UTC', () => {
    const { startMs, endMs } = pacificWindowToUtcMs('2026-01-15', '2026-01-15');
    expect(startMs).toBe(Date.parse('2026-01-15T08:00:00.000Z'));
    expect(endMs).toBe(Date.parse('2026-01-16T07:59:59.999Z'));
  });
});
