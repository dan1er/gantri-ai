import { describe, it, expect } from 'vitest';
import { decideTier, DOMAIN_BASE_TIER, type Domain, type Facts, type Ternary } from '../../../../../src/connectors/asana/tier/decide.js';
import type { DeliveryTier } from '../../../../../src/connectors/asana/board-config.js';

/**
 * The Notion "Delivery Tier Classifier" rubric page (Version 2, domain-base model),
 * encoded as fixtures so the code is provably aligned with the public doc. The
 * functional domain sets a BASE tier; the change (Step 3/4) raises or lowers it;
 * uncertainty floors to T1; a definite T2 stays T2. Finally the LLM's own tier is
 * cross-checked against the code tier.
 */

/** Build a fact set from partial overrides; signals default to `no`, domain to a
 *  known T1 domain, and `llmTier` to null (no calibration cross-check). */
function facts(
  overrides: Partial<Record<keyof Omit<Facts, 'domain' | 'llmTier'>, Ternary>> & {
    domain?: Domain;
    llmTier?: DeliveryTier | null;
  } = {},
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
    domain: overrides.domain ?? 'content_marketing',
    llmTier: overrides.llmTier ?? null,
  };
}

describe('DOMAIN_BASE_TIER — transcribed from the Notion page', () => {
  it('has exactly 36 domains', () => {
    expect(Object.keys(DOMAIN_BASE_TIER)).toHaveLength(36);
  });
  it('T2 base only for the three inherently-dangerous domains', () => {
    const t2 = Object.entries(DOMAIN_BASE_TIER)
      .filter(([, t]) => t === 'T2')
      .map(([d]) => d)
      .sort();
    // Exactly three T2 base domains, matching the Notion page (Version 2) table:
    // the inherently dangerous ones (auth, inventory, production). The money-adjacent
    // customer surfaces (checkout, orders, order management, payouts / statements /
    // quotes) sit at T1 base and reach T2 only via Step 3's money trigger.
    expect(t2).toEqual(
      [
        'auth_accounts',
        'inventory_materials',
        'production_workflow',
      ].sort(),
    );
  });
  it('read-only reporting and pure infra sit at T0', () => {
    expect(DOMAIN_BASE_TIER.reporting_analytics).toBe('T0');
    expect(DOMAIN_BASE_TIER.platform_infra).toBe('T0');
  });
  it('unknown and all porter_* domains sit at T1', () => {
    expect(DOMAIN_BASE_TIER.unknown).toBe('T1');
    expect(DOMAIN_BASE_TIER.porter_orders_payments).toBe('T1');
    expect(DOMAIN_BASE_TIER.porter_accounts_orgs).toBe('T1');
  });

  it('pins the money-adjacent domains by name (page-table parity)', () => {
    // Every money-adjacent domain sits at T1 base (page Version 2) and only reaches
    // T2 via Step 3's money trigger — the customer money/order surfaces alongside the
    // MadeOS ones. These are the invariants the final model depends on.
    expect(DOMAIN_BASE_TIER.shopping_checkout).toBe('T1');
    expect(DOMAIN_BASE_TIER.orders_notifications).toBe('T1');
    expect(DOMAIN_BASE_TIER.order_management).toBe('T1');
    expect(DOMAIN_BASE_TIER.payouts_statements).toBe('T1');
    expect(DOMAIN_BASE_TIER.made_quoting_billing).toBe('T1');
    expect(DOMAIN_BASE_TIER.made_order_management).toBe('T1');
  });
});

