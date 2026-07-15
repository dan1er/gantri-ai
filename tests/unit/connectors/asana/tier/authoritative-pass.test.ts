import { describe, it, expect, vi } from 'vitest';
import {
  AuthoritativePass,
  extractAsanaTaskGid,
  extractPrLinks,
} from '../../../../../src/connectors/asana/tier/authoritative-pass.js';
import type { AsanaApiClient, AsanaStory, AsanaTask } from '../../../../../src/connectors/asana/client.js';
import type { GithubDispatcher } from '../../../../../src/devops/github.js';
import type { TierClassificationsRepo, TierClassificationRecord } from '../../../../../src/storage/repositories/tier-classifications.js';
import type { TierPrChecksRepo } from '../../../../../src/storage/repositories/tier-pr-checks.js';
import {
  DELIVERY_TIER_FIELD_GID,
  TYPE_FIELD_GID,
  tierToOptionGid,
  type DeliveryTier,
} from '../../../../../src/connectors/asana/board-config.js';

const PROMPT = 'Version: 2\n\nrubric';
const PROMPT_VERSION = 2;
const GID = '9999999999';
const ASANA_LINK = `See https://app.asana.com/0/1111111111/${GID} for details.`;

/** A `{ tier, domain, signals }` envelope that decides to a given tier (domain
 *  shopping_checkout, base T2; the behaviour-preserving cap min(base, T1) still
 *  lands the T1 case at T1). llmTier is set to the target so the calibration
 *  cross-check never fires. */
function factsFor(tier: DeliveryTier): Record<string, unknown> {
  const signals = {
    ui_testable: { value: 'yes', evidence: 'clickable' },
    behavior_change: { value: 'no', evidence: '' },
    cosmetic_only: { value: 'no', evidence: '' },
    money: { value: 'no', evidence: '' },
    irreversible_external: { value: 'no', evidence: '' },
    data_integrity: { value: 'no', evidence: '' },
    access_security: { value: 'no', evidence: '' },
    visual_blast_radius: { value: 'no', evidence: '' },
  };
  if (tier === 'T0') signals.cosmetic_only = { value: 'yes', evidence: 'label' };
  if (tier === 'T1') signals.cosmetic_only = { value: 'no', evidence: '' }; // behaviour-preserving → min(T2,T1)=T1
  if (tier === 'T2') {
    signals.behavior_change = { value: 'yes', evidence: 'charges differently' };
    signals.money = { value: 'yes', evidence: 'charge amount' };
  }
  return { tier, domain: 'shopping_checkout', why: 'x', evidence: 'y', signals };
}

function claudeReturning(tier: DeliveryTier) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(factsFor(tier)) }] }),
    },
  };
}

function task(gid: string, tierOptionGid: string | null, notes = 'x'.repeat(60), createdAt?: string): AsanaTask {
  return {
    gid,
    name: `Task ${gid}`,
    notes,
    // This lane has NO created_at gate; the field is set only to document the
    // pre-rollout fixtures — the pass never reads it.
    ...(createdAt ? { created_at: createdAt } : {}),
    custom_fields: [
      { gid: TYPE_FIELD_GID, name: 'Type', enum_value: { gid: 'type-opt', name: 'Feature' } },
      { gid: DELIVERY_TIER_FIELD_GID, name: 'Delivery Tier', enum_value: tierOptionGid ? { gid: tierOptionGid } : null },
    ],
  };
}

/** A github.com/gantri/<repo>/pull/<n> link, the way a PR is recorded ON a ticket. */
const GH_OWNER = 'gantri';
function ghLink(repo = 'porter', number = 5180): string {
  return `https://github.com/${GH_OWNER}/${repo}/pull/${number}`;
}

/** What `GithubDispatcher.getPr` returns for a directly-linked PR (open OR merged).
 *  Body deliberately carries NO app.asana.com backlink — the whole point is that
 *  the open-PR scan would never surface it, but the forward lookup diffs it. */
function ghPr(o: { number?: number; sha?: string; merged?: boolean } = {}) {
  return {
    number: o.number ?? 5180,
    title: 'Linked PR',
    url: ghLink('porter', o.number ?? 5180),
    head: 'feat/linked',
    sha: o.sha ?? 'sha-linked',
    body: 'no asana backlink here',
    state: o.merged ? 'closed' : 'open',
    merged: o.merged ?? false,
  };
}

