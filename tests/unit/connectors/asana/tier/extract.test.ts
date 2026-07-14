import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  extractFacts,
  extractFactsFromDiff,
  loadTierStandard,
  parseTierPromptVersion,
  tierInputHash,
  TierExtractError,
  type ExtractInput,
} from '../../../../../src/connectors/asana/tier/extract.js';

const PROMPT = 'Version: 1\n\nrubric body';

/** The rubric page's `{ tier, domain, why, evidence, signals }` envelope. The bot
 *  recomputes the tier from `signals`, so the code reads the signals object + the
 *  domain tag. */
const FULL_FACTS = {
  tier: 'T2',
  domain: 'shopping_checkout',
  why: 'Step 3: changes how much the customer is charged',
  evidence: 'refunds issued automatically',
  signals: {
    ui_testable: { value: 'yes', evidence: 'user can place an order' },
    behavior_change: { value: 'yes', evidence: 'refunds issued automatically' },
    cosmetic_only: { value: 'no', evidence: '' },
    money: { value: 'yes', evidence: 'refunds issued automatically' },
    irreversible_external: { value: 'no', evidence: '' },
    data_integrity: { value: 'no', evidence: '' },
    access_security: { value: 'no', evidence: '' },
    visual_blast_radius: { value: 'no', evidence: '' },
  },
};

function claudeReturning(...texts: string[]) {
  const create = vi.fn();
  for (const t of texts) create.mockResolvedValueOnce({ content: [{ type: 'text', text: t }] });
  return { messages: { create } };
}

const INPUT: ExtractInput = { name: 'Auto-refund cancelled orders', notes: 'x'.repeat(60), typeName: 'Feature' };