describe('decideTier — money-adjacent domain invariants', () => {
  it('payouts/statements behaviour change with no hard trigger keeps the T1 base', () => {
    // A behaviour-changing payouts ticket with no money/irreversible/integrity/access
    // trigger is T1 — matching a human applying page Version 2 (money-adjacent = T1
    // base). It only reaches T2 when a hard trigger fires.
    const d = decideTier(facts({ behavior_change: 'yes', domain: 'payouts_statements' }));
    expect(d.tier).toBe('T1');
    expect(d.baseTier).toBe('T1');
    expect(d.firedRule).toBe('behavior_at_base');
  });

  it('payouts/statements behaviour change that touches money escalates to T2', () => {
    const d = decideTier(facts({ behavior_change: 'yes', money: 'yes', domain: 'payouts_statements' }));
    expect(d.tier).toBe('T2');
    expect(d.firedRule).toBe('t2_risk_trigger');
  });

  it('made_quoting_billing keeps T1 for a recoverable change, escalates to T2 on money', () => {
    const recoverable = decideTier(
      facts({ behavior_change: 'yes', visual_blast_radius: 'yes', domain: 'made_quoting_billing' }),
    );
    expect(recoverable.tier).toBe('T1');
    expect(recoverable.baseTier).toBe('T1');

    const money = decideTier(facts({ behavior_change: 'yes', money: 'yes', domain: 'made_quoting_billing' }));
    expect(money.tier).toBe('T2');
    expect(money.firedRule).toBe('t2_risk_trigger');
  });

  it('made_order_management escalates to T2 on an irreversible customer action', () => {
    const d = decideTier(
      facts({ behavior_change: 'yes', irreversible_external: 'yes', domain: 'made_order_management' }),
    );
    expect(d.tier).toBe('T2');
    expect(d.baseTier).toBe('T1');
    expect(d.firedRule).toBe('t2_risk_trigger');
  });
});

describe('decideTier — Step 1 (no UI surface → terminal T0)', () => {
  it('backend payments ticket → T0 + Non-UI Lane', () => {
    const d = decideTier(facts({ ui_testable: 'no', money: 'yes', domain: 'shopping_checkout' }));
    expect(d.tier).toBe('T0');
    expect(d.firedRule).toBe('not_ui_testable');
    expect(d.flags).toContain('non_ui_lane');
  });

  it('database migration in a sensitive backend domain → T0 + Non-UI Lane', () => {
    const d = decideTier(facts({ ui_testable: 'no', data_integrity: 'yes', domain: 'porter_orders_payments' }));
    expect(d.tier).toBe('T0');
    expect(d.flags).toContain('non_ui_lane');
  });

  it('backend logging change in a non-sensitive area → T0, no Non-UI Lane note', () => {
    const d = decideTier(facts({ ui_testable: 'no', domain: 'platform_infra' }));
    expect(d.tier).toBe('T0');
    expect(d.flags).toEqual([]);
  });

  it('step-1 terminal T0 is unaffected by an LLM tier disagreement', () => {
    const d = decideTier(facts({ ui_testable: 'no', domain: 'platform_infra', llmTier: 'T2' }));
    expect(d.tier).toBe('T0');
    expect(d.calibrationMismatch).toBe(false);
  });
});

describe('decideTier — Step 3 (risk downgrade)', () => {
  it('checkout copy change → T0 (cosmetic, whatever the base)', () => {
    const d = decideTier(
      facts({ behavior_change: 'no', cosmetic_only: 'yes', domain: 'shopping_checkout' }),
    );
    expect(d.tier).toBe('T0');
    expect(d.firedRule).toBe('cosmetic');
    expect(d.baseTier).toBe('T1');
  });

  it('checkout restyle, logic intact → T1 (behaviour-preserving cap min(base, T1))', () => {
    const d = decideTier(
      facts({ behavior_change: 'no', cosmetic_only: 'no', visual_blast_radius: 'yes', domain: 'shopping_checkout' }),
    );
    expect(d.tier).toBe('T1');
    expect(d.firedRule).toBe('behavior_preserving');
    expect(d.baseTier).toBe('T1');
  });

  it('reporting dashboard cosmetic tweak → T0', () => {
    const d = decideTier(facts({ behavior_change: 'no', cosmetic_only: 'yes', domain: 'reporting_analytics' }));
    expect(d.tier).toBe('T0');
  });
});