function story(text: string, createdAt = '2026-07-20T00:00:00Z'): AsanaStory {
  return { gid: `story-${createdAt}`, text, created_at: createdAt, resource_subtype: 'comment_added' };
}

function subtask(name: string, notes: string): AsanaTask {
  return { gid: `sub-${name}`, name, notes };
}

function record(over: Partial<TierClassificationRecord>): TierClassificationRecord {
  return {
    taskGid: GID,
    inputHash: 'h',
    promptVersion: PROMPT_VERSION,
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
    commentGid: 'story-prov',
    reviewRequested: false,
    createdAt: '2026-07-20T00:00:00Z',
    updatedAt: '2026-07-20T00:00:00Z',
    ...over,
  };
}

function pr(o: { number?: number; sha?: string; body?: string } = {}) {
  return {
    number: o.number ?? 42,
    title: 'A PR',
    url: 'https://github.com/gantri/mantle/pull/42',
    head: 'feat/x',
    sha: o.sha ?? 'sha-1',
    body: o.body ?? ASANA_LINK,
  };
}

interface BuildOpts {
  prs?: ReturnType<typeof pr>[];
  diffTier?: DeliveryTier;
  fieldTier?: DeliveryTier | null;
  freshFieldTier?: DeliveryTier | null;
  record?: TierClassificationRecord | null;
  exists?: boolean;
  /** Comments (stories) on the ticket — scanned for a forward PR link. */
  stories?: AsanaStory[];
  /** Subtasks on the ticket — the "Notes for QA" one is scanned for a PR link. */
  subtasks?: AsanaTask[];
  /** What `gh.getPr` resolves to (a directly-linked PR), or null when it 404s.
   *  Undefined → null (no directly-linked PR; the open-PR scan is the fallback). */
  linkedPr?: ReturnType<typeof ghPr> | null;
  /** Fake code-review Slack poster. Absent → the feature is disabled (the pass gets
   *  no `reviewRequest` dep, matching an unset SOFTWARE_CHANNEL_ID). */
  reviewRequest?: { post: ReturnType<typeof vi.fn> };
}

function build(o: BuildOpts = {}) {
  const gh = {
    listOpenPRs: vi.fn().mockResolvedValue(o.prs ?? [pr()]),
    prDiff: vi.fn().mockResolvedValue({ diff: 'diff --git a/x b/x\n+charge', truncated: false }),
    getPr: vi.fn().mockResolvedValue(o.linkedPr === undefined ? null : o.linkedPr),
    owner: GH_OWNER,
  } as unknown as GithubDispatcher;
  const baseline = task(GID, o.fieldTier === null ? null : tierToOptionGid(o.fieldTier ?? 'T1'));
  const getTask =
    o.freshFieldTier === undefined
      ? vi.fn().mockResolvedValue(baseline)
      : vi
          .fn()
          .mockResolvedValue(task(GID, o.freshFieldTier === null ? null : tierToOptionGid(o.freshFieldTier)));
  const client = {
    getTask,
    setEnumCustomField: vi.fn().mockResolvedValue(undefined),
    createStory: vi.fn().mockResolvedValue({ gid: 'story-new' }),
    getTaskStories: vi.fn().mockResolvedValue(o.stories ?? []),
    getTaskSubtasks: vi.fn().mockResolvedValue(o.subtasks ?? []),
  } as unknown as AsanaApiClient;
  const classifications = {
    get: vi.fn().mockResolvedValue(o.record === undefined ? record({}) : o.record),
    upsertBot: vi.fn().mockResolvedValue(undefined),
    markOverride: vi.fn().mockResolvedValue(undefined),
    markReviewRequested: vi.fn().mockResolvedValue(undefined),
  } as unknown as TierClassificationsRepo;
  const prChecks = {
    exists: vi.fn().mockResolvedValue(o.exists ?? false),
    insert: vi.fn().mockResolvedValue(undefined),
  } as unknown as TierPrChecksRepo;
  const claude = claudeReturning(o.diffTier ?? 'T2');
  const pass = new AuthoritativePass({
    gh,
    client,
    classifications,
    prChecks,
    extract: { claude, prompt: PROMPT },
    promptVersion: PROMPT_VERSION,
    repos: ['mantle'],
    ...(o.reviewRequest ? { reviewRequest: o.reviewRequest } : {}),
  });
  return { pass, gh, client, classifications, prChecks, claude, reviewRequest: o.reviewRequest };
}

