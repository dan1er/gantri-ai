import { describe, it, expect, vi } from 'vitest';
import { AsanaConnector } from '../../../../src/connectors/asana/connector.js';
import type { AsanaApiClient, AsanaStory, AsanaTask } from '../../../../src/connectors/asana/client.js';
import { TYPE_FEATURE_OPTION_GID, TYPE_FIELD_GID } from '../../../../src/connectors/asana/board-config.js';

let seq = 0;
function move(name: string, from: string, to: string, at: string): AsanaStory {
  return {
    gid: `s${seq++}`,
    created_at: at,
    created_by: { name },
    resource_subtype: 'section_changed',
    text: `${name} moved this task from "${from}" to "${to}" in Software Board`,
  };
}

function feature(gid: string, name: string, extra: Partial<AsanaTask> = {}): AsanaTask {
  return {
    gid,
    name,
    created_at: '2026-05-01T00:00:00Z',
    modified_at: '2026-06-30T00:00:00Z',
    permalink_url: `https://app.asana.com/0/1210754051061529/${gid}`,
    custom_fields: [{ gid: TYPE_FIELD_GID, enum_value: { gid: TYPE_FEATURE_OPTION_GID } }],
    ...extra,
  };
}

/** Standard scenario: one real bug by QA, one process bounce by QA, one real
 *  bug by a dev, one clean pass, one out-of-window, one pruned, one non-feature. */
function buildScenario() {
  const tasks: AsanaTask[] = [
    feature('t1', 'Real bug feature'),
    feature('t2', 'Process feature'),
    feature('t3', 'Dev-only bounce feature'),
    feature('t4', 'Clean pass feature'),
    feature('t5', 'Out of window feature', { created_at: '2026-05-01T00:00:00Z', modified_at: '2026-07-10T00:00:00Z' }),
    feature('t6', 'Pruned feature', { created_at: '2026-01-01T00:00:00Z', modified_at: '2026-02-01T00:00:00Z' }),
    // Non-feature task (Bug) — must be filtered out.
    { gid: 'tb', name: 'A bug', custom_fields: [{ gid: TYPE_FIELD_GID, enum_value: { gid: 'bug-option' } }] } as AsanaTask,
  ];

  const storiesByGid: Record<string, AsanaStory[]> = {
    t1: [move('Matthew Fite', 'QA Review', 'Rework', '2026-06-10T12:00:00Z')],
    t2: [move('Joshua Nie', 'QA Review', 'Code Review', '2026-06-11T12:00:00Z')],
    t3: [move('Francisco Bautista', 'QA Review', 'Rework', '2026-06-12T12:00:00Z')],
    t4: [
      move('Danny', 'Code Review', 'QA Review', '2026-06-13T10:00:00Z'),
      move('Matthew Fite', 'QA Review', 'Ready To Deploy', '2026-06-14T10:00:00Z'),
    ],
    t5: [move('Matthew Fite', 'QA Review', 'Rework', '2026-07-10T12:00:00Z')],
    t6: [],
  };

  // Only t1 (a QA bounce) has a defect sub-task logged near the bounce.
  const subtasksByGid: Record<string, AsanaTask[]> = {
    t1: [
      {
        gid: 't1-sub1',
        name: 'Header image 404s on load',
        created_at: '2026-06-10T12:30:00Z',
        created_by: { name: 'Matthew Fite' },
      } as AsanaTask,
    ],
  };

  const client = {
    getProjectTasks: vi.fn(async () => tasks),
    getTaskStories: vi.fn(async (gid: string) => storiesByGid[gid] ?? []),
    getTaskSubtasks: vi.fn(async (gid: string) => subtasksByGid[gid] ?? []),
    getCurrentUser: vi.fn(async () => ({ gid: 'u', name: 'Bot' })),
  } as unknown as AsanaApiClient;

  return { client, tasks, storiesByGid, subtasksByGid };
}

