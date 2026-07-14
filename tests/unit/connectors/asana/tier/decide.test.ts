import { describe, it, expect } from 'vitest';
import { decideTier, type Facts, type Ternary } from '../../../../../src/connectors/asana/tier/decide.js';

/**
 * The Notion "Delivery Tier Classifier" rubric page, encoded as fixtures so the
 * code is provably aligned with the public doc. The model is change-based: risk —
 * not the domain — decides the tier. Each case names the ticket, the signals it
 * maps to, and the tier + flags it must produce.
 */

/** Build a fact set from partial overrides; everything defaults to `no`. */
function facts(
  overrides: Partial<Record<keyof Omit<Facts, 'domain'>, Ternary>> & { domain?: Facts['domain'] } = {},
): Facts {
  const v = (t: Ternary = 'no') => ({ value: t, evidence: '' });
  return {
    ui_testable: v(overrides.ui_testable ?? 'yes'),
    behavior_change: v(overrides.behavior_change),
    cosmetic_only: v(overrides.cosmetic_only),
    money: v(overrides.money),
    irreversible_external: v(overrides.irreversible_external),
    data_integrity: v(overrides.data_integrity),
    access_security: v(overrides.access_security),
    visual_blast_radius: v(overrides.visual_blast_radius),
    domain: overrides.domain ?? 'unknown',
  };
}

describe('decideTier — rubric page (change-based, verbatim)', () => {
  it('checkout copy change → T0 (Step 2 cosmetic)', () => {
    const d = decideTier(
      facts({ ui_testable: 'yes', behavior_change: 'no', cosmetic_only: 'yes', domain: 'shopping_checkout' }),
    );
    expect(d.tier).toBe('T0');
    expect(d.firedRule).toBe('cosmetic');
    expect(d.flags).toEqual([]);
    expect(d.liftedByUnclear).toBe(false);
  });

  it('styling tweak → T0 (Step 2 cosmetic)', () => {
    const d = decideTier(facts({ ui_testable: 'yes', behavior_change: 'no', cosmetic_only: 'yes' }));
    expect(d.tier).toBe('T0');
    expect(d.firedRule).toBe('cosmetic');
  });

  it('reporting dashboard tweak (read-only, cosmetic) → T0', () => {
    const d = decideTier(
      facts({ ui_testable: 'yes', behavior_change: 'no', cosmetic_only: 'yes', domain: 'reporting_analytics' }),
    );
    expect(d.tier).toBe('T0');
  });

  it('shared-component restyle, no behavior change → T1 (Step 2 non-cosmetic)', () => {
    const d = decideTier(
      facts({ ui_testable: 'yes', behavior_change: 'no', cosmetic_only: 'no', visual_blast_radius: 'yes' }),
    );
    expect(d.tier).toBe('T1');
    expect(d.firedRule).toBe('no_behavior_change');
    expect(d.liftedByUnclear).toBe(false);
  });

  it('new screen with recoverable new behavior → T1 (Step 4)', () => {
    const d = decideTier(facts({ ui_testable: 'yes', behavior_change: 'yes', visual_blast_radius: 'yes' }));
    expect(d.tier).toBe('T1');
    expect(d.firedRule).toBe('behavior_recoverable');
  });

  it('backend orders/payments change → T0 + Non-UI Lane note (Step 1)', () => {
    const d = decideTier(facts({ ui_testable: 'no', money: 'yes', domain: 'shopping_checkout' }));
    expect(d.tier).toBe('T0');
    expect(d.firedRule).toBe('not_ui_testable');
    expect(d.flags).toContain('non_ui_lane');
  });

  it('database migration → T0 + Non-UI Lane note (Step 1)', () => {
    const d = decideTier(facts({ ui_testable: 'no', data_integrity: 'yes', domain: 'porter_orders_payments' }));
    expect(d.tier).toBe('T0');
    expect(d.flags).toContain('non_ui_lane');
  });

  it('behavior-preserving refactor of payments code → T0 + Non-UI Lane via sensitive domain', () => {
    // No risk signal fires yes, but the backend area (checkout) is money-sensitive.
    const d = decideTier(facts({ ui_testable: 'no', behavior_change: 'no', domain: 'shopping_checkout' }));
    expect(d.tier).toBe('T0');
    expect(d.flags).toContain('non_ui_lane');
  });

  it('backend logging change in a non-sensitive area → T0, no Non-UI Lane note', () => {
    const d = decideTier(facts({ ui_testable: 'no', domain: 'platform_infra' }));
    expect(d.tier).toBe('T0');
    expect(d.flags).toEqual([]);
  });

  it('change that alters how much a charge fires → T2 (Step 3 money)', () => {
    const d = decideTier(facts({ ui_testable: 'yes', behavior_change: 'yes', money: 'yes', domain: 'shopping_checkout' }));
    expect(d.tier).toBe('T2');
    expect(d.firedRule).toBe('t2_risk_trigger');
    expect(d.evidenceFact).toBe('money');
  });

  it('inventory UI change that can corrupt stock → T2 (Step 3 data integrity)', () => {
    const d = decideTier(
      facts({ ui_testable: 'yes', behavior_change: 'yes', data_integrity: 'yes', domain: 'inventory_materials' }),
    );
    expect(d.tier).toBe('T2');
    expect(d.evidenceFact).toBe('data_integrity');
  });

  it('sends a customer email on order commit → T2 (Step 3 irreversible)', () => {
    const d = decideTier(
      facts({ ui_testable: 'yes', behavior_change: 'yes', irreversible_external: 'yes', domain: 'orders_notifications' }),
    );
    expect(d.tier).toBe('T2');
    expect(d.evidenceFact).toBe('irreversible_external');
  });

  it('permissions change that could expose data → T2 (Step 3 access/security)', () => {
    const d = decideTier(
      facts({ ui_testable: 'yes', behavior_change: 'yes', access_security: 'yes', domain: 'auth_accounts' }),
    );
    expect(d.tier).toBe('T2');
    expect(d.evidenceFact).toBe('access_security');
  });
});