describe('extractAsanaTaskGid', () => {
  it('pulls the task gid from a standard app.asana.com link', () => {
    expect(extractAsanaTaskGid(`body https://app.asana.com/0/1111111111/${GID} end`)).toBe(GID);
  });
  it('pulls the task gid from the /1/<ws>/project/.../task/<gid> shape', () => {
    expect(
      extractAsanaTaskGid('https://app.asana.com/1/1186582822873190/project/1210754051061529/task/1234567890'),
    ).toBe('1234567890');
  });
  it('returns null when there is no asana link', () => {
    expect(extractAsanaTaskGid('no link here')).toBeNull();
    expect(extractAsanaTaskGid(null)).toBeNull();
  });
});

describe('AuthoritativePass — supersede in either direction', () => {
  it('supersedes DOWN (T2 provisional → T0 diff): writes the field, comments the delta, stage authoritative', async () => {
    const { pass, client, classifications, prChecks } = build({
      fieldTier: 'T2',
      diffTier: 'T0',
      record: record({ tier: 'T2', confirmedTier: 'T2' }),
    });
    const res = await pass.reviewCodeReviewTasks([task(GID, tierToOptionGid('T2'))]);
    expect(res.superseded).toBe(1);
    expect(client.setEnumCustomField).toHaveBeenCalledWith(GID, DELIVERY_TIER_FIELD_GID, tierToOptionGid('T0'));
    expect(client.createStory).toHaveBeenCalledWith(GID, expect.stringContaining('T2 → T0'));
    expect(classifications.upsertBot).toHaveBeenLastCalledWith(
      expect.objectContaining({ tier: 'T0', confirmedTier: 'T0', stage: 'authoritative' }),
    );
    expect(prChecks.insert).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'superseded', commented: true }));
  });

  it('supersedes UP (T1 provisional → T2 diff)', async () => {
    const { pass, client, prChecks } = build({
      fieldTier: 'T1',
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
    });
    const res = await pass.reviewCodeReviewTasks([task(GID, tierToOptionGid('T1'))]);
    expect(res.superseded).toBe(1);
    expect(client.setEnumCustomField).toHaveBeenCalledWith(GID, DELIVERY_TIER_FIELD_GID, tierToOptionGid('T2'));
    expect(client.createStory).toHaveBeenCalledWith(GID, expect.stringContaining('T1 → T2'));
    expect(prChecks.insert).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'superseded' }));
  });

  it('confirms when the diff agrees with the provisional tier (no field write, "holds")', async () => {
    const { pass, client, prChecks } = build({
      fieldTier: 'T2',
      diffTier: 'T2',
      record: record({ tier: 'T2', confirmedTier: 'T2' }),
    });
    const res = await pass.reviewCodeReviewTasks([task(GID, tierToOptionGid('T2'))]);
    expect(res.confirmed).toBe(1);
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
    expect(client.createStory).toHaveBeenCalledWith(GID, expect.stringContaining('T2 holds'));
    expect(prChecks.insert).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'confirmed' }));
  });

  it('records → comments → writes the field → finalizes (crash-safe order; comment precedes field for the papertrail)', async () => {
    const { pass, client, classifications } = build({
      fieldTier: 'T1',
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
    });
    const order: string[] = [];
    (classifications.upsertBot as ReturnType<typeof vi.fn>).mockImplementation((rec: { confirmedTier: string | null }) => {
      order.push(`upsert:${rec.confirmedTier}`);
      return Promise.resolve();
    });
    (client.createStory as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('comment');
      return Promise.resolve({ gid: 'story-new' });
    });
    (client.setEnumCustomField as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('field');
      return Promise.resolve();
    });
    await pass.reviewCodeReviewTasks([task(GID, tierToOptionGid('T1'))]);
    expect(order).toEqual(['upsert:T1', 'comment', 'field', 'upsert:T2']);
  });
});