function claudeReturning(rows: Array<{ gid: string; isRealBug: boolean; reason: string }>) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(rows) }] }),
    },
  };
}

const RANGE = { dateRange: { startDate: '2026-06-01', endDate: '2026-06-30' } };

describe('asana.feature_qa_stats — happy path', () => {
  it('computes totals, finders, and per-feature outcomes', async () => {
    const { client } = buildScenario();
    const claude = claudeReturning([
      { gid: 't1', isRealBug: true, reason: 'image 404 on PDP' },
      { gid: 't2', isRealBug: false, reason: 'unclear acceptance criteria' },
      { gid: 't3', isRealBug: true, reason: 'broken submit flow' },
    ]);
    const conn = new AsanaConnector({ client, claude });
    const out = await conn.tools[0].execute(RANGE) as any;

    expect(out.period).toEqual({ startDate: '2026-06-01', endDate: '2026-06-30' });
    expect(out.board).toBe('Software Board');
    expect(out.degraded).toBe(false);

    expect(out.totals).toMatchObject({
      featuresWithQaActivity: 4, // t1,t2,t3,t4 (t5 out of window, t6 pruned)
      featuresBouncedAny: 3,
      featuresRealBugByQa: 1, // t1 only (t3 is a real bug but found by a dev)
      featuresProcessBounceOnly: 1, // t2
      featuresBouncedByNonQaOnly: 1, // t3
      featuresUnclassified: 0,
      realBugRatePct: 25.0,
      anyBounceRatePct: 75.0,
    });

    // Pruned feature never has its stories fetched.
    expect((client.getTaskStories as any).mock.calls.map((c: any[]) => c[0])).not.toContain('t6');

    const byName = Object.fromEntries(out.finders.map((f: any) => [f.name, f]));
    expect(byName['Matthew Fite']).toMatchObject({ shortName: 'Matt', isQa: true, featuresWithRealBugs: 1, featuresWithAnyBounce: 1 });
    expect(byName['Joshua Nie']).toMatchObject({ shortName: 'Josh', isQa: true, featuresWithRealBugs: 0, featuresWithAnyBounce: 1 });
    expect(byName['Francisco Bautista']).toMatchObject({ shortName: 'Francisco', isQa: false, featuresWithRealBugs: 1, featuresWithAnyBounce: 1 });

    const byGid = Object.fromEntries(out.features.map((f: any) => [f.gid, f]));
    expect(byGid.t1.outcome).toBe('real_bug');
    expect(byGid.t2.outcome).toBe('process_bounce');
    expect(byGid.t3.outcome).toBe('real_bug');
    expect(byGid.t4.outcome).toBe('clean_pass');
    expect(byGid.t4.finders).toEqual([]);
    expect(byGid.t1.url).toContain('/t1');
  });
});

describe('asana.feature_qa_stats — includeFeatures=false', () => {
  it('omits the per-feature detail but keeps totals', async () => {
    const { client } = buildScenario();
    const claude = claudeReturning([
      { gid: 't1', isRealBug: true, reason: 'x' },
      { gid: 't2', isRealBug: false, reason: 'y' },
      { gid: 't3', isRealBug: true, reason: 'z' },
    ]);
    const conn = new AsanaConnector({ client, claude });
    const out = await conn.tools[0].execute({ ...RANGE, includeFeatures: false }) as any;
    expect(out.features).toEqual([]);
    expect(out.totals.featuresWithQaActivity).toBe(4);
    expect(out.finders.length).toBeGreaterThan(0);
  });
});

