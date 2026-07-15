import { describe, it, expect, vi } from 'vitest';
import { TierPoller } from '../../../../../src/connectors/asana/tier/poller.js';
import type { AsanaApiClient, AsanaTask } from '../../../../../src/connectors/asana/client.js';
import type { TierClassificationsRepo, TierClassificationRecord } from '../../../../../src/storage/repositories/tier-classifications.js';
import {
  CODE_REVIEW_SECTION_GID,
  DELIVERY_TIER_FIELD_GID,
  TYPE_FIELD_GID,
  tierToOptionGid,
} from '../../../../../src/connectors/asana/board-config.js';
import { tierInputHash } from '../../../../../src/connectors/asana/tier/extract.js';
import type { AuthoritativePass } from '../../../../../src/connectors/asana/tier/authoritative-pass.js';

const PROMPT = 'Version: 1\n\nrubric';
const PROMPT_VERSION = 1;
const ROLLOUT_MS = Date.parse('2026-07-14T00:00:00Z');

/** A signals envelope that decides to T0 (cosmetic, no behavior change). */
const T0_FACTS = {
  tier: 'T0',
  domain: 'content_marketing',
  why: 'Step 2: cosmetic copy change',
  evidence: 'fix the label',
  signals: {
    ui_testable: { value: 'yes', evidence: 'clickable' },
    behavior_change: { value: 'no', evidence: '' },
    cosmetic_only: { value: 'yes', evidence: 'fix the label' },
    money: { value: 'no', evidence: '' },
    irreversible_external: { value: 'no', evidence: '' },
    data_integrity: { value: 'no', evidence: '' },
    access_security: { value: 'no', evidence: '' },
    visual_blast_radius: { value: 'no', evidence: '' },
  },
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
  /** Put the task in the board's Code Review section (drives the authoritative pass). */
  inCodeReview?: boolean;
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
    memberships: o.inCodeReview ? [{ section: { gid: CODE_REVIEW_SECTION_GID, name: 'Code Review' } }] : [],
  };
}

/** Build a poller over a fixed task list + injectable repo. `getTask` re-reads the
 *  same task list by gid (the poller re-reads the field fresh before writing);
 *  override `freshByGid` to simulate a human setting the field in that window. */
