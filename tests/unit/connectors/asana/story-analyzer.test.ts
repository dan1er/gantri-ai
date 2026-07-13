import { describe, it, expect } from 'vitest';
import {
  analyzeFeature,
  isFeatureTask,
  parseSectionMove,
  pacificWindowToUtcMs,
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

  it('attaches same-author comment within 36h as evidence, drops far unrelated comment', () => {
    const stories = [
      move('Matthew Fite', 'QA Review', 'Rework', '2026-06-10T12:00:00Z'),
      comment('Matthew Fite', 'crash on submit', '2026-06-10T13:00:00Z'), // +1h, same author
      comment('Joshua Nie', 'unrelated note', '2026-06-11T02:00:00Z'), // +14h, other author, >2h
    ];
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.bounces[0].evidenceComments).toEqual(['crash on submit']);
  });

  it('attaches any author comment within ±2h as evidence', () => {
    const stories = [
      move('Matthew Fite', 'QA Review', 'Rework', '2026-06-10T12:00:00Z'),
      comment('Francisco Bautista', 'this looks like expected behavior', '2026-06-10T13:30:00Z'), // +1.5h, other author
    ];
    const a = analyzeFeature(featureTask(), stories, START, END);
    expect(a.bounces[0].evidenceComments).toEqual(['this looks like expected behavior']);
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