describe('decideTier — Step 4 (hard triggers) & Step 2 (keep base)', () => {
  it('refund-calculation change → T2 (money trigger)', () => {
    const d = decideTier(
      facts({ behavior_change: 'yes', money: 'yes', domain: 'order_management' }),
    );
    expect(d.tier).toBe('T2');
    expect(d.firedRule).toBe('t2_risk_trigger');
    expect(d.evidenceFact).toBe('money');
  });

  it('discount-applying banner (content_marketing) → T2 (money trigger beats T1 base)', () => {
    const d = decideTier(facts({ behavior_change: 'yes', money: 'yes', domain: 'content_marketing' }));
    expect(d.tier).toBe('T2');
    expect(d.baseTier).toBe('T1');
    expect(d.firedRule).toBe('t2_risk_trigger');
  });

  it('inventory behaviour change without a hard trigger → T2 (keeps the T2 base)', () => {
    const d = decideTier(facts({ behavior_change: 'yes', domain: 'inventory_materials' }));
    expect(d.tier).toBe('T2');
    expect(d.firedRule).toBe('behavior_at_base');
    expect(d.baseTier).toBe('T2');
  });

  it('recoverable behaviour change in a T1 domain → keeps T1', () => {
    const d = decideTier(facts({ behavior_change: 'yes', visual_blast_radius: 'yes', domain: 'product_discovery' }));
    expect(d.tier).toBe('T1');
    expect(d.firedRule).toBe('behavior_at_base');
  });

  it('irreversible customer action → T2', () => {
    const d = decideTier(
      facts({ behavior_change: 'yes', irreversible_external: 'yes', domain: 'orders_notifications' }),
    );
    expect(d.tier).toBe('T2');
    expect(d.evidenceFact).toBe('irreversible_external');
  });

  it('access/security change → T2', () => {
    const d = decideTier(facts({ behavior_change: 'yes', access_security: 'yes', domain: 'auth_accounts' }));
    expect(d.tier).toBe('T2');
    expect(d.evidenceFact).toBe('access_security');
  });
});

describe('decideTier — Step 5 (uncertainty floor)', () => {
  it('unknown-domain cosmetic → T1 (floor lifts the cosmetic T0)', () => {
    const d = decideTier(facts({ behavior_change: 'no', cosmetic_only: 'yes', domain: 'unknown' }));
    expect(d.tier).toBe('T1');
    expect(d.liftedByUnclear).toBe(true);
    expect(d.firedRule).toBe('inconclusive');
  });

  it('a known-domain cosmetic is NOT floored (stays T0)', () => {
    const d = decideTier(facts({ behavior_change: 'no', cosmetic_only: 'yes', domain: 'content_marketing' }));
    expect(d.tier).toBe('T0');
    expect(d.liftedByUnclear).toBe(false);
  });

  it('ui_testable=unclear on an otherwise cosmetic change → T1', () => {
    const d = decideTier(
      facts({ ui_testable: 'unclear', behavior_change: 'no', cosmetic_only: 'yes', domain: 'content_marketing' }),
    );
    expect(d.tier).toBe('T1');
    expect(d.liftedByUnclear).toBe(true);
    expect(d.evidenceFact).toBe('ui_testable');
  });

  it('behavior_change=unclear in a T1 domain → T1', () => {
    const d = decideTier(facts({ behavior_change: 'unclear', domain: 'content_marketing' }));
    expect(d.tier).toBe('T1');
  });

  it('a definite T2 stays T2 even when other signals are unclear', () => {
    const d = decideTier(
      facts({ ui_testable: 'unclear', behavior_change: 'yes', money: 'yes', data_integrity: 'unclear', domain: 'shopping_checkout' }),
    );
    expect(d.tier).toBe('T2');
    expect(d.liftedByUnclear).toBe(false);
    expect(d.firedRule).toBe('t2_risk_trigger');
  });
});

describe('decideTier — calibration cross-check (LLM tier ≠ code tier)', () => {
  it('cosmetic (code T0) but the model says T2 → floored to T1 + calibration flag', () => {
    const d = decideTier(
      facts({ behavior_change: 'no', cosmetic_only: 'yes', domain: 'content_marketing', llmTier: 'T2' }),
    );
    expect(d.tier).toBe('T1');
    expect(d.calibrationMismatch).toBe(true);
  });

  it('agreement leaves the tier and flag untouched', () => {
    const d = decideTier(
      facts({ behavior_change: 'yes', money: 'yes', domain: 'shopping_checkout', llmTier: 'T2' }),
    );
    expect(d.tier).toBe('T2');
    expect(d.calibrationMismatch).toBe(false);
  });

  it('a lower LLM tier than a T2 code tier still floors up (never below T1) + flag', () => {
    const d = decideTier(
      facts({ behavior_change: 'yes', money: 'yes', domain: 'shopping_checkout', llmTier: 'T0' }),
    );
    expect(d.tier).toBe('T2');
    expect(d.calibrationMismatch).toBe(true);
  });
});