describe('asana.feature_qa_stats — degraded classifier', () => {
  it('counts bounced features as unclassified and sets degraded=true', async () => {
    const { client } = buildScenario();
    const claude = { messages: { create: vi.fn().mockRejectedValue(new Error('overloaded')) } };
    const conn = new AsanaConnector({ client, claude });
    const out = await conn.tools[0].execute(RANGE) as any;

    expect(out.degraded).toBe(true);
    expect(out.totals).toMatchObject({
      featuresWithQaActivity: 4,
      featuresBouncedAny: 3,
      featuresRealBugByQa: 0,
      featuresProcessBounceOnly: 0,
      featuresUnclassified: 3,
      featuresBouncedByNonQaOnly: 1, // finder attribution is deterministic, independent of the LLM
      realBugRatePct: 0,
      anyBounceRatePct: 75.0,
    });
    const byGid = Object.fromEntries(out.features.map((f: any) => [f.gid, f]));
    expect(byGid.t1.outcome).toBe('unclassified');
    expect(byGid.t4.outcome).toBe('clean_pass');
  });
});

describe('asana.feature_qa_stats — schema', () => {
  it('accepts a preset string dateRange', async () => {
    const { client } = buildScenario();
    const claude = claudeReturning([]);
    const conn = new AsanaConnector({ client, claude });
    const parsed = conn.tools[0].schema.safeParse({ dateRange: 'last_30_days' });
    expect(parsed.success).toBe(true);
    const out = await conn.tools[0].execute({ dateRange: 'last_30_days' }) as any;
    expect(out.period.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out.board).toBe('Software Board');
  });
});

describe('asana.feature_qa_stats — subtask evidence', () => {
  it('fetches subtasks ONLY for bounced features and feeds them into the classifier prompt', async () => {
    const { client } = buildScenario();
    // Capture the classifier prompt so we can assert the subtask line reaches it.
    const create = vi.fn(async (args: any) => {
      const content: string = args.messages[0].content;
      const gids = [...content.matchAll(/"gid":"(t\d)"/g)].map((m) => m[1]);
      return { content: [{ type: 'text', text: JSON.stringify(gids.map((gid) => ({ gid, isRealBug: true, reason: 'r' }))) }] };
    });
    const conn = new AsanaConnector({ client, claude: { messages: { create } } });
    await conn.tools[0].execute(RANGE);

    // Subtasks fetched for the 3 bounced features only (t1,t2,t3) — not the clean
    // pass (t4), the out-of-window (t5), or the pruned (t6) feature.
    const subtaskGids = (client.getTaskSubtasks as any).mock.calls.map((c: any[]) => c[0]).sort();
    expect(subtaskGids).toEqual(['t1', 't2', 't3']);

    // The t1 defect subtask is serialized into the classifier prompt as evidence.
    const prompt: string = create.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('subtask created by Matthew Fite: \\"Header image 404s on load\\"');
  });
});

describe('asana.feature_qa_stats — template filter', () => {
  it('excludes the "Feature template" artifact even when it shows QA activity', async () => {
    const templateTask = feature('tmpl', 'Feature template', {
      created_at: '2026-05-01T00:00:00Z',
      modified_at: '2026-06-30T00:00:00Z',
    });
    const templateStories = [move('Matthew Fite', 'QA Review', 'Rework', '2026-06-15T12:00:00Z')];

    const client = {
      getProjectTasks: vi.fn(async () => [feature('t1', 'Real feature'), templateTask]),
      getTaskStories: vi.fn(async (gid: string) =>
        gid === 't1'
          ? [move('Matthew Fite', 'QA Review', 'Rework', '2026-06-10T12:00:00Z')]
          : templateStories,
      ),
      getTaskSubtasks: vi.fn(async () => []),
      getCurrentUser: vi.fn(async () => ({ gid: 'u', name: 'Bot' })),
    } as unknown as AsanaApiClient;

    const claude = claudeReturning([{ gid: 't1', isRealBug: true, reason: 'x' }]);
    const conn = new AsanaConnector({ client, claude });
    const out = await conn.tools[0].execute(RANGE) as any;

    // Only the real feature counts; the template is dropped before story fetch.
    expect(out.totals.featuresWithQaActivity).toBe(1);
    expect((client.getTaskStories as any).mock.calls.map((c: any[]) => c[0])).not.toContain('tmpl');
    expect(out.features.map((f: any) => f.name)).toEqual(['Real feature']);
  });
});
