import { describe, it, expect, vi } from 'vitest';
import {
  AuthoritativePass,
  extractAsanaTaskGid,
} from '../../../../../src/connectors/asana/tier/authoritative-pass.js';
import type { AsanaApiClient, AsanaTask } from '../../../../../src/connectors/asana/client.js';
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
 *  shopping_checkout, base T1). llmTier is set to the target so the calibration
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
  if (tier === 'T1') signals.cosmetic_only = { value: 'no', evidence: '' }; // behaviour-preserving → min(T1,T1)
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

function task(gid: string, tierOptionGid: string | null): AsanaTask {
  return {
    gid,
    name: `Task ${gid}`,
    notes: 'x'.repeat(60),
    custom_fields: [
      { gid: TYPE_FIELD_GID, name: 'Type', enum_value: { gid: 'type-opt', name: 'Feature' } },
      { gid: DELIVERY_TIER_FIELD_GID, name: 'Delivery Tier', enum_value: tierOptionGid ? { gid: tierOptionGid } : null },
    ],
  };
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
}

function build(o: BuildOpts = {}) {
  const gh = {
    listOpenPRs: vi.fn().mockResolvedValue(o.prs ?? [pr()]),
    prDiff: vi.fn().mockResolvedValue({ diff: 'diff --git a/x b/x\n+charge', truncated: false }),
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
  } as unknown as AsanaApiClient;
  const classifications = {
    get: vi.fn().mockResolvedValue(o.record === undefined ? record({}) : o.record),
    upsertBot: vi.fn().mockResolvedValue(undefined),
    markOverride: vi.fn().mockResolvedValue(undefined),
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
  });
  return { pass, gh, client, classifications, prChecks, claude };
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

  it('persists the record BEFORE the field write (crash-safe ordering)', async () => {
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
    (client.setEnumCustomField as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('field');
      return Promise.resolve();
    });
    await pass.reviewCodeReviewTasks([task(GID, tierToOptionGid('T1'))]);
    expect(order).toEqual(['upsert:T1', 'field', 'upsert:T2']);
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
});
