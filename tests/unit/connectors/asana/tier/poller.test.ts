import { describe, it, expect, vi } from 'vitest';
import { TierPoller } from '../../../../../src/connectors/asana/tier/poller.js';
import type { AsanaApiClient, AsanaTask } from '../../../../../src/connectors/asana/client.js';
import type { TierClassificationsRepo, TierClassificationRecord } from '../../../../../src/storage/repositories/tier-classifications.js';
import {
  DELIVERY_TIER_FIELD_GID,
  TYPE_FIELD_GID,
  tierToOptionGid,
} from '../../../../../src/connectors/asana/board-config.js';
import { tierInputHash } from '../../../../../src/connectors/asana/tier/extract.js';

const PROMPT = 'Version: 1\n\nrubric';
const PROMPT_VERSION = 1;
const ROLLOUT_MS = Date.parse('2026-07-14T00:00:00Z');

/** A facts object that decides to T0 (low-risk). */
const T0_FACTS = {
  ui_testable: { value: 'yes', evidence: 'clickable' },
  irreversible_external: { value: 'no', evidence: '' },
  money_visible: { value: 'no', evidence: '' },
  visual_blast_radius: { value: 'no', evidence: '' },
  brand_critical: { value: 'no', evidence: '' },
  backend_data: { value: 'no', evidence: '' },
  coordinated_launch: { value: 'no', evidence: '' },
  domain: 'content_marketing',
};

function claudeAlwaysT0() {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(T0_FACTS) }] }),
    },
  };
}

interface TaskOpts {
  gid: string;
  createdAt?: string;
  notes?: string;
  completed?: boolean;
  typeName?: string;
  tierOptionGid?: string | null;
}

function task(o: TaskOpts): AsanaTask {
  const cf: NonNullable<AsanaTask['custom_fields']> = [
    { gid: TYPE_FIELD_GID, name: 'Type', enum_value: { gid: 'type-opt', name: o.typeName ?? 'Feature' } },
  ];
  cf.push({
    gid: DELIVERY_TIER_FIELD_GID,
    name: 'Delivery Tier',
    enum_value: o.tierOptionGid ? { gid: o.tierOptionGid } : null,
  });
  return {
    gid: o.gid,
    name: `Task ${o.gid}`,
    completed: o.completed ?? false,
    created_at: o.createdAt ?? '2026-07-20T00:00:00Z',
    notes: o.notes ?? 'x'.repeat(60),
    custom_fields: cf,
  };
}

/** Build a poller over a fixed task list + injectable repo. `getTask` re-reads the
 *  same task list by gid (the poller re-reads the field fresh before writing);
 *  override `freshByGid` to simulate a human setting the field in that window. */
function buildPoller(
  tasks: AsanaTask[],
  repo: Partial<TierClassificationsRepo>,
  freshByGid?: Record<string, AsanaTask>,
) {
  const client = {
    getProjectTasksUnbounded: vi.fn().mockResolvedValue(tasks),
    getTask: vi.fn((gid: string) =>
      Promise.resolve(freshByGid?.[gid] ?? tasks.find((t) => t.gid === gid)),
    ),
    setEnumCustomField: vi.fn().mockResolvedValue(undefined),
    createStory: vi.fn().mockResolvedValue({ gid: 'story-1' }),
  } as unknown as AsanaApiClient;
  const claude = claudeAlwaysT0();
  const fullRepo = {
    get: vi.fn().mockResolvedValue(null),
    listActiveBot: vi.fn().mockResolvedValue([]),
    upsertBot: vi.fn().mockResolvedValue(undefined),
    markOverride: vi.fn().mockResolvedValue(undefined),
    ...repo,
  } as unknown as TierClassificationsRepo;
  const poller = new TierPoller({
    client,
    repo: fullRepo,
    extract: { claude, prompt: PROMPT },
    promptVersion: PROMPT_VERSION,
    rolloutDateMs: ROLLOUT_MS,
  });
  return { poller, client, repo: fullRepo, claude };
}