describe('decideTier — uncertainty floor (never leave unsure at T0)', () => {
  it('ui_testable=unclear on an otherwise cosmetic change → T1', () => {
    const d = decideTier(facts({ ui_testable: 'unclear', behavior_change: 'no', cosmetic_only: 'yes' }));
    expect(d.tier).toBe('T1');
    expect(d.liftedByUnclear).toBe(true);
    expect(d.firedRule).toBe('inconclusive');
    expect(d.evidenceFact).toBe('ui_testable');
  });

  it('behavior_change=unclear → T1 (Step 4 unsure)', () => {
    const d = decideTier(facts({ ui_testable: 'yes', behavior_change: 'unclear' }));
    expect(d.tier).toBe('T1');
    expect(d.liftedByUnclear).toBe(true);
    expect(d.evidenceFact).toBe('behavior_change');
  });

  it('behavior change with a money signal that is unclear → T1, not T2', () => {
    const d = decideTier(facts({ ui_testable: 'yes', behavior_change: 'yes', money: 'unclear' }));
    expect(d.tier).toBe('T1');
    expect(d.liftedByUnclear).toBe(true);
    expect(d.evidenceFact).toBe('money');
  });

  it('a definite T2 stays T2 even when other signals are unclear', () => {
    const d = decideTier(
      facts({ ui_testable: 'unclear', behavior_change: 'yes', money: 'yes', data_integrity: 'unclear' }),
    );
    expect(d.tier).toBe('T2');
    expect(d.liftedByUnclear).toBe(false);
    expect(d.firedRule).toBe('t2_risk_trigger');
  });

  it('domain is an output tag only — unknown domain never sets the tier', () => {
    const cosmetic = decideTier(facts({ ui_testable: 'yes', behavior_change: 'no', cosmetic_only: 'yes', domain: 'unknown' }));
    expect(cosmetic.tier).toBe('T0');
    const t2 = decideTier(facts({ ui_testable: 'yes', behavior_change: 'yes', money: 'yes', domain: 'unknown' }));
    expect(t2.tier).toBe('T2');
  });
});
