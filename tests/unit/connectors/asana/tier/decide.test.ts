import { describe, it, expect } from 'vitest';
import { decideTier, type Facts, type Ternary } from '../../../../../src/connectors/asana/tier/decide.js';

/**
 * The "Common cases" table from the public Pre-Production Test Tiering guide,
 * encoded verbatim as fixtures so the code is provably aligned with the doc. Each
 * case names the ticket, the facts it maps to, and the tier + flags it must
 * produce.
 */

/** Build a fact set from partial overrides; everything defaults to `no`. */
function facts(overrides: Partial<Record<keyof Omit<Facts, 'domain'>, Ternary>> & { domain?: Facts['domain'] } = {}): Facts {
  const v = (t: Ternary = 'no') => ({ value: t, evidence: '' });
  return {
    ui_testable: v(overrides.ui_testable ?? 'yes'),
    irreversible_external: v(overrides.irreversible_external),
    money_visible: v(overrides.money_visible),
    visual_blast_radius: v(overrides.visual_blast_radius),
    brand_critical: v(overrides.brand_critical),
    backend_data: v(overrides.backend_data),
    coordinated_launch: v(overrides.coordinated_launch),
    domain: overrides.domain ?? 'unknown',
  };
}

describe('decideTier — Common cases (public rubric table, verbatim)', () => {
  it('checkout copy change → T0', () => {
    // Copy on checkout is NOT money_visible and NOT blast radius.
    const d = decideTier(facts({ ui_testable: 'yes', domain: 'shopping_checkout' }));
    expect(d.tier).toBe('T0');
    expect(d.liftedByUnclear).toBe(false);
    expect(d.flags).toEqual([]);
  });

  it('styling tweak → T0', () => {
    const d = decideTier(facts({ ui_testable: 'yes' }));
    expect(d.tier).toBe('T0');
    expect(d.firedRule).toBe('low_risk');
  });

  it('new self-contained element on one screen → T0', () => {
    // Explicitly NOT visual_blast_radius.
    const d = decideTier(facts({ ui_testable: 'yes', visual_blast_radius: 'no' }));
    expect(d.tier).toBe('T0');
  });

  it('shared component edit → T1', () => {
    const d = decideTier(facts({ ui_testable: 'yes', visual_blast_radius: 'yes' }));
    expect(d.tier).toBe('T1');
    expect(d.firedRule).toBe('visual_blast');
    expect(d.liftedByUnclear).toBe(false);
  });

  it('new screen → T1', () => {
    const d = decideTier(facts({ ui_testable: 'yes', visual_blast_radius: 'yes' }));
    expect(d.tier).toBe('T1');
    expect(d.flags).toEqual([]);
  });

  it('new screen on the brand list → T1 + brand flag', () => {
    const d = decideTier(facts({ ui_testable: 'yes', visual_blast_radius: 'yes', brand_critical: 'yes' }));
    expect(d.tier).toBe('T1');
    expect(d.flags).toContain('brand_critical');
  });

  it('backend orders/payments change → T0 + Non-UI Lane note', () => {
    const d = decideTier(facts({ ui_testable: 'no', backend_data: 'yes', domain: 'shopping_checkout' }));
    expect(d.tier).toBe('T0');
    expect(d.firedRule).toBe('not_ui_testable');
    expect(d.flags).toContain('non_ui_lane');
  });

  it('migration → T0 + Non-UI Lane', () => {
    const d = decideTier(facts({ ui_testable: 'no', backend_data: 'yes' }));
    expect(d.tier).toBe('T0');
    expect(d.flags).toContain('non_ui_lane');
  });

  it('change that alters whether/how much a charge fires → T2', () => {
    // Testable through the checkout UI, and it moves a real customer charge.
    const d = decideTier(facts({ ui_testable: 'yes', irreversible_external: 'yes', domain: 'shopping_checkout' }));
    expect(d.tier).toBe('T2');
    expect(d.firedRule).toBe('money_or_irreversible');
  });

  it('refactor/log/read in payments code → T0 + Non-UI Lane', () => {
    const d = decideTier(facts({ ui_testable: 'no', backend_data: 'yes', irreversible_external: 'no', money_visible: 'no' }));
    expect(d.tier).toBe('T0');
    expect(d.flags).toContain('non_ui_lane');
  });
});

describe('decideTier — automation rules (not-UI-testable, inconclusive lift)', () => {
  it('ui_testable=no with money=yes → T0 + binding Non-UI note', () => {
    const d = decideTier(facts({ ui_testable: 'no', money_visible: 'yes' }));
    expect(d.tier).toBe('T0');
    expect(d.firedRule).toBe('not_ui_testable');
    expect(d.flags).toContain('non_ui_lane');
  });

  it('ui_testable=unclear → T1 (inconclusive lift)', () => {
    const d = decideTier(facts({ ui_testable: 'unclear' }));
    expect(d.tier).toBe('T1');
    expect(d.liftedByUnclear).toBe(true);
    expect(d.firedRule).toBe('inconclusive_lift');
    expect(d.evidenceFact).toBe('ui_testable');
  });

  it('money=unclear (rest no) → T1 (inconclusive lift)', () => {
    const d = decideTier(facts({ ui_testable: 'yes', money_visible: 'unclear' }));
    expect(d.tier).toBe('T1');
    expect(d.liftedByUnclear).toBe(true);
    expect(d.evidenceFact).toBe('money_visible');
  });

  it('irreversible=yes + others unclear → T2 (definite T2 stays T2)', () => {
    const d = decideTier(
      facts({ ui_testable: 'unclear', irreversible_external: 'yes', money_visible: 'unclear', visual_blast_radius: 'unclear' }),
    );
    expect(d.tier).toBe('T2');
    expect(d.liftedByUnclear).toBe(false);
    expect(d.firedRule).toBe('money_or_irreversible');
  });

  it('coordinated_launch flag appends without changing the tier', () => {
    const d = decideTier(facts({ ui_testable: 'yes', coordinated_launch: 'yes' }));
    expect(d.tier).toBe('T0');
    expect(d.flags).toContain('coordinated_launch');
  });
});