describe('TierPoller.runOnce — candidate gating', () => {
  it('classifies an eligible task with an empty tier field: sets the field + posts a comment + records it', async () => {
    const { poller, client, repo } = buildPoller([task({ gid: 't1' })], {});
    const res = await poller.runOnce();
    expect(res.classified).toBe(1);
    expect(client.setEnumCustomField).toHaveBeenCalledWith('t1', DELIVERY_TIER_FIELD_GID, tierToOptionGid('T0'));
    expect(client.createStory).toHaveBeenCalledTimes(1);
    // A pre-write record (durable before the field write) then a finalize with the
    // comment gid and the confirmed tier.
    const upserts = (repo.upsertBot as ReturnType<typeof vi.fn>).mock.calls;
    expect(upserts.length).toBe(2);
    expect(upserts[0][0]).toMatchObject({ tier: 'T0', confirmedTier: null, commentGid: null });
    const final = upserts[upserts.length - 1][0];
    expect(final.tier).toBe('T0');
    expect(final.confirmedTier).toBe('T0');
    expect(final.commentGid).toBe('story-1');
  });

  it('excludes tasks created before ROLLOUT_DATE, thin descriptions, completed tasks, and excluded Types', async () => {
    const tasks = [
      task({ gid: 'old', createdAt: '2026-07-01T00:00:00Z' }),
      task({ gid: 'thin', notes: 'too short' }),
      task({ gid: 'done', completed: true }),
      task({ gid: 'research', typeName: 'Research' }),
    ];
    const { poller, client } = buildPoller(tasks, {});
    const res = await poller.runOnce();
    expect(res.candidates).toBe(0);
    expect(res.classified).toBe(0);
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
  });
});

describe('TierPoller.runOnce — human overrides & idempotency', () => {
  it('skips a task a human set before the bot ever saw it (field set, no record)', async () => {
    const { poller, client, repo } = buildPoller(
      [task({ gid: 'h1', tierOptionGid: tierToOptionGid('T2') })],
      { get: vi.fn().mockResolvedValue(null) },
    );
    const res = await poller.runOnce();
    expect(res.skipped).toBe(1);
    expect(res.classified).toBe(0);
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
    expect(repo.markOverride).not.toHaveBeenCalled();
  });

  it('records a human override when the field no longer matches the bot record', async () => {
    const record: Partial<TierClassificationRecord> = {
      taskGid: 'o1',
      tier: 'T0',
      confirmedTier: 'T0',
      decidedBy: 'bot',
      inputHash: 'whatever',
    };
    const { poller, client, repo } = buildPoller(
      // Bot set T0, but the field now reads T2 → a human raised it.
      [task({ gid: 'o1', tierOptionGid: tierToOptionGid('T2') })],
      { get: vi.fn().mockResolvedValue(record) },
    );
    const res = await poller.runOnce();
    expect(res.overrides).toBe(1);
    expect(repo.markOverride).toHaveBeenCalledWith('o1', 'T2');
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
  });

  it('never touches a task already flagged human_override', async () => {
    const record: Partial<TierClassificationRecord> = { taskGid: 'ov', tier: 'T0', decidedBy: 'human_override' };
    const { poller, client, repo } = buildPoller(
      [task({ gid: 'ov', tierOptionGid: tierToOptionGid('T1') })],
      { get: vi.fn().mockResolvedValue(record) },
    );
    const res = await poller.runOnce();
    expect(res.skipped).toBe(1);
    expect(repo.markOverride).not.toHaveBeenCalled();
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
  });

  it('is idempotent: a bot task whose notes hash is unchanged is skipped (no re-classify)', async () => {
    const t = task({ gid: 'i1', tierOptionGid: tierToOptionGid('T0') });
    const hash = tierInputHash(PROMPT_VERSION, { name: t.name, notes: t.notes!, typeName: 'Feature' });
    const record: Partial<TierClassificationRecord> = { taskGid: 'i1', tier: 'T0', confirmedTier: 'T0', decidedBy: 'bot', inputHash: hash };
    const { poller, client } = buildPoller([t], { get: vi.fn().mockResolvedValue(record) });
    const res = await poller.runOnce();
    expect(res.skipped).toBe(1);
    expect(res.reclassified).toBe(0);
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
  });

  it('re-classifies a bot task when the notes hash changed', async () => {
    const t = task({ gid: 'r1', tierOptionGid: tierToOptionGid('T0') });
    const record: Partial<TierClassificationRecord> = {
      taskGid: 'r1',
      tier: 'T0',
      confirmedTier: 'T0',
      decidedBy: 'bot',
      inputHash: 'stale-hash-from-old-notes',
    };
    const { poller, client, repo } = buildPoller([t], { get: vi.fn().mockResolvedValue(record) });
    const res = await poller.runOnce();
    expect(res.reclassified).toBe(1);
    expect(client.setEnumCustomField).toHaveBeenCalledTimes(1);
    // Pre-write record + finalize.
    expect(repo.upsertBot).toHaveBeenCalledTimes(2);
  });
});