describe('AuthoritativePass — human ownership & dedupe', () => {
  it('never touches a human_override record', async () => {
    const { pass, client, prChecks } = build({
      record: record({ decidedBy: 'human_override', humanTier: 'T0' }),
    });
    const res = await pass.reviewCodeReviewTasks([task(GID, tierToOptionGid('T0'))]);
    expect(res.humanOwned).toBe(1);
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
    expect(client.createStory).not.toHaveBeenCalled();
    expect(prChecks.insert).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'human_owned' }));
  });

  it('respects a human who set the field during the extraction window', async () => {
    // Baseline shows the bot-owned T1; the fresh re-read shows T0, a value the bot
    // never wrote → a human owns it now. No write, no record change.
    const { pass, client, classifications } = build({
      fieldTier: 'T1',
      freshFieldTier: 'T0',
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
    });
    const res = await pass.reviewCodeReviewTasks([task(GID, tierToOptionGid('T1'))]);
    expect(res.humanOwned).toBe(1);
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
    expect(classifications.upsertBot).not.toHaveBeenCalled();
  });

  it('writes the field when it is empty with no prior record (never a phantom "holds")', async () => {
    // A ticket entered Code Review with a linked PR before the provisional poller
    // ever classified it: no record, empty Delivery Tier field. The authoritative
    // pass classifies the diff as T2 and MUST write the field (not skip it with a
    // false "confirmed … holds" comment).
    const { pass, client, prChecks } = build({
      fieldTier: null,
      diffTier: 'T2',
      record: null,
    });
    const res = await pass.reviewCodeReviewTasks([task(GID, null)]);
    expect(res.superseded).toBe(1);
    expect(client.setEnumCustomField).toHaveBeenCalledWith(GID, DELIVERY_TIER_FIELD_GID, tierToOptionGid('T2'));
    expect(client.createStory).toHaveBeenCalledWith(GID, expect.stringContaining('Set at Code Review'));
    expect(prChecks.insert).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'superseded' }));
  });

  it('treats an empty field whose record is fully confirmed as a human CLEAR (sacred)', async () => {
    // The board scan snapshotted the field as T1; a human cleared it mid-tick to
    // signal disagreement. The fresh re-read shows empty and the record is fully
    // confirmed (confirmedTier === tier), which can only be a human clear — the
    // authoritative pass records the override and never overwrites it.
    const { pass, client, classifications, prChecks } = build({
      fieldTier: 'T1',
      freshFieldTier: null,
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
    });
    const res = await pass.reviewCodeReviewTasks([task(GID, tierToOptionGid('T1'))]);
    expect(res.humanOwned).toBe(1);
    expect(classifications.markOverride).toHaveBeenCalledWith(GID, null);
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
    expect(prChecks.insert).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'human_owned' }));
  });

  it('skips a PR already reviewed at this head sha (dedupe)', async () => {
    const { pass, gh, client } = build({ exists: true });
    const res = await pass.reviewCodeReviewTasks([task(GID, tierToOptionGid('T1'))]);
    expect(res.skipped).toBe(1);
    expect(gh.prDiff).not.toHaveBeenCalled();
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
  });
});

