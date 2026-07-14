import { describe, it, expect, vi } from 'vitest';
import {
  extractFacts,
  extractFactsFromDiff,
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
});