function buildPoller(
  tasks: AsanaTask[],
  repo: Partial<TierClassificationsRepo>,
  freshByGid?: Record<string, AsanaTask>,
  authoritative?: AuthoritativePass,
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
    authoritative,
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
    // The comment is posted BEFORE the field write (papertrail: explanation → field).
    const commentOrder = (client.createStory as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const fieldOrder = (client.setEnumCustomField as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(commentOrder).toBeLessThan(fieldOrder);
    // Three durable records: a pre-write record (before any Asana write), a
    // comment-persist (durable comment gid before the field write, still
    // unconfirmed), then a finalize with the confirmed tier.
    const upserts = (repo.upsertBot as ReturnType<typeof vi.fn>).mock.calls;
    expect(upserts.length).toBe(3);
    // The poller writes the PROVISIONAL pass.
    expect(upserts[0][0]).toMatchObject({ tier: 'T0', confirmedTier: null, commentGid: null, stage: 'provisional' });
    // The comment-persist carries the comment gid but is still unconfirmed.
    expect(upserts[1][0]).toMatchObject({ tier: 'T0', confirmedTier: null, commentGid: 'story-1', stage: 'provisional' });
    const final = upserts[upserts.length - 1][0];
    expect(final.tier).toBe('T0');
    expect(final.confirmedTier).toBe('T0');
    expect(final.commentGid).toBe('story-1');
    expect(final.stage).toBe('provisional');
    // The comment carries the provisional note.
    expect((client.createStory as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('Provisional — will be confirmed');
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

  it('records a human override when a human CLEARS a field the bot had confirmed', async () => {
    // Bot confirmed T1 (confirmedTier === tier). A human then cleared the field to
    // disagree. An empty field with confirmedTier === tier can only be a human clear
    // (a crashed write leaves confirmedTier below tier), so it must be recorded as an
    // override and never re-applied — not repaired forever.
    const record: Partial<TierClassificationRecord> = {
      taskGid: 'c1',
      tier: 'T1',
      confirmedTier: 'T1',
      decidedBy: 'bot',
      inputHash: 'h',
    };
    const { poller, client, repo } = buildPoller(
      [task({ gid: 'c1', tierOptionGid: null })],
      { get: vi.fn().mockResolvedValue(record) },
    );
    const res = await poller.runOnce();
    expect(res.overrides).toBe(1);
    expect(repo.markOverride).toHaveBeenCalledWith('c1', null);
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
    const record: Partial<TierClassificationRecord> = { taskGid: 'i1', tier: 'T0', confirmedTier: 'T0', decidedBy: 'bot', inputHash: hash, commentGid: 'story-existing' };
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
      commentGid: 'story-old',
    };
    const { poller, client, repo } = buildPoller([t], { get: vi.fn().mockResolvedValue(record) });
    const res = await poller.runOnce();
    expect(res.reclassified).toBe(1);
    expect(client.setEnumCustomField).toHaveBeenCalledTimes(1);
    // Pre-write record + comment-persist + finalize.
    expect(repo.upsertBot).toHaveBeenCalledTimes(3);
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

describe('TierPoller.runOnce — authoritative rows are not provisionally downgraded', () => {
  it('a notes edit after the Code-Review authoritative pass never re-runs the text classifier', async () => {
    // The authoritative pass finalized this ticket at T2 from the PR diff (stage
    // 'authoritative', field T2). The author then edited the description, changing
    // the input hash. The provisional text classifier (mock always returns T0) must
    // NOT run: no field write, no comment, no downgrade. The tier only moves again
    // when a new head_sha re-runs the authoritative pass.
    const t = task({ gid: 'f1', tierOptionGid: tierToOptionGid('T2') });
    const record: Partial<TierClassificationRecord> = {
      taskGid: 'f1',
      tier: 'T2',
      confirmedTier: 'T2',
      stage: 'authoritative',
      decidedBy: 'bot',
      inputHash: 'stale-hash-from-old-notes',
      commentGid: 'story-old',
    };
    const { poller, client, repo, claude } = buildPoller([t], { get: vi.fn().mockResolvedValue(record) });
    const res = await poller.runOnce();
    expect(res.skipped).toBe(1);
    expect(res.reclassified).toBe(0);
    expect(claude.messages.create).not.toHaveBeenCalled();
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
    expect(client.createStory).not.toHaveBeenCalled();
    expect(repo.upsertBot).not.toHaveBeenCalled();
  });

  it('a provisional row IS re-classified on a notes edit (the gate is stage-specific)', async () => {
    // Same setup but stage 'provisional' → the text classifier runs and updates.
    const t = task({ gid: 'p1', tierOptionGid: tierToOptionGid('T1') });
    const record: Partial<TierClassificationRecord> = {
      taskGid: 'p1',
      tier: 'T1',
      confirmedTier: 'T1',
      stage: 'provisional',
      decidedBy: 'bot',
      inputHash: 'stale-hash-from-old-notes',
      commentGid: 'story-old',
    };
    const { poller, client } = buildPoller([t], { get: vi.fn().mockResolvedValue(record) });
    const res = await poller.runOnce();
    expect(res.reclassified).toBe(1);
    expect(client.setEnumCustomField).toHaveBeenCalled();
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
      calibrationMismatch: false,
      stage: 'provisional',
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
      calibrationMismatch: false,
      stage: 'provisional',
      flags: [],
      domain: 'shopping_checkout',
      decidedBy: 'bot',
      humanTier: null,
      commentGid: 'story-x',
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

describe('TierPoller.runOnce — finalizeConfirmed backfills a missing comment', () => {
  it('posts the rubric comment when the field write landed but createStory had failed', async () => {
    // The field already holds the bot's decided tier (T0) but the record has no
    // commentGid: the previous tick's createStory failed after the field write. The
    // poller must backfill the comment (no LLM re-classify) and finalize.
    const t = task({ gid: 'bf1', tierOptionGid: tierToOptionGid('T0') });
    const hash = tierInputHash(PROMPT_VERSION, { name: t.name, notes: t.notes!, typeName: 'Feature' });
    const record: Partial<TierClassificationRecord> = {
      taskGid: 'bf1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      facts: JSON.parse(JSON.stringify(T0_FACTS.signals)) as any,
      tier: 'T0',
      confirmedTier: 'T0',
      decidedBy: 'bot',
      stage: 'provisional',
      inputHash: hash,
      commentGid: null,
      promptVersion: PROMPT_VERSION,
    };
    // The record's facts have no `domain`/`llmTier`; decideTier tolerates the missing
    // domain via the base-table lookup returning undefined → treat as unknown at render.
    (record.facts as Record<string, unknown>).domain = 'content_marketing';
    (record.facts as Record<string, unknown>).llmTier = null;
    const { poller, client } = buildPoller([t], { get: vi.fn().mockResolvedValue(record) });
    const res = await poller.runOnce();
    expect(res.skipped).toBe(1);
    // No field write (already correct) and no LLM re-classification, but the comment
    // is backfilled with the provisional note.
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
    expect(client.createStory).toHaveBeenCalledTimes(1);
    expect((client.createStory as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('Provisional — will be confirmed');
  });
});

describe('TierPoller.runOnce — Code-Review authoritative pass wiring', () => {
  it('hands the tasks in Code Review to the authoritative pass and folds in its result', async () => {
    const reviewCodeReviewTasks = vi.fn().mockResolvedValue({
      considered: 1,
      confirmed: 0,
      superseded: 1,
      humanOwned: 0,
      skipped: 0,
      failed: 0,
    });
    const authoritative = { reviewCodeReviewTasks } as unknown as AuthoritativePass;
    const inReview = task({ gid: 'cr1', tierOptionGid: tierToOptionGid('T1'), inCodeReview: true });
    const notInReview = task({ gid: 'plain' });
    const { poller } = buildPoller([inReview, notInReview], {}, undefined, authoritative);
    const res = await poller.runOnce();
    expect(reviewCodeReviewTasks).toHaveBeenCalledTimes(1);
    const handed = reviewCodeReviewTasks.mock.calls[0][0] as AsanaTask[];
    expect(handed.map((t) => t.gid)).toEqual(['cr1']);
    expect(res.authoritative).toMatchObject({ superseded: 1 });
  });

  it('leaves result.authoritative null when no authoritative pass is configured', async () => {
    const { poller } = buildPoller([task({ gid: 'x', inCodeReview: true })], {});
    const res = await poller.runOnce();
    expect(res.authoritative).toBeNull();
  });

  it('the Code-Review lane ignores the rollout cutoff: pre-rollout and thin-notes tickets ARE handed to the pass; excluded Types are not', async () => {
    // The tier is consumed at the Code-Review → QA handoff, so the whole in-flight
    // backlog that reaches Code Review must be classifiable — including tickets
    // created before ROLLOUT_DATE, and (at this poller stage) thin-notes tickets,
    // since a ticket with a findable PR is diffed regardless of description length.
    // Only the excluded-Type ticket is still filtered out.
    const reviewCodeReviewTasks = vi.fn().mockResolvedValue({
      considered: 3,
      confirmed: 3,
      superseded: 0,
      humanOwned: 0,
      skipped: 0,
      failed: 0,
    });
    const authoritative = { reviewCodeReviewTasks } as unknown as AuthoritativePass;
    const eligible = task({ gid: 'ok', inCodeReview: true });
    const preRollout = task({ gid: 'old', inCodeReview: true, createdAt: '2026-07-01T00:00:00Z' });
    const excludedType = task({ gid: 'research', inCodeReview: true, typeName: 'Research' });
    const thinNotes = task({ gid: 'thin', inCodeReview: true, notes: 'short' });
    const { poller } = buildPoller([eligible, preRollout, excludedType, thinNotes], {}, undefined, authoritative);
    await poller.runOnce();
    const handed = reviewCodeReviewTasks.mock.calls[0][0] as AsanaTask[];
    expect(handed.map((t) => t.gid)).toEqual(['ok', 'old', 'thin']);
  });

  it('a pre-rollout ticket NOT in Code Review is still skipped everywhere (the provisional rollout gate is intact)', async () => {
    // The rollout cutoff is only lifted for the Code-Review lane. A pre-rollout
    // ticket that is NOT in Code Review must neither be classified provisionally
    // (no board-wide backfill) nor handed to the authoritative pass.
    const reviewCodeReviewTasks = vi.fn().mockResolvedValue({
      considered: 0,
      confirmed: 0,
      superseded: 0,
      humanOwned: 0,
      skipped: 0,
      failed: 0,
    });
    const authoritative = { reviewCodeReviewTasks } as unknown as AuthoritativePass;
    const preRollout = task({ gid: 'old', createdAt: '2026-07-01T00:00:00Z' });
    const { poller, client } = buildPoller([preRollout], {}, undefined, authoritative);
    const res = await poller.runOnce();
    expect(res.candidates).toBe(0);
    expect(res.classified).toBe(0);
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
    const handed = reviewCodeReviewTasks.mock.calls[0][0] as AsanaTask[];
    expect(handed).toEqual([]);
  });
});