describe('AuthoritativePass — no PR found (description fallback)', () => {
  it('re-classifies from the mature description when no open PR links the task', async () => {
    const { pass, gh, client } = build({
      prs: [pr({ body: 'no asana link here' })],
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
    });
    const res = await pass.reviewCodeReviewTasks([task(GID, tierToOptionGid('T1'))]);
    expect(gh.prDiff).not.toHaveBeenCalled();
    expect(res.superseded).toBe(1);
    expect(client.createStory).toHaveBeenCalledWith(GID, expect.stringContaining('ticket description'));
  });

  it('skips the no-PR path once the record is already authoritative and unchanged', async () => {
    const t = task(GID, tierToOptionGid('T2'));
    // Same input hash the pass will compute for this task → dedupe hit.
    const { tierInputHash } = await import('../../../../../src/connectors/asana/tier/extract.js');
    const hash = tierInputHash(PROMPT_VERSION, { name: t.name, notes: t.notes!, typeName: 'Feature' });
    const { pass, client } = build({
      prs: [pr({ body: 'no link' })],
      diffTier: 'T2',
      record: record({ tier: 'T2', confirmedTier: 'T2', stage: 'authoritative', inputHash: hash }),
    });
    const res = await pass.reviewCodeReviewTasks([t]);
    expect(res.skipped).toBe(1);
    expect(client.createStory).not.toHaveBeenCalled();
  });

  it('skips the description fallback when the ticket has no PR and only a thin description', async () => {
    // The rollout cutoff was removed for this lane, but the thin-notes bar still
    // guards the description-fallback path: no findable PR + a stub description is
    // noise. A ticket WITH a PR is diffed regardless of description length.
    const { pass, gh, client, classifications } = build({
      prs: [pr({ body: 'no asana link here' })], // the scan resolves nothing for this task
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
    });
    const t = task(GID, tierToOptionGid('T1'), 'short'); // < MIN_NOTES_CHARS, no PR named
    const res = await pass.reviewCodeReviewTasks([t]);
    expect(res.skipped).toBe(1);
    expect(gh.prDiff).not.toHaveBeenCalled();
    expect(client.createStory).not.toHaveBeenCalled();
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
    expect(classifications.upsertBot).not.toHaveBeenCalled();
  });
});

describe('AuthoritativePass — Code-Review lane ignores the rollout cutoff (pre-rollout tickets classify)', () => {
  // Before ROLLOUT_DATE. The poller now routes pre-rollout tickets in Code Review to
  // this pass; the pass itself has no created_at gate, so it classifies them like
  // any other ticket — from the diff, or from the mature description.
  const PRE_ROLLOUT = '2026-07-01T00:00:00Z';

  it('classifies a pre-rollout ticket from its PR diff (diff path)', async () => {
    const { pass, gh, client, prChecks } = build({
      fieldTier: 'T1',
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
      linkedPr: ghPr({ number: 5180, sha: 'sha-pre' }),
    });
    const t = task(GID, tierToOptionGid('T1'), `Implements it. PR: ${ghLink('porter', 5180)}`, PRE_ROLLOUT);
    const res = await pass.reviewCodeReviewTasks([t]);
    expect(gh.prDiff).toHaveBeenCalledWith('porter', 5180);
    expect(res.superseded).toBe(1);
    expect(client.setEnumCustomField).toHaveBeenCalledWith(GID, DELIVERY_TIER_FIELD_GID, tierToOptionGid('T2'));
    expect(prChecks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'porter', prNumber: 5180, headSha: 'sha-pre', verdict: 'superseded' }),
    );
  });

  it('classifies a pre-rollout ticket from the mature description when it names no PR (description-fallback path)', async () => {
    const { pass, gh, client } = build({
      prs: [pr({ body: 'no asana link here' })], // the open-PR scan resolves nothing
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
    });
    const t = task(
      GID,
      tierToOptionGid('T1'),
      'A mature description with plenty of substance to classify from.',
      PRE_ROLLOUT,
    );
    const res = await pass.reviewCodeReviewTasks([t]);
    expect(gh.prDiff).not.toHaveBeenCalled();
    expect(res.superseded).toBe(1);
    expect(client.createStory).toHaveBeenCalledWith(GID, expect.stringContaining('ticket description'));
  });
});

describe('extractPrLinks', () => {
  it('extracts every owner-matched PR link in source order', () => {
    const text = `see ${ghLink('porter', 1)} and later ${ghLink('mantle', 2)}`;
    expect(extractPrLinks(text, 'gantri')).toEqual([
      { repo: 'porter', number: 1 },
      { repo: 'mantle', number: 2 },
    ]);
  });

  it('accepts ANY repo under the owner, not just the sweep list', () => {
    expect(extractPrLinks(ghLink('gantri-e2e', 7), 'gantri')).toEqual([{ repo: 'gantri-e2e', number: 7 }]);
  });

  it('filters out links under a different owner (owner match is case-insensitive)', () => {
    expect(extractPrLinks('https://github.com/someone/porter/pull/9', 'gantri')).toEqual([]);
    expect(extractPrLinks('https://github.com/GANTRI/porter/pull/9', 'gantri')).toEqual([
      { repo: 'porter', number: 9 },
    ]);
  });

  it('returns [] for empty / nullish / link-free text', () => {
    expect(extractPrLinks('', 'gantri')).toEqual([]);
    expect(extractPrLinks(null, 'gantri')).toEqual([]);
    expect(extractPrLinks('no links here', 'gantri')).toEqual([]);
  });
});