describe('extractFacts', () => {
  it('parses a clean JSON object into Facts and passes evidence through', async () => {
    const claude = claudeReturning(JSON.stringify(FULL_FACTS));
    const facts = await extractFacts(INPUT, { claude, prompt: PROMPT });
    expect(facts.ui_testable).toEqual({ value: 'yes', evidence: 'user can place an order' });
    expect(facts.money.evidence).toBe('refunds issued automatically');
    expect(facts.domain).toBe('shopping_checkout');
    // The model's own tier is captured for the calibration cross-check.
    expect(facts.llmTier).toBe('T2');
  });

  it('captures a null llmTier when the model omits an unrecognized tier', async () => {
    const claude = claudeReturning(JSON.stringify({ ...FULL_FACTS, tier: 'T9' }));
    const facts = await extractFacts(INPUT, { claude, prompt: PROMPT });
    expect(facts.llmTier).toBeNull();
  });

  it('extracts the JSON object even when the model wraps it in prose / a fence', async () => {
    const claude = claudeReturning('Here you go:\n```json\n' + JSON.stringify(FULL_FACTS) + '\n```\nDone.');
    const facts = await extractFacts(INPUT, { claude, prompt: PROMPT });
    expect(facts.domain).toBe('shopping_checkout');
  });

  it('degrades an out-of-enum domain to unknown rather than failing', async () => {
    const claude = claudeReturning(JSON.stringify({ ...FULL_FACTS, domain: 'not_a_domain' }));
    const facts = await extractFacts(INPUT, { claude, prompt: PROMPT });
    expect(facts.domain).toBe('unknown');
  });

  it('retries once on an unparseable first response, then succeeds', async () => {
    const claude = claudeReturning('sorry, I cannot do that', JSON.stringify(FULL_FACTS));
    const facts = await extractFacts(INPUT, { claude, prompt: PROMPT });
    expect(facts.ui_testable.value).toBe('yes');
    expect(claude.messages.create).toHaveBeenCalledTimes(2);
  });

  it('throws TierExtractError after two malformed responses', async () => {
    const claude = claudeReturning('nope', 'still nope');
    await expect(extractFacts(INPUT, { claude, prompt: PROMPT })).rejects.toBeInstanceOf(TierExtractError);
    expect(claude.messages.create).toHaveBeenCalledTimes(2);
  });

  it('rejects a zod-invalid value (bad ternary) and retries', async () => {
    const bad = JSON.stringify({
      ...FULL_FACTS,
      signals: { ...FULL_FACTS.signals, ui_testable: { value: 'maybe', evidence: '' } },
    });
    const claude = claudeReturning(bad, JSON.stringify(FULL_FACTS));
    const facts = await extractFacts(INPUT, { claude, prompt: PROMPT });
    expect(facts.ui_testable.value).toBe('yes');
    expect(claude.messages.create).toHaveBeenCalledTimes(2);
  });

  it('sends the rubric prompt as a cache-primed system block', async () => {
    const claude = claudeReturning(JSON.stringify(FULL_FACTS));
    await extractFacts(INPUT, { claude, prompt: PROMPT });
    const params = claude.messages.create.mock.calls[0][0];
    expect(params.temperature).toBe(0);
    expect(params.system[0].text).toBe(PROMPT);
    expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('extractFacts — Version 4 money boundary fixtures', () => {
  // These fixtures pin the signal envelope the model is expected to return under the
  // Version 4 forward-looking money boundary, and confirm the extractor parses it.

  it('recording already-paid costs (purchase-cost capture) → money=no, factory_administration', async () => {
    // "Purchase view: record inbound shipping and tariff (duty) costs on each purchase"
    // (golden row 13): the amounts were already incurred, so recording them is
    // bookkeeping — money=no — and it is an admin data-entry form (factory_administration).
    const envelope = {
      tier: 'T1',
      domain: 'factory_administration',
      why: 'Step 2: admin data-entry form, base tier T1; Step 3 money does not fire (bookkeeping)',
      evidence: 'record inbound shipping and tariff (duty) costs on each purchase',
      signals: {
        ui_testable: { value: 'yes', evidence: 'enter the costs on the purchase view' },
        behavior_change: { value: 'yes', evidence: 'record inbound shipping and tariff costs' },
        cosmetic_only: { value: 'no', evidence: '' },
        restores_approved_behavior: { value: 'no', evidence: '' },
        money: { value: 'no', evidence: 'recording amounts already incurred — bookkeeping' },
        irreversible_external: { value: 'no', evidence: '' },
        data_integrity: { value: 'no', evidence: '' },
        access_security: { value: 'no', evidence: '' },
        visual_blast_radius: { value: 'no', evidence: '' },
      },
    };
    const claude = claudeReturning(JSON.stringify(envelope));
    const facts = await extractFacts(INPUT, { claude, prompt: PROMPT });
    expect(facts.domain).toBe('factory_administration');
    expect(facts.money.value).toBe('no');
    expect(facts.behavior_change.value).toBe('yes');
    expect(facts.llmTier).toBe('T1');
  });

  it('a pricing / quote CALCULATION change → money=yes, made_quoting_billing', async () => {
    // The mirror: a change to how a quote amount is calculated alters what someone will
    // be charged from now on — money=yes — so the trigger fires.
    const envelope = {
      tier: 'T2',
      domain: 'made_quoting_billing',
      why: 'Step 3: changes how the quote amount is calculated',
      evidence: 'recompute the quote total from the new margin formula',
      signals: {
        ui_testable: { value: 'yes', evidence: 'generate a quote' },
        behavior_change: { value: 'yes', evidence: 'recompute the quote total' },
        cosmetic_only: { value: 'no', evidence: '' },
        restores_approved_behavior: { value: 'no', evidence: '' },
        money: { value: 'yes', evidence: 'recompute the quote total from the new margin formula' },
        irreversible_external: { value: 'no', evidence: '' },
        data_integrity: { value: 'no', evidence: '' },
        access_security: { value: 'no', evidence: '' },
        visual_blast_radius: { value: 'no', evidence: '' },
      },
    };
    const claude = claudeReturning(JSON.stringify(envelope));
    const facts = await extractFacts(INPUT, { claude, prompt: PROMPT });
    expect(facts.domain).toBe('made_quoting_billing');
    expect(facts.money.value).toBe('yes');
    expect(facts.llmTier).toBe('T2');
  });
});

describe('extractFactsFromDiff', () => {
  it('reuses the rubric prompt as the cached system block and puts the diff in the user turn', async () => {
    const claude = claudeReturning(JSON.stringify(FULL_FACTS));
    const facts = await extractFactsFromDiff(
      { ...INPUT, diff: 'diff --git a/pay.ts b/pay.ts\n+chargeCustomer()', truncated: false },
      { claude, prompt: PROMPT },
    );
    expect(facts.domain).toBe('shopping_checkout');
    const params = claude.messages.create.mock.calls[0][0];
    // Same public rubric file drives the extraction (cache-primed system block).
    expect(params.system[0].text).toBe(PROMPT);
    expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' });
    const userText = params.messages[0].content as string;
    expect(userText).toContain('AUTHORITATIVE');
    expect(userText).toContain('chargeCustomer()');
    expect(userText).not.toContain('NOTE: the diff was truncated');
  });

  it('adds a conservative note when the diff was truncated', async () => {
    const claude = claudeReturning(JSON.stringify(FULL_FACTS));
    await extractFactsFromDiff({ ...INPUT, diff: 'partial diff', truncated: true }, { claude, prompt: PROMPT });
    const userText = claude.messages.create.mock.calls[0][0].messages[0].content as string;
    expect(userText).toContain('NOTE: the diff was truncated');
  });
});

describe('machine appendix — ui_testable drivability boundary', () => {
  // Danny's live correction: "Bug: Cannot cancel full order" (fix = backend cron +
  // transaction service) was wrongly judged ui_testable=no and downgraded T1→T0 by
  // the diff pass, on the blanket "backend-only → no". A tester CAN drive it: cancel
  // the order in admin and verify the fix. The appendix must define ui_testable by
  // DRIVABILITY (does a UI flow exercise the changed behavior), not by file location —
  // as the three-question determination DRIVE + VERIFY + COVER (all must hold).
  const appendix = (() => {
    const prompt = loadTierStandard();
    return prompt.slice(prompt.indexOf('--- MACHINE APPENDIX'));
  })();

  it('defines ui_testable by drivability, not by which files changed', () => {
    expect(appendix).toMatch(/drivability,? not file location/i);
    expect(appendix).toMatch(/exercises the changed behavior/i);
    // The blanket "backend-only ⇒ no" rule must be gone: an all-backend fix can be yes.
    expect(appendix).toMatch(/100% backend/i);
    expect(appendix).not.toMatch(/a backend-only change offers nothing to click/i);
  });

  it('frames the question as "would a manual UI pass catch this change\'s failure?"', () => {
    expect(appendix).toMatch(/would a manual UI pass be the thing that catches this change'?s failure/i);
    // Not "does it have any UI consequence" — almost everything does.
    expect(appendix).toMatch(/never "does this change have any UI consequence\?"/i);
  });

  it('carries the three-question determination: DRIVE + VERIFY + COVER (all must hold)', () => {
    expect(appendix).toMatch(/\*\*DRIVE\*\*/);
    expect(appendix).toMatch(/\*\*VERIFY\*\*/);
    expect(appendix).toMatch(/\*\*COVER\*\*/);
    expect(appendix).toMatch(/all THREE hold/i);
    // COVER: a shared-helper refactor across many flows is drivable but not covered.
    expect(appendix).toMatch(/refactor of a shared helper/i);
    // Genuinely unclear → 'unclear' (the T1 floor handles it), not a confident no.
    expect(appendix).toMatch(/answer `unclear`/i);
  });

  it('keeps the observe-not-drive line and the always-no cases', () => {
    // Actively driving the corrected behavior = yes; passively observing output = no.
    expect(appendix).toMatch(/observ/i);
    // Migrations / backfills stay always-no; webhook / sync / race internals stay no.
    expect(appendix).toMatch(/data migrations and one-off backfills are \*\*always\*\* `no`/i);
    expect(appendix).toMatch(/webhook \/ sync \/ race internals/i);
  });

  it('the diff-mode carve-out judges ui_testable by behavior, never by file location', () => {
    expect(appendix).toMatch(/Judge `ui_testable` by whether a product-UI flow \*\*exercises the changed behavior\*\*, never by which files/i);
  });
});

describe('parseTierPromptVersion', () => {
  it('parses the Version header', () => {
    expect(parseTierPromptVersion('Version: 3\n\nbody')).toBe(3);
  });
  it('throws when the header is missing', () => {
    expect(() => parseTierPromptVersion('no header here')).toThrow();
  });
});

describe('tierInputHash', () => {
  it('is stable for identical inputs and version', () => {
    const a = tierInputHash(1, INPUT);
    const b = tierInputHash(1, INPUT);
    expect(a).toBe(b);
  });
  it('changes when the prompt version changes (rubric bump invalidates the cache)', () => {
    expect(tierInputHash(1, INPUT)).not.toBe(tierInputHash(2, INPUT));
  });
  it('changes when the ticket text changes', () => {
    expect(tierInputHash(1, INPUT)).not.toBe(tierInputHash(1, { ...INPUT, notes: 'different' }));
  });

  it('is backward-compatible: the empty-rubric-hash default matches the original two-arg layout', () => {
    // A record persisted BEFORE the runtime rubric shipped was hashed with the
    // original `version\nname\notes\ntype` payload. The empty-rubric-hash path must
    // reproduce it byte-for-byte, or the first tick after deploy re-classifies the
    // whole board (duplicate comments + field re-writes) for no real change.
    const legacy = createHash('sha256')
      .update(`1\n${INPUT.name}\n${INPUT.notes}\n${INPUT.typeName}`)
      .digest('hex');
    expect(tierInputHash(1, INPUT)).toBe(legacy);
    expect(tierInputHash(1, INPUT, '')).toBe(legacy);
  });

  it('changes when the live rubric hash changes (same ticket re-classifies under a new rubric)', () => {
    // The stated requirement: including the rubric hash means an identical ticket
    // re-classifies after a Notion page edit. A different rubric hash → a different
    // input hash, and a non-empty rubric hash differs from the empty-hash default.
    const a = tierInputHash(1, INPUT, 'rubric-hash-a');
    const b = tierInputHash(1, INPUT, 'rubric-hash-b');
    expect(a).not.toBe(b);
    expect(a).not.toBe(tierInputHash(1, INPUT));
    expect(a).not.toBe(tierInputHash(1, INPUT, ''));
  });
});
