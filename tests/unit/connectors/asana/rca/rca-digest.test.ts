import { describe, it, expect, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import {
  RcaDigestReporter,
  computeRcaDigest,
  dueSlotKey,
  lastMoveToDoneAt,
  openRcaSubtasks,
  rcaKind,
  renderRcaDigest,
  type RcaDigestEntry,
} from '../../../../../src/connectors/asana/rca/rca-digest.js';
import { isBugTask, SECTION_GIDS, TYPE_FIELD_GID } from '../../../../../src/connectors/asana/board-config.js';
import type { AsanaApiClient, AsanaTask } from '../../../../../src/connectors/asana/client.js';
import type { RcaDigestsRepo } from '../../../../../src/storage/repositories/rca-digests.js';

const DONE_SECTION = SECTION_GIDS.Done;
/** 2026-07-28 14:00Z = 10:00 America/New_York — inside the 08:00 slot. */
const NOW = new Date('2026-07-28T14:00:00Z');

function task(o: Partial<AsanaTask> & { gid: string }): AsanaTask {
  return {
    gid: o.gid,
    name: o.name ?? 'Bug: something broke',
    completed: o.completed ?? true,
    // `?? default` would swallow an explicit null, which is exactly the case the
    // Done-section fallback tests exercise.
    completed_at: 'completed_at' in o ? o.completed_at : '2026-07-25T12:00:00Z',
    modified_at: o.modified_at,
    num_subtasks: o.num_subtasks ?? 2,
    assignee: o.assignee,
    custom_fields: o.custom_fields,
    memberships: o.memberships,
  };
}

function typeField(optionGid: string, name: string) {
  return [{ gid: TYPE_FIELD_GID, enum_value: { gid: optionGid, name } }];
}

describe('dueSlotKey', () => {
  it('is null before the first send time', () => {
    // 11:00Z = 07:00 NY.
    expect(dueSlotKey(new Date('2026-07-28T11:00:00Z'))).toBeNull();
  });

  it('returns the morning slot between 08:00 and 16:00 NY', () => {
    expect(dueSlotKey(new Date('2026-07-28T12:00:00Z'))).toBe('2026-07-28:08'); // 08:00 NY
    expect(dueSlotKey(NOW)).toBe('2026-07-28:08');
    expect(dueSlotKey(new Date('2026-07-28T19:59:00Z'))).toBe('2026-07-28:08'); // 15:59 NY
  });

  it('returns the afternoon slot from 16:00 NY onward', () => {
    expect(dueSlotKey(new Date('2026-07-28T20:00:00Z'))).toBe('2026-07-28:16');
    expect(dueSlotKey(new Date('2026-07-29T03:00:00Z'))).toBe('2026-07-28:16'); // 23:00 NY, same day
  });

  it('never replays a missed slot — only the most recent one is due', () => {
    // Down all morning, back at 18:00 NY: the afternoon slot is what is owed.
    expect(dueSlotKey(new Date('2026-07-28T22:00:00Z'))).toBe('2026-07-28:16');
  });
});

describe('isBugTask', () => {
  it('trusts the Type field when it is set', () => {
    expect(isBugTask({ name: 'x', custom_fields: typeField('1211288498996176', 'Bug') })).toBe(true);
    expect(isBugTask({ name: 'x', custom_fields: typeField('1211288498996177', 'Regression') })).toBe(true);
    expect(isBugTask({ name: 'x', custom_fields: typeField('1211288498996173', 'Hotfix') })).toBe(true);
    expect(isBugTask({ name: 'x', custom_fields: typeField('1211288498996175', 'Feature') })).toBe(false);
    // 'Hotfix (not really)' and 'Hotfix-Feature' label fast-tracked features.
    expect(isBugTask({ name: 'x', custom_fields: typeField('1214905224299816', 'Hotfix (not really)') })).toBe(false);
    expect(isBugTask({ name: 'x', custom_fields: typeField('1211288498996174', 'Hotfix-Feature') })).toBe(false);
  });

  it('a set Type beats a defect-shaped title', () => {
    expect(
      isBugTask({ name: 'Not A Bug: Shippo Error', custom_fields: typeField('1211288498996178', 'Not a Bug') }),
    ).toBe(false);
    expect(
      isBugTask({ name: 'Bug: looks like one', custom_fields: typeField('1211288498996178', 'Not a Bug') }),
    ).toBe(false);
  });

  it('falls back to the title convention when Type is empty', () => {
    expect(isBugTask({ name: 'Bug: Cannot cancel full order' })).toBe(true);
    expect(isBugTask({ name: 'Hotfix: Sidemarks button and shipping method' })).toBe(true);
    expect(isBugTask({ name: 'Hot-Fix: Haworth order not in admin' })).toBe(true);
    expect(isBugTask({ name: 'Regression: preorder badge' })).toBe(true);
    expect(isBugTask({ name: 'Not A Bug: Shippo Error - Lumens' })).toBe(false);
    expect(isBugTask({ name: 'Add wireless early-access signup' })).toBe(false);
  });
});

describe('openRcaSubtasks', () => {
  it('matches every spelling the board has used', () => {
    const open = openRcaSubtasks([
      { name: 'Engineering Escape RCA', completed: false },
      { name: 'QA Escape RCA', completed: false },
      { name: 'Root cause analysis', completed: false },
      { name: 'Root Cause', completed: false },
    ]);
    expect(open.map((o) => o.kind)).toEqual(['engineering', 'qa', 'general', 'general']);
  });

  it('ignores completed RCAs and unrelated subtasks', () => {
    expect(
      openRcaSubtasks([
        { name: 'Engineering Escape RCA', completed: true },
        { name: 'QA Escape RCA', completed: true },
        { name: 'Notes for QA', completed: false },
        { name: 'Deploy to staging', completed: false },
      ]),
    ).toEqual([]);
  });

  it('reports the half that is still open when only one is done', () => {
    const open = openRcaSubtasks([
      { name: 'Engineering Escape RCA', completed: true },
      { name: 'QA Escape RCA', completed: false },
    ]);
    expect(open).toEqual([{ name: 'QA Escape RCA', kind: 'qa' }]);
  });

  it('trims the stray whitespace real subtask names carry', () => {
    expect(openRcaSubtasks([{ name: 'Root cause analysis ', completed: false }])[0].name).toBe(
      'Root cause analysis',
    );
  });

  it('rcaKind does not read "qa" out of the middle of a word', () => {
    expect(rcaKind('Equant RCA')).toBe('general');
  });
});

describe('computeRcaDigest', () => {
  /** Pair a task with subtasks + the done timestamp the collector would resolve. */
  function cand(
    t: AsanaTask,
    subtasks: { name?: string; completed?: boolean }[],
    doneAt?: { at: string; approximate: boolean },
  ) {
    return {
      task: t,
      subtasks,
      doneAt: doneAt ?? { at: t.completed_at ?? t.modified_at ?? '', approximate: !t.completed_at },
    };
  }

  it('keeps only tasks with an open RCA and sorts oldest-closed first', () => {
    const payload = computeRcaDigest(
      '2026-07-28:08',
      120,
      [
        cand(task({ gid: 'recent', completed_at: '2026-07-27T12:00:00Z' }), [
          { name: 'Engineering Escape RCA', completed: false },
        ]),
        cand(task({ gid: 'old', completed_at: '2026-07-10T12:00:00Z' }), [
          { name: 'Root cause analysis', completed: false },
        ]),
        cand(task({ gid: 'clean' }), [{ name: 'Engineering Escape RCA', completed: true }]),
        cand(task({ gid: 'no-rca' }), [{ name: 'Notes for QA', completed: false }]),
      ],
      NOW,
      0,
    );
    expect(payload.entries.map((e) => e.taskGid)).toEqual(['old', 'recent']);
    expect(payload.entries[0].daysSinceDone).toBe(18);
    expect(payload.scanned).toBe(120);
  });

  it('drops anything that reached Done before the cutoff', () => {
    const cutoff = Date.parse('2026-07-28T12:00:00Z'); // 08:00 NY today
    const payload = computeRcaDigest(
      '2026-07-28:08',
      2,
      [
        cand(task({ gid: 'before', completed_at: '2026-07-28T11:59:00Z' }), [
          { name: 'QA Escape RCA', completed: false },
        ]),
        cand(task({ gid: 'after', completed_at: '2026-07-28T12:01:00Z' }), [
          { name: 'QA Escape RCA', completed: false },
        ]),
      ],
      NOW,
      cutoff,
    );
    expect(payload.entries.map((e) => e.taskGid)).toEqual(['after']);
  });

  it('uses the resolved done time, not modified_at, against the cutoff', () => {
    const cutoff = Date.parse('2026-07-28T12:00:00Z');
    const payload = computeRcaDigest(
      '2026-07-28:08',
      1,
      [
        // Parked in Done two days ago; edited this morning. modified_at would
        // clear the cutoff — the real section-move timestamp does not.
        cand(
          task({
            gid: 'parked-then-edited',
            completed: false,
            completed_at: null,
            modified_at: '2026-07-28T13:00:00Z',
            memberships: [{ section: { gid: DONE_SECTION } }],
          }),
          [{ name: 'QA Escape RCA', completed: false }],
          { at: '2026-07-26T12:00:00Z', approximate: false },
        ),
      ],
      NOW,
      cutoff,
    );
    expect(payload.entries).toEqual([]);
  });

  it('carries the approximate flag through for tickets with no move history', () => {
    const payload = computeRcaDigest(
      '2026-07-28:08',
      1,
      [
        cand(
          task({
            gid: 'parked',
            completed: false,
            completed_at: null,
            modified_at: '2026-07-26T12:00:00Z',
            memberships: [{ section: { gid: DONE_SECTION } }],
          }),
          [{ name: 'QA Escape RCA', completed: false }],
          { at: '2026-07-26T12:00:00Z', approximate: true },
        ),
      ],
      NOW,
      0,
    );
    expect(payload.entries[0].doneAtApproximate).toBe(true);
    expect(payload.entries[0].daysSinceDone).toBe(2);
  });
});

describe('lastMoveToDoneAt', () => {
  const story = (subtype: string, text: string, at: string) => ({
    gid: 'g',
    created_at: at,
    resource_subtype: subtype,
    text,
  });

  it('picks the most recent move INTO Done', () => {
    expect(
      lastMoveToDoneAt([
        story('section_changed', 'Matt moved this task from "QA Review" to "Done" in Software Board', '2026-07-20T10:00:00Z'),
        story('section_changed', 'Matt moved this task from "Done" to "Rework" in Software Board', '2026-07-22T10:00:00Z'),
        story('section_changed', 'Matt moved this task from "Rework" to "Done" in Software Board', '2026-07-26T10:00:00Z'),
      ]),
    ).toBe('2026-07-26T10:00:00Z');
  });

  it('ignores comments, other sections, and moves on other boards', () => {
    expect(
      lastMoveToDoneAt([
        story('comment_added', 'moved this task from "A" to "Done" in Software Board', '2026-07-26T10:00:00Z'),
        story('section_changed', 'Matt moved this task from "QA Review" to "Ready To Deploy" in Software Board', '2026-07-26T10:00:00Z'),
        story('section_changed', 'Matt moved this task from "A" to "Done" in Marketing Board', '2026-07-26T10:00:00Z'),
      ]),
    ).toBeNull();
  });

  it('is null when the task has no stories at all', () => {
    expect(lastMoveToDoneAt([])).toBeNull();
  });
});

describe('renderRcaDigest', () => {
  const entry = (o: Partial<RcaDigestEntry>): RcaDigestEntry => ({
    taskGid: o.taskGid ?? '1',
    name: o.name ?? 'Bug: Cannot cancel full order',
    url: o.url ?? 'https://app.asana.com/0/1210754051061529/1',
    type: o.type ?? 'Bug',
    assigneeName: o.assigneeName ?? 'Matthew Fite',
    assigneeEmail: o.assigneeEmail ?? 'matt@gantri.com',
    doneAt: o.doneAt ?? '2026-07-25T12:00:00Z',
    doneAtApproximate: o.doneAtApproximate ?? false,
    daysSinceDone: o.daysSinceDone ?? 3,
    openRcas: o.openRcas ?? [{ name: 'Engineering Escape RCA', kind: 'engineering' }],
  });

  it('returns null when nothing is outstanding', () => {
    expect(renderRcaDigest({ slotKey: 's', entries: [], scanned: 10 }, () => null)).toBeNull();
  });

  it('lists each ticket with its open RCAs and the resolved mention', () => {
    const text = renderRcaDigest(
      { slotKey: 's', entries: [entry({})], scanned: 10 },
      () => '<@U123>',
    );
    expect(text).toContain('1 closed bug still owe');
    expect(text).toContain('<https://app.asana.com/0/1210754051061529/1|Bug: Cannot cancel full order>');
    expect(text).toContain('Bug · closed 3d ago · assignee: <@U123>');
    expect(text).toContain('↳ open: Engineering Escape RCA');
  });

  it('escapes Slack link-label metacharacters in ticket names', () => {
    const text = renderRcaDigest(
      { slotKey: 's', entries: [entry({ name: 'Bug: <script> & "quotes"' })], scanned: 1 },
      () => null,
    );
    expect(text).toContain('Bug: &lt;script&gt; &amp; "quotes"');
  });

  it('collapses the tail past 20 tickets', () => {
    const entries = Array.from({ length: 23 }, (_, i) => entry({ taskGid: String(i), daysSinceDone: i }));
    const text = renderRcaDigest({ slotKey: 's', entries, scanned: 100 }, () => null)!;
    expect(text).toContain('23 closed bugs still owe');
    expect(text).toContain('…and 3 more.');
  });
});

describe('RcaDigestReporter', () => {
  function harness(opts: {
    tasks: AsanaTask[];
    subtasks: Record<string, { name: string; completed: boolean }[]>;
    stories?: Record<string, { gid: string; created_at: string; resource_subtype: string; text: string }[]>;
    existing?: boolean;
    now?: Date;
    startAtMs?: number;
  }) {
    const postMessage = vi.fn().mockResolvedValue({ ok: true });
    const insert = vi.fn().mockResolvedValue(undefined);
    const client = {
      getProjectTasksUnbounded: vi.fn().mockResolvedValue(opts.tasks),
      getTaskSubtasks: vi.fn(async (gid: string) => opts.subtasks[gid] ?? []),
      getTaskStories: vi.fn(async (gid: string) => opts.stories?.[gid] ?? []),
    } as unknown as AsanaApiClient;
    const repo = {
      get: vi.fn().mockResolvedValue(opts.existing ? { slotKey: 'x' } : null),
      insert,
    } as unknown as RcaDigestsRepo;
    const reporter = new RcaDigestReporter({
      client,
      repo,
      slack: { chat: { postMessage } } as unknown as WebClient,
      channelId: 'C_SOFTWARE',
      startAtMs: opts.startAtMs,
      now: () => opts.now ?? NOW,
      resolveSlackIdsByEmail: async () => new Map([['matt@gantri.com', 'U_MATT']]),
    });
    return { reporter, postMessage, insert, client };
  }

  it('posts the digest and records the slot', async () => {
    const { reporter, postMessage, insert } = harness({
      tasks: [
        task({ gid: 'b1', name: 'Bug: broken checkout', assignee: { gid: 'u', name: 'Matthew Fite', email: 'matt@gantri.com' } }),
        task({ gid: 'f1', name: 'Add early access signup', custom_fields: typeField('1211288498996175', 'Feature') }),
      ],
      subtasks: {
        b1: [{ name: 'QA Escape RCA', completed: false }],
        f1: [{ name: 'Root cause analysis', completed: false }],
      },
    });

    const result = await reporter.maybeSend();

    expect(result).toMatchObject({ sent: true, slotKey: '2026-07-28:08', tickets: 1 });
    const text = postMessage.mock.calls[0][0].text as string;
    expect(text).toContain('Bug: broken checkout');
    expect(text).toContain('<@U_MATT>');
    // The feature ticket is never fetched, let alone listed.
    expect(text).not.toContain('early access');
    expect(insert).toHaveBeenCalledWith('2026-07-28:08', 1, expect.anything());
  });

  it('records the slot without posting when nothing is outstanding', async () => {
    const { reporter, postMessage, insert } = harness({
      tasks: [task({ gid: 'b1' })],
      subtasks: { b1: [{ name: 'Engineering Escape RCA', completed: true }] },
    });

    const result = await reporter.maybeSend();

    expect(result).toMatchObject({ sent: false, reason: 'all_clear', tickets: 0 });
    expect(postMessage).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith('2026-07-28:08', 0, expect.anything());
  });

  it('is idempotent — a delivered slot is never re-sent', async () => {
    const { reporter, postMessage, client } = harness({
      tasks: [task({ gid: 'b1' })],
      subtasks: { b1: [{ name: 'QA Escape RCA', completed: false }] },
      existing: true,
    });

    const result = await reporter.maybeSend();

    expect(result).toMatchObject({ sent: false, reason: 'already_sent' });
    expect(postMessage).not.toHaveBeenCalled();
    // No board read either — the ledger check short-circuits before the scan.
    expect(client.getProjectTasksUnbounded).not.toHaveBeenCalled();
  });

  it('does nothing before the first send time', async () => {
    const { reporter, postMessage, client } = harness({
      tasks: [task({ gid: 'b1' })],
      subtasks: { b1: [{ name: 'QA Escape RCA', completed: false }] },
      now: new Date('2026-07-28T11:00:00Z'), // 07:00 NY
    });

    expect(await reporter.maybeSend()).toMatchObject({ sent: false, reason: 'not_due' });
    expect(postMessage).not.toHaveBeenCalled();
    expect(client.getProjectTasksUnbounded).not.toHaveBeenCalled();
  });

  it('drops bugs closed outside the lookback window', async () => {
    const { reporter, postMessage } = harness({
      tasks: [task({ gid: 'ancient', completed_at: '2026-01-01T00:00:00Z' })],
      subtasks: { ancient: [{ name: 'Root cause analysis', completed: false }] },
    });

    expect(await reporter.maybeSend()).toMatchObject({ sent: false, reason: 'all_clear' });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('skips open tickets — only closed bugs owe an RCA', async () => {
    const { reporter, postMessage } = harness({
      tasks: [task({ gid: 'open', completed: false, completed_at: null, modified_at: '2026-07-27T12:00:00Z' })],
      subtasks: { open: [{ name: 'Engineering Escape RCA', completed: false }] },
    });

    expect(await reporter.maybeSend()).toMatchObject({ sent: false, reason: 'all_clear' });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('never lists a bug that reached Done before the hard floor', async () => {
    const { reporter, postMessage } = harness({
      // Closed a minute before today's 08:00 NY floor.
      tasks: [task({ gid: 'yesterday', completed_at: '2026-07-28T11:59:00Z' })],
      subtasks: { yesterday: [{ name: 'QA Escape RCA', completed: false }] },
      startAtMs: Date.parse('2026-07-28T12:00:00Z'),
    });

    expect(await reporter.maybeSend()).toMatchObject({ sent: false, reason: 'all_clear' });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('lists a bug that reached Done after the floor', async () => {
    const { reporter, postMessage } = harness({
      tasks: [task({ gid: 'today', name: 'Bug: fresh one', completed_at: '2026-07-28T13:00:00Z' })],
      subtasks: { today: [{ name: 'Engineering Escape RCA', completed: false }] },
      startAtMs: Date.parse('2026-07-28T12:00:00Z'),
    });

    expect(await reporter.maybeSend()).toMatchObject({ sent: true, tickets: 1 });
    expect(postMessage.mock.calls[0][0].text).toContain('Bug: fresh one');
  });

  it('dates a Done-parked ticket by its section move, not its last edit', async () => {
    const { reporter, postMessage } = harness({
      tasks: [
        task({
          gid: 'parked',
          completed: false,
          completed_at: null,
          // Edited this morning, so modified_at clears the floor on its own.
          modified_at: '2026-07-28T13:30:00Z',
          memberships: [{ section: { gid: DONE_SECTION } }],
        }),
      ],
      subtasks: { parked: [{ name: 'QA Escape RCA', completed: false }] },
      stories: {
        parked: [
          {
            gid: 's1',
            created_at: '2026-07-20T10:00:00Z',
            resource_subtype: 'section_changed',
            text: 'Matt moved this task from "QA Review" to "Done" in Software Board',
          },
        ],
      },
      startAtMs: Date.parse('2026-07-28T12:00:00Z'),
    });

    expect(await reporter.maybeSend()).toMatchObject({ sent: false, reason: 'all_clear' });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('falls back to the Asana name when the assignee has no Slack account', async () => {
    const { reporter, postMessage } = harness({
      tasks: [task({ gid: 'b1', assignee: { gid: 'u', name: 'Jen Doe', email: 'jen@gantri.com' } })],
      subtasks: { b1: [{ name: 'QA Escape RCA', completed: false }] },
    });

    await reporter.maybeSend();

    expect(postMessage.mock.calls[0][0].text).toContain('Jen Doe');
  });
});
