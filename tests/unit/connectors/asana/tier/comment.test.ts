import { describe, it, expect } from 'vitest';
import {
  renderTierComment,
  renderAuthoritativeComment,
  PROVISIONAL_LINE,
  RUBRIC_URL,
} from '../../../../../src/connectors/asana/tier/comment.js';
import { decideTier, type Facts, type Ternary } from '../../../../../src/connectors/asana/tier/decide.js';
import type { DeliveryTier } from '../../../../../src/connectors/asana/board-config.js';

function facts(
  o: Partial<Record<keyof Omit<Facts, 'domain' | 'llmTier'>, { v: Ternary; e?: string }>> & {
    domain?: Facts['domain'];
    llmTier?: DeliveryTier | null;
  } = {},
): Facts {
  const f = (x?: { v: Ternary; e?: string }) => ({ value: x?.v ?? 'no', evidence: x?.e ?? '' });
  return {
    ui_testable: f(o.ui_testable ?? { v: 'yes' }),
    behavior_change: f(o.behavior_change),
    cosmetic_only: f(o.cosmetic_only),
    money: f(o.money),
    irreversible_external: f(o.irreversible_external),
    data_integrity: f(o.data_integrity),
    access_security: f(o.access_security),
    visual_blast_radius: f(o.visual_blast_radius),
    domain: o.domain ?? 'content_marketing',
    llmTier: o.llmTier ?? null,
  };
}

describe('renderTierComment', () => {
  it('renders a T2 money change with evidence, the domain, and the rubric footer', () => {
    const f = facts({
      behavior_change: { v: 'yes' },
      money: { v: 'yes', e: 'refunds will now be issued automatically for cancelled orders' },
      domain: 'shopping_checkout',
    });
    const text = renderTierComment(decideTier(f), f, 2);
    expect(text).toContain('🤖 Delivery Tier: T2 — QA before production');
    expect(text).toContain('Why: it changes money');
    expect(text).toContain('Evidence: "refunds will now be issued automatically for cancelled orders"');
    expect(text).toContain('Domain: Shopping & Checkout');
    expect(text).toContain(`Rubric v2 · ${RUBRIC_URL}`);
    expect(text).toContain('lowering is never a solo call');
  });

  it('renders a backend T0 with the Non-UI Lane flag', () => {
    const f = facts({ ui_testable: { v: 'no' }, money: { v: 'yes' }, domain: 'shopping_checkout' });
    const text = renderTierComment(decideTier(f), f, 2);
    expect(text).toContain('🤖 Delivery Tier: T0 — engineering validation');
    expect(text).toContain('Non-UI Lane');
  });

  it('renders the inconclusive T1 message without an evidence line', () => {
    const f = facts({ behavior_change: { v: 'unclear' }, domain: 'unknown' });
    const text = renderTierComment(decideTier(f), f, 2);
    expect(text).toContain('🤖 Delivery Tier: T1 — production, then QA');
    expect(text).toContain('defaulting to T1 (rubric Step 4: unsure → T1)');
    expect(text).not.toContain('Evidence:');
  });

  it('appends the provisional line when asked', () => {
    const f = facts({ behavior_change: { v: 'yes' }, domain: 'product_discovery' });
    const text = renderTierComment(decideTier(f), f, 2, { provisional: true });
    expect(text).toContain(PROVISIONAL_LINE);
  });

  it('notes a calibration mismatch and floors to T1', () => {
    const f = facts({ behavior_change: { v: 'no' }, cosmetic_only: { v: 'yes' }, domain: 'content_marketing', llmTier: 'T2' });
    const d = decideTier(f);
    const text = renderTierComment(d, f, 2);
    expect(d.tier).toBe('T1');
    expect(text).toContain('the model and the rubric disagreed on the tier');
  });
});

describe('renderAuthoritativeComment', () => {
  it('leads with the confirmed delta from the PR diff when the tier moves', () => {
    const f = facts({
      behavior_change: { v: 'yes' },
      money: { v: 'yes', e: 'total charged now includes tax' },
      domain: 'shopping_checkout',
    });
    const text = renderAuthoritativeComment({
      fromTier: 'T0',
      toTier: 'T2',
      source: 'diff',
      prNumber: 5180,
      decision: decideTier(f),
      facts: f,
      promptVersion: 2,
    });
    expect(text).toContain('🤖 Confirmed at Code Review from the PR diff (#5180): T0 → T2.');
    expect(text).toContain('Why: it changes money');
    expect(text).toContain('Evidence: "total charged now includes tax"');
    expect(text).toContain('Domain: Shopping & Checkout');
  });

  it('states the tier held when the provisional guess was right', () => {
    const f = facts({ behavior_change: { v: 'yes' }, domain: 'product_discovery' });
    const text = renderAuthoritativeComment({
      fromTier: 'T1',
      toTier: 'T1',
      source: 'diff',
      prNumber: 42,
      decision: decideTier(f),
      facts: f,
      promptVersion: 2,
    });
    expect(text).toContain('T1 holds');
  });

  it('names the description when no PR diff was available', () => {
    const f = facts({ behavior_change: { v: 'no' }, cosmetic_only: { v: 'yes' }, domain: 'content_marketing' });
    const text = renderAuthoritativeComment({
      fromTier: 'T1',
      toTier: 'T0',
      source: 'description',
      decision: decideTier(f),
      facts: f,
      promptVersion: 2,
    });
    expect(text).toContain('Confirmed at Code Review from the ticket description: T1 → T0.');
  });
});
