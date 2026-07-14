import { describe, it, expect } from 'vitest';
import { renderTierComment, renderTierRaiseComment, RUBRIC_URL } from '../../../../../src/connectors/asana/tier/comment.js';
import { decideTier, type Facts, type Ternary } from '../../../../../src/connectors/asana/tier/decide.js';

function facts(
  o: Partial<Record<keyof Omit<Facts, 'domain'>, { v: Ternary; e?: string }>> & { domain?: Facts['domain'] } = {},
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
    domain: o.domain ?? 'unknown',
  };
}

describe('renderTierComment', () => {
  it('renders a T2 money change with evidence, the domain, and the rubric footer', () => {
    const f = facts({
      ui_testable: { v: 'yes' },
      behavior_change: { v: 'yes' },
      money: { v: 'yes', e: 'refunds will now be issued automatically for cancelled orders' },
      domain: 'shopping_checkout',
    });
    const text = renderTierComment(decideTier(f), f, 1);
    expect(text).toContain('🤖 Delivery Tier: T2 — QA before production');
    expect(text).toContain('Why: it changes money');
    expect(text).toContain('Evidence: "refunds will now be issued automatically for cancelled orders"');
    expect(text).toContain('Domain: Shopping & Checkout');
    expect(text).toContain(`Rubric v1 · ${RUBRIC_URL}`);
    expect(text).toContain('lowering is never a solo call');
  });

  it('renders a backend T0 with the Non-UI Lane flag', () => {
    const f = facts({ ui_testable: { v: 'no' }, money: { v: 'yes' }, domain: 'shopping_checkout' });
    const text = renderTierComment(decideTier(f), f, 1);
    expect(text).toContain('🤖 Delivery Tier: T0 — engineering validation');
    expect(text).toContain('Non-UI Lane');
  });

  it('renders the inconclusive T1 message without an evidence line', () => {
    const f = facts({ ui_testable: { v: 'yes' }, behavior_change: { v: 'unclear' } });
    const text = renderTierComment(decideTier(f), f, 1);
    expect(text).toContain('🤖 Delivery Tier: T1 — production, then QA');
    expect(text).toContain('defaulting to T1 (rubric Step 4: unsure → T1)');
    expect(text).not.toContain('Evidence:');
  });

  it('renders a cosmetic T0 with no flags line', () => {
    const f = facts({ ui_testable: { v: 'yes' }, behavior_change: { v: 'no' }, cosmetic_only: { v: 'yes' }, domain: 'content_marketing' });
    const text = renderTierComment(decideTier(f), f, 1);
    expect(text).toContain('🤖 Delivery Tier: T0 — engineering validation');
    expect(text).not.toContain('Flags:');
    expect(text).toContain('Domain: Content & Marketing');
  });
});

describe('renderTierRaiseComment', () => {
  it('leads with the tier delta and the PR number, then the diff-derived why + evidence', () => {
    const f = facts({
      ui_testable: { v: 'yes' },
      behavior_change: { v: 'yes' },
      money: { v: 'yes', e: 'total charged now includes tax' },
      domain: 'shopping_checkout',
    });
    const text = renderTierRaiseComment({
      prNumber: 5180,
      fromTier: 'T0',
      toTier: 'T2',
      decision: decideTier(f),
      facts: f,
      promptVersion: 1,
    });
    expect(text).toContain('🤖 Tier raised T0 → T2 after PR #5180 diff review.');
    expect(text).toContain('Why: it changes money');
    expect(text).toContain('Evidence: "total charged now includes tax"');
    expect(text).toContain('Domain: Shopping & Checkout');
    expect(text).toContain(`Rubric v1 · ${RUBRIC_URL}`);
  });
});