describe('AuthoritativePass — forward PR resolution from the ticket', () => {
  it('resolves the PR from the ticket description (notes) and skips the open-PR scan', async () => {
    const { pass, gh, client, prChecks } = build({
      fieldTier: 'T1',
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
      linkedPr: ghPr({ number: 5180, sha: 'sha-notes' }),
    });
    const t = task(GID, tierToOptionGid('T1'), `Implements the thing. PR: ${ghLink('porter', 5180)}`);
    const res = await pass.reviewCodeReviewTasks([t]);
    expect(gh.getPr).toHaveBeenCalledWith('porter', 5180);
    expect(gh.prDiff).toHaveBeenCalledWith('porter', 5180);
    expect(gh.listOpenPRs).not.toHaveBeenCalled(); // forward lookup short-circuits the scan
    expect(client.getTaskStories).not.toHaveBeenCalled(); // stop at the first hit (notes)
    expect(res.superseded).toBe(1);
    expect(client.setEnumCustomField).toHaveBeenCalledWith(GID, DELIVERY_TIER_FIELD_GID, tierToOptionGid('T2'));
    expect(prChecks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'porter', prNumber: 5180, headSha: 'sha-notes', verdict: 'superseded' }),
    );
  });

  it('resolves the PR from a comment (story) when the notes name none, newest link winning', async () => {
    const { pass, gh, client } = build({
      fieldTier: 'T1',
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
      stories: [
        story(`first PR ${ghLink('porter', 100)}`, '2026-07-20T00:00:00Z'),
        story(`updated, use ${ghLink('porter', 200)}`, '2026-07-21T00:00:00Z'),
      ],
      linkedPr: ghPr({ number: 200, sha: 'sha-comment' }),
    });
    const t = task(GID, tierToOptionGid('T1'), 'A description with no PR link, just prose about the change.');
    const res = await pass.reviewCodeReviewTasks([t]);
    expect(gh.getPr).toHaveBeenCalledWith('porter', 200); // most-recently-added story link
    expect(gh.listOpenPRs).not.toHaveBeenCalled();
    expect(client.getTaskSubtasks).not.toHaveBeenCalled(); // stop at the story hit
    expect(res.superseded).toBe(1);
  });

  it('resolves the PR from the "Notes for QA" subtask when notes and comments name none', async () => {
    const { pass, gh, client } = build({
      fieldTier: 'T1',
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
      stories: [story('just a plain comment, no link here')],
      subtasks: [
        subtask('Some other subtask', 'nothing here'),
        subtask('Notes for QA', `Test the checkout flow. PR under review: ${ghLink('core', 321)}`),
      ],
      linkedPr: ghPr({ number: 321, sha: 'sha-qa' }),
    });
    const t = task(GID, tierToOptionGid('T1'), 'A description with no PR link.');
    const res = await pass.reviewCodeReviewTasks([t]);
    expect(client.getTaskStories).toHaveBeenCalled();
    expect(client.getTaskSubtasks).toHaveBeenCalledWith(GID, 'name,notes');
    expect(gh.getPr).toHaveBeenCalledWith('core', 321);
    expect(gh.listOpenPRs).not.toHaveBeenCalled();
    expect(res.superseded).toBe(1);
  });

  it('prefers the notes link over a comment and the Notes-for-QA subtask (priority order)', async () => {
    const { pass, gh, client } = build({
      fieldTier: 'T1',
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
      stories: [story(`comment link ${ghLink('porter', 999)}`)],
      subtasks: [subtask('Notes for QA', ghLink('porter', 888))],
      linkedPr: ghPr({ number: 111, sha: 'sha-notes' }),
    });
    const t = task(GID, tierToOptionGid('T1'), `Description PR: ${ghLink('mantle', 111)}`);
    await pass.reviewCodeReviewTasks([t]);
    expect(gh.getPr).toHaveBeenCalledWith('mantle', 111); // notes win
    expect(gh.getPr).toHaveBeenCalledTimes(1);
    expect(client.getTaskStories).not.toHaveBeenCalled();
    expect(client.getTaskSubtasks).not.toHaveBeenCalled();
  });

  it('diffs a directly-linked MERGED PR — one the open-PR scan can never surface', async () => {
    const { pass, gh, prChecks } = build({
      fieldTier: 'T1',
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
      linkedPr: ghPr({ number: 5180, sha: 'sha-merged', merged: true }),
    });
    const t = task(GID, tierToOptionGid('T1'), `Shipped in ${ghLink('porter', 5180)}`);
    const res = await pass.reviewCodeReviewTasks([t]);
    expect(gh.getPr).toHaveBeenCalledWith('porter', 5180);
    expect(gh.prDiff).toHaveBeenCalledWith('porter', 5180);
    expect(gh.listOpenPRs).not.toHaveBeenCalled();
    expect(res.superseded).toBe(1);
    expect(prChecks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'porter', prNumber: 5180, headSha: 'sha-merged' }),
    );
  });

  it('ignores a PR link under a different owner and falls back to the open-PR scan', async () => {
    const { pass, gh } = build({
      fieldTier: 'T1',
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
      prs: [pr()], // ASANA_LINK body → the scan resolves this task's gid
    });
    const t = task(GID, tierToOptionGid('T1'), 'PR: https://github.com/someone-else/porter/pull/5180');
    const res = await pass.reviewCodeReviewTasks([t]);
    expect(gh.getPr).not.toHaveBeenCalled(); // foreign owner → not a forward hit
    expect(gh.listOpenPRs).toHaveBeenCalledWith('mantle'); // fell back to the scan
    expect(res.superseded).toBe(1);
  });

  it('falls back to the open-PR scan when a ticket-linked PR no longer exists (404)', async () => {
    const { pass, gh } = build({
      fieldTier: 'T1',
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
      linkedPr: null, // gh.getPr → 404 → null
      prs: [pr()], // scan resolves via the ASANA_LINK body
    });
    const t = task(GID, tierToOptionGid('T1'), `PR: ${ghLink('porter', 404)}`);
    const res = await pass.reviewCodeReviewTasks([t]);
    expect(gh.getPr).toHaveBeenCalledWith('porter', 404);
    expect(gh.listOpenPRs).toHaveBeenCalledWith('mantle'); // stale link → fell back
    expect(res.superseded).toBe(1);
  });

  it('builds the fallback scan at most once across a batch (only for tasks that miss)', async () => {
    // Two tasks: one resolves forward (notes link), one names no PR. The expensive
    // open-PR scan must run exactly once, and only because of the second task.
    const { pass, gh } = build({
      fieldTier: 'T1',
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
      linkedPr: ghPr({ number: 5180, sha: 'sha-notes' }),
      prs: [pr()],
    });
    const resolved = task(GID, tierToOptionGid('T1'), `PR: ${ghLink('porter', 5180)}`);
    const unresolved = task(GID, tierToOptionGid('T1'), 'No PR named anywhere in this ticket.');
    await pass.reviewCodeReviewTasks([resolved, unresolved]);
    expect(gh.listOpenPRs).toHaveBeenCalledTimes(1); // one repo (mantle), built lazily once
  });
});

