import { describe, it, expect, vi } from 'vitest';
import { PrRecheck, PrRecheckRunner, extractAsanaTaskGid } from '../../../../../src/connectors/asana/tier/pr-recheck.js';
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

const PROMPT = 'Version: 1\n\nrubric';
const PROMPT_VERSION = 1;
const ASANA_LINK = 'See https://app.asana.com/0/1111111111/9999999999 for details.';

/** Facts that decide to a given tier. T0 = all no + ui yes; T1 = visual blast;
 *  T2 = money visible. */
function factsFor(tier: DeliveryTier): Record<string, unknown> {
  const base = {
    ui_testable: { value: 'yes', evidence: 'clickable' },
    irreversible_external: { value: 'no', evidence: '' },
    money_visible: { value: 'no', evidence: '' },
    visual_blast_radius: { value: 'no', evidence: '' },
    brand_critical: { value: 'no', evidence: '' },
    backend_data: { value: 'no', evidence: '' },
    coordinated_launch: { value: 'no', evidence: '' },
    domain: 'shopping_checkout',
  };
  if (tier === 'T1') return { ...base, visual_blast_radius: { value: 'yes', evidence: 'shared component' } };
  if (tier === 'T2') return { ...base, money_visible: { value: 'yes', evidence: 'charge amount' } };
  return base;
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
    taskGid: '9999999999',
    inputHash: 'h',
    promptVersion: PROMPT_VERSION,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    facts: {} as any,
    tier: 'T0',
    confirmedTier: 'T0',
    liftedByUnclear: false,
    flags: [],
    domain: 'shopping_checkout',
    decidedBy: 'bot',
    humanTier: null,
    commentGid: null,
    createdAt: '2026-07-20T00:00:00Z',
    updatedAt: '2026-07-20T00:00:00Z',
    ...over,
  };
}

interface PrOpts {
  number?: number;
  sha?: string;
  body?: string;
}

function pr(o: PrOpts = {}) {
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
  record?: TierClassificationRecord | null;
  exists?: boolean;
}

function build(o: BuildOpts = {}) {
  const gh = {
    listOpenPRs: vi.fn().mockResolvedValue(o.prs ?? [pr()]),
    prDiff: vi.fn().mockResolvedValue({ diff: 'diff --git a/x b/x\n+charge', truncated: false }),
  } as unknown as GithubDispatcher;
  const client = {
    getTask: vi.fn().mockResolvedValue(task('9999999999', o.fieldTier === null ? null : tierToOptionGid(o.fieldTier ?? 'T0'))),
    setEnumCustomField: vi.fn().mockResolvedValue(undefined),
    createStory: vi.fn().mockResolvedValue({ gid: 'story-new' }),
  } as unknown as AsanaApiClient;
  const classifications = {
    get: vi.fn().mockResolvedValue(o.record === undefined ? record({}) : o.record),
    upsertBot: vi.fn().mockResolvedValue(undefined),
  } as unknown as TierClassificationsRepo;
  const prChecks = {
    exists: vi.fn().mockResolvedValue(o.exists ?? false),
    insert: vi.fn().mockResolvedValue(undefined),
  } as unknown as TierPrChecksRepo;
  const claude = claudeReturning(o.diffTier ?? 'T2');
  const recheck = new PrRecheck({
    gh,
    client,
    classifications,
    prChecks,
    extract: { claude, prompt: PROMPT },
    promptVersion: PROMPT_VERSION,
    repos: ['mantle'],
  });
  return { recheck, gh, client, classifications, prChecks, claude };
}

describe('extractAsanaTaskGid', () => {
  it('pulls the task gid from a standard app.asana.com link', () => {
    expect(extractAsanaTaskGid('body https://app.asana.com/0/1111111111/9999999999 end')).toBe('9999999999');
  });
  it('pulls the task gid from the new /1/<ws>/project/.../task/<gid> shape', () => {
    expect(
      extractAsanaTaskGid('https://app.asana.com/1/1186582822873190/project/1210754051061529/task/1234567890'),
    ).toBe('1234567890');
  });
  it('returns null when there is no asana link', () => {
    expect(extractAsanaTaskGid('no link here')).toBeNull();
    expect(extractAsanaTaskGid('')).toBeNull();
    expect(extractAsanaTaskGid(null)).toBeNull();
  });
});

describe('PrRecheck.runOnce — dedupe', () => {
  it('skips a PR already checked at this head sha (no diff fetch, no LLM)', async () => {
    const { recheck, gh, client } = build({ exists: true });
    const res = await recheck.runOnce();
    expect(res.skipped).toBe(1);
    expect(gh.prDiff).not.toHaveBeenCalled();
    expect(client.getTask).not.toHaveBeenCalled();
  });
});

