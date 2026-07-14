import { describe, it, expect } from 'vitest';
import { renderTierComment, renderTierRaiseComment, RUBRIC_URL } from '../../../../../src/connectors/asana/tier/comment.js';
import { decideTier, type Facts, type Ternary } from '../../../../../src/connectors/asana/tier/decide.js';

function facts(o: Partial<Record<keyof Omit<Facts, 'domain'>, { v: Ternary; e?: string }>> & { domain?: Facts['domain'] } = {}): Facts {
  const f = (x?: { v: Ternary; e?: string }) => ({ value: x?.v ?? 'no', evidence: x?.e ?? '' });
  return {
    ui_testable: f(o.ui_testable ?? { v: 'yes' }),
    irreversible_external: f(o.irreversible_external),
    money_visible: f(o.money_visible),
    visual_blast_radius: f(o.visual_blast_radius),
    brand_critical: f(o.brand_critical),
    backend_data: f(o.backend_data),
    coordinated_launch: f(o.coordinated_launch),
    domain: o.domain ?? 'unknown',
  };
}

describe('renderTierComment', () => {
  it('renders a T2 money change with evidence, the Non-UI Lane flag, the domain, and the rubric footer', () => {
    const f = facts({
      ui_testable: { v: 'yes' },
      money_visible: { v: 'yes', e: 'refunds will now be issued automatically for cancelled orders' },
      backend_data: { v: 'yes' },
      domain: 'shopping_checkout',
    });
    const text = renderTierComment(decideTier(f), f, 1);
    expect(text).toContain('🤖 Delivery Tier: T2 — QA before production');
    expect(text).toContain('Why: it changes the money the customer sees or pays (rubric Q3).');
    expect(text).toContain('Evidence: "refunds will now be issued automatically for cancelled orders"');
    expect(text).toContain('Non-UI Lane');
    expect(text).toContain('Domain: Shopping & Checkout');
    expect(text).toContain(`Rubric v1 · ${RUBRIC_URL}`);
    expect(text).toContain('lowering is never a solo call');
  });

  it('renders the inconclusive T1 message without an evidence line', () => {
    const f = facts({ ui_testable: { v: 'unclear' } });
    const text = renderTierComment(decideTier(f), f, 1);
    expect(text).toContain('🤖 Delivery Tier: T1 — targeted QA');
    expect(text).toContain('defaulting to T1 (inconclusive rule)');
    expect(text).not.toContain('Evidence:');
  });

  it('renders a low-risk T0 with no flags line', () => {
    const f = facts({ ui_testable: { v: 'yes' }, domain: 'content_marketing' });
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
      money_visible: { v: 'yes', e: 'total charged now includes tax' },
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
    expect(text).toContain('Why: it changes the money the customer sees or pays (rubric Q3).');
    expect(text).toContain('Evidence: "total charged now includes tax"');
    expect(text).toContain('Domain: Shopping & Checkout');
    expect(text).toContain(`Rubric v1 · ${RUBRIC_URL}`);
  });
});