describe('AuthoritativePass — code-review Slack request', () => {
  it('posts a request on the first authoritative classification and sets the dedupe flag', async () => {
    const post = vi.fn().mockResolvedValue(true);
    const { pass, classifications } = build({
      fieldTier: 'T1',
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1', reviewRequested: false }),
      linkedPr: ghPr({ number: 5180, sha: 'sha-notes' }),
      reviewRequest: { post },
    });
    const t = task(GID, tierToOptionGid('T1'), `Implements it. PR: ${ghLink('porter', 5180)}`);
    const res = await pass.reviewCodeReviewTasks([t]);
    expect(res.superseded).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        taskName: `Task ${GID}`,
        tier: 'T2',
        nonUiLane: false,
        permalink: expect.stringContaining(GID),
        prs: [{ repo: 'porter', number: 5180, url: ghLink('porter', 5180) }],
      }),
    );
    expect(classifications.markReviewRequested).toHaveBeenCalledWith(GID);
  });

  it('lists a backend and a frontend PR from the ticket in one request (both sides)', async () => {
    const post = vi.fn().mockResolvedValue(true);
    const { pass } = build({
      fieldTier: 'T1',
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
      linkedPr: ghPr({ number: 5180, sha: 'sha-notes' }),
      reviewRequest: { post },
    });
    // The LAST notes link (porter) is the one the pass resolves + diffs; the message
    // lists BOTH the porter (backend) and mantle (frontend) PRs the ticket names.
    const t = task(GID, tierToOptionGid('T1'), `Frontend ${ghLink('mantle', 1230)} and backend ${ghLink('porter', 5180)}`);
    await pass.reviewCodeReviewTasks([t]);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        prs: expect.arrayContaining([
          expect.objectContaining({ repo: 'porter', number: 5180 }),
          expect.objectContaining({ repo: 'mantle', number: 1230 }),
        ]),
      }),
    );
  });

  it('posts a no-PR request from the description-fallback classification', async () => {
    const post = vi.fn().mockResolvedValue(true);
    const { pass, classifications } = build({
      prs: [pr({ body: 'no asana link here' })], // the open-PR scan resolves nothing
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1', reviewRequested: false }),
      reviewRequest: { post },
    });
    const t = task(GID, tierToOptionGid('T1'), 'A mature description with plenty of substance to classify from.');
    const res = await pass.reviewCodeReviewTasks([t]);
    expect(res.superseded).toBe(1);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ prs: [] }));
    expect(classifications.markReviewRequested).toHaveBeenCalledWith(GID);
  });

  it('does not post again once the task has already been requested (per-task dedupe)', async () => {
    const post = vi.fn().mockResolvedValue(true);
    const { pass, classifications } = build({
      fieldTier: 'T1',
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1', reviewRequested: true }),
      linkedPr: ghPr({ number: 5180, sha: 'sha-2' }),
      reviewRequest: { post },
    });
    const t = task(GID, tierToOptionGid('T1'), `PR: ${ghLink('porter', 5180)}`);
    const res = await pass.reviewCodeReviewTasks([t]);
    expect(res.superseded).toBe(1); // the classification still runs
    expect(post).not.toHaveBeenCalled();
    expect(classifications.markReviewRequested).not.toHaveBeenCalled();
  });

  it('leaves the dedupe flag unset when the Slack post fails (retries next check)', async () => {
    const post = vi.fn().mockResolvedValue(false); // failure-soft: post reports failure
    const { pass, classifications } = build({
      fieldTier: 'T1',
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1', reviewRequested: false }),
      linkedPr: ghPr({ number: 5180, sha: 'sha-notes' }),
      reviewRequest: { post },
    });
    const t = task(GID, tierToOptionGid('T1'), `PR: ${ghLink('porter', 5180)}`);
    const res = await pass.reviewCodeReviewTasks([t]);
    expect(res.superseded).toBe(1); // the post failure never fails the pass
    expect(post).toHaveBeenCalledTimes(1);
    expect(classifications.markReviewRequested).not.toHaveBeenCalled();
  });

  it('never requests a review when the feature is disabled (no channel configured)', async () => {
    const { pass, classifications } = build({
      fieldTier: 'T1',
      diffTier: 'T2',
      record: record({ tier: 'T1', confirmedTier: 'T1' }),
      linkedPr: ghPr({ number: 5180, sha: 'sha-notes' }),
      // no reviewRequest dep → feature disabled
    });
    const t = task(GID, tierToOptionGid('T1'), `PR: ${ghLink('porter', 5180)}`);
    const res = await pass.reviewCodeReviewTasks([t]);
    expect(res.superseded).toBe(1);
    expect(classifications.markReviewRequested).not.toHaveBeenCalled();
  });

  it('does not request a review on a skipped (already-reviewed head sha) task', async () => {
    const post = vi.fn().mockResolvedValue(true);
    const { pass } = build({ exists: true, reviewRequest: { post } });
    const res = await pass.reviewCodeReviewTasks([task(GID, tierToOptionGid('T1'))]);
    expect(res.skipped).toBe(1);
    expect(post).not.toHaveBeenCalled();
  });
});
