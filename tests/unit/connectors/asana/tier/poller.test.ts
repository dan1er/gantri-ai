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

/** Build a poller over a fixed task list + injectable repo. */
function buildPoller(tasks: AsanaTask[], repo: Partial<TierClassificationsRepo>) {
  const client = {
    getProjectTasks: vi.fn().mockResolvedValue(tasks),
    setEnumCustomField: vi.fn().mockResolvedValue(undefined),
    createStory: vi.fn().mockResolvedValue({ gid: 'story-1' }),
  } as unknown as AsanaApiClient;
  const claude = claudeAlwaysT0();
  const fullRepo = {
    get: vi.fn().mockResolvedValue(null),
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
    expect(repo.upsertBot).toHaveBeenCalledTimes(1);
    const rec = (repo.upsertBot as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(rec.tier).toBe('T0');
    expect(rec.commentGid).toBe('story-1');
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
    const record: Partial<TierClassificationRecord> = { taskGid: 'i1', tier: 'T0', decidedBy: 'bot', inputHash: hash };
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
      decidedBy: 'bot',
      inputHash: 'stale-hash-from-old-notes',
    };
    const { poller, client, repo } = buildPoller([t], { get: vi.fn().mockResolvedValue(record) });
    const res = await poller.runOnce();
    expect(res.reclassified).toBe(1);
    expect(client.setEnumCustomField).toHaveBeenCalledTimes(1);
    expect(repo.upsertBot).toHaveBeenCalledTimes(1);
  });
});