describe('TierPoller.runOnce — crash recovery & TOCTOU (never freeze on a partial write)', () => {
  it('recovers a lost field write instead of misreading it as a human override', async () => {
    // The bot decided T1 and recorded it, but the field write never landed (crash):
    // the field still shows the previously confirmed T0. Next tick must re-apply the
    // T1 write, NOT record a bot-T1 → human-T0 "override".
    const record: Partial<TierClassificationRecord> = {
      taskGid: 'p1',
      tier: 'T1',
      confirmedTier: 'T0',
      decidedBy: 'bot',
      inputHash: 'hash',
      commentGid: 'story-old',
    };
    const { poller, client, repo } = buildPoller(
      [task({ gid: 'p1', tierOptionGid: tierToOptionGid('T0') })],
      { get: vi.fn().mockResolvedValue(record) },
    );
    const res = await poller.runOnce();
    expect(res.reclassified).toBe(1);
    expect(res.overrides).toBe(0);
    expect(repo.markOverride).not.toHaveBeenCalled();
    // Re-applies the decided T1 with no new LLM extraction.
    expect(client.setEnumCustomField).toHaveBeenCalledWith('p1', DELIVERY_TIER_FIELD_GID, tierToOptionGid('T1'));
  });

  it('orphan recovery: a bot record with an empty field re-applies the write (no human-set assumption)', async () => {
    const record: Partial<TierClassificationRecord> = {
      taskGid: 'p2',
      tier: 'T0',
      confirmedTier: null,
      decidedBy: 'bot',
      inputHash: 'hash',
      commentGid: 'story-old',
    };
    const { poller, client } = buildPoller(
      [task({ gid: 'p2', tierOptionGid: null })],
      { get: vi.fn().mockResolvedValue(record) },
    );
    const res = await poller.runOnce();
    expect(res.reclassified).toBe(1);
    expect(client.setEnumCustomField).toHaveBeenCalledWith('p2', DELIVERY_TIER_FIELD_GID, tierToOptionGid('T0'));
  });

  it('aborts the write when a human sets the field during the scan→write window', async () => {
    // Scan sees an empty field; by the time the bot re-reads before writing, a human
    // has set T2. The bot must respect it: no field write, record the override.
    const scanTask = task({ gid: 'w1', tierOptionGid: null });
    const humanEdited = task({ gid: 'w1', tierOptionGid: tierToOptionGid('T2') });
    const { poller, client, repo } = buildPoller(
      [scanTask],
      { get: vi.fn().mockResolvedValue(null) },
      { w1: humanEdited },
    );
    const res = await poller.runOnce();
    expect(res.overrides).toBe(1);
    expect(repo.markOverride).toHaveBeenCalledWith('w1', 'T2');
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
  });
});

describe('TierPoller.runOnce — override sweep over non-candidates', () => {
  it('records a human override on a COMPLETED task the bot had classified', async () => {
    // A completed task is not a candidate, so processOne never runs — but a human
    // re-tiered it (bot T1 → human T2) and that disagreement must still be captured.
    const record: TierClassificationRecord = {
      taskGid: 'done1',
      inputHash: 'h',
      promptVersion: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      facts: {} as any,
      tier: 'T1',
      confirmedTier: 'T1',
      liftedByUnclear: false,
      flags: [],
      domain: 'shopping_checkout',
      decidedBy: 'bot',
      humanTier: null,
      commentGid: null,
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:00Z',
    };
    const { poller, client, repo } = buildPoller(
      [task({ gid: 'done1', completed: true, tierOptionGid: tierToOptionGid('T2') })],
      { listActiveBot: vi.fn().mockResolvedValue([record]) },
    );
    const res = await poller.runOnce();
    expect(res.candidates).toBe(0);
    expect(res.overrides).toBe(1);
    expect(repo.markOverride).toHaveBeenCalledWith('done1', 'T2');
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
  });

  it('does not flag a completed task whose field still matches the bot record', async () => {
    const record: TierClassificationRecord = {
      taskGid: 'done2',
      inputHash: 'h',
      promptVersion: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      facts: {} as any,
      tier: 'T1',
      confirmedTier: 'T1',
      liftedByUnclear: false,
      flags: [],
      domain: 'shopping_checkout',
      decidedBy: 'bot',
      humanTier: null,
      commentGid: null,
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:00Z',
    };
    const { poller, repo } = buildPoller(
      [task({ gid: 'done2', completed: true, tierOptionGid: tierToOptionGid('T1') })],
      { listActiveBot: vi.fn().mockResolvedValue([record]) },
    );
    const res = await poller.runOnce();
    expect(res.overrides).toBe(0);
    expect(repo.markOverride).not.toHaveBeenCalled();
  });
});