describe('PrRecheck.runOnce — missing ticket verdicts', () => {
  it('records no_ticket when the PR body has no asana link', async () => {
    const { recheck, gh, prChecks } = build({ prs: [pr({ body: 'no link' })] });
    const res = await recheck.runOnce();
    expect(res.noTicket).toBe(1);
    expect(gh.prDiff).not.toHaveBeenCalled();
    expect(prChecks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'mantle', verdict: 'no_ticket', taskGid: null, commented: false }),
    );
  });

  it('records not_classified when the linked ticket has no classification', async () => {
    const { recheck, gh, prChecks } = build({ record: null });
    const res = await recheck.runOnce();
    expect(res.notClassified).toBe(1);
    expect(gh.prDiff).not.toHaveBeenCalled();
    expect(prChecks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'not_classified', taskGid: '9999999999' }),
    );
  });
});

describe('PrRecheck.runOnce — raise-only semantics', () => {
  it('bot-set field: raises the field, comments, and syncs the record', async () => {
    const { recheck, client, classifications, prChecks } = build({
      fieldTier: 'T0',
      diffTier: 'T2',
      record: record({ tier: 'T0', confirmedTier: 'T0', decidedBy: 'bot' }),
    });
    const res = await recheck.runOnce();
    expect(res.raised).toBe(1);
    expect(client.setEnumCustomField).toHaveBeenCalledWith('9999999999', DELIVERY_TIER_FIELD_GID, tierToOptionGid('T2'));
    expect(client.createStory).toHaveBeenCalledTimes(1);
    expect(client.createStory).toHaveBeenCalledWith('9999999999', expect.stringContaining('T0 → T2'));
    // Record synced to the raised tier so the poller does not misread it as an override.
    expect(classifications.upsertBot).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'T2', confirmedTier: 'T2', commentGid: 'story-new' }),
    );
    expect(prChecks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'raise', suggestedTier: 'T2', commented: true }),
    );
  });

  it('human-set field: comments only, never touches the field or the record', async () => {
    // The field reads T1 but the bot recorded T0 → a human owns it. A T2 diff must
    // only comment.
    const { recheck, client, classifications, prChecks } = build({
      fieldTier: 'T1',
      diffTier: 'T2',
      record: record({ tier: 'T0', confirmedTier: 'T0', decidedBy: 'human_override', humanTier: 'T1' }),
    });
    const res = await recheck.runOnce();
    expect(res.raised).toBe(1);
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
    expect(classifications.upsertBot).not.toHaveBeenCalled();
    expect(client.createStory).toHaveBeenCalledWith('9999999999', expect.stringContaining('T1 → T2'));
    expect(prChecks.insert).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'raise', commented: true }));
  });

  it('never lowers: a diff tier below the current field tier is a silent consistent verdict', async () => {
    const { recheck, client, prChecks } = build({
      fieldTier: 'T2',
      diffTier: 'T0',
      record: record({ tier: 'T2', confirmedTier: 'T2', decidedBy: 'bot' }),
    });
    const res = await recheck.runOnce();
    expect(res.consistent).toBe(1);
    expect(res.raised).toBe(0);
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
    expect(client.createStory).not.toHaveBeenCalled();
    expect(prChecks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'consistent', suggestedTier: 'T0', commented: false }),
    );
  });

  it('equal diff and field tier is consistent and silent', async () => {
    const { recheck, client, prChecks } = build({
      fieldTier: 'T1',
      diffTier: 'T1',
      record: record({ tier: 'T1', confirmedTier: 'T1', decidedBy: 'bot' }),
    });
    const res = await recheck.runOnce();
    expect(res.consistent).toBe(1);
    expect(client.setEnumCustomField).not.toHaveBeenCalled();
    expect(prChecks.insert).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'consistent', commented: false }));
  });
});

describe('PrRecheck.runOnce — resilience', () => {
  it('a failing repo listing does not abort the batch; a per-PR error is tallied', async () => {
    const { recheck, gh, prChecks } = build({ prs: [pr({ number: 1 }), pr({ number: 2, sha: 'sha-2' })] });
    // Second PR's diff fetch throws.
    (gh.prDiff as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ diff: 'd', truncated: false })
      .mockRejectedValueOnce(new Error('boom'));
    const res = await recheck.runOnce();
    expect(res.scanned).toBe(2);
    expect(res.raised).toBe(1);
    expect(res.failed).toBe(1);
    // The failed PR is NOT recorded (so it retries next tick).
    expect(prChecks.insert).toHaveBeenCalledTimes(1);
  });
});

describe('PrRecheckRunner', () => {
  it('tick does not overlap itself', async () => {
    let active = 0;
    let maxActive = 0;
    const recheck = {
      runOnce: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return { scanned: 0, raised: 0, consistent: 0, noTicket: 0, notClassified: 0, skipped: 0, failed: 0 };
      }),
    } as unknown as PrRecheck;
    const runner = new PrRecheckRunner(recheck, 10_000);
    await Promise.all([runner.tick(), runner.tick()]);
    expect(maxActive).toBe(1);
  });

  it('a thrown runOnce is swallowed and returns an empty result', async () => {
    const recheck = { runOnce: vi.fn().mockRejectedValue(new Error('down')) } as unknown as PrRecheck;
    const runner = new PrRecheckRunner(recheck);
    const res = await runner.tick();
    expect(res.scanned).toBe(0);
    expect(res.failed).toBe(0);
  });
});
