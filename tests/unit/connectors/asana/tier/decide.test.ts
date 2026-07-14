import { describe, it, expect } from 'vitest';
import { decideTier, DOMAIN_BASE_TIER, type Domain, type Facts, type Ternary } from '../../../../../src/connectors/asana/tier/decide.js';
import type { DeliveryTier } from '../../../../../src/connectors/asana/board-config.js';

/**
 * The Notion "Delivery Tier Classifier" rubric page (Version 4, domain-base model),
 * encoded as fixtures so the code is provably aligned with the public doc. The
 * functional domain sets a BASE tier; the change (Step 3/4) raises or lowers it; a
 * restore of already-approved behaviour caps at min(base, T1); uncertainty floors
 * to T1; a definite T2 stays T2. Finally the LLM's own tier is cross-checked against
 * the code tier.
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
    restores_approved_behavior: v(overrides.restores_approved_behavior),
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
  it('T2 base for the inherently-dangerous domains plus the customer money/order surfaces', () => {
    const t2 = Object.entries(DOMAIN_BASE_TIER)
      .filter(([, t]) => t === 'T2')
      .map(([d]) => d)
      .sort();
    // Exactly six T2 base domains, matching the Notion page (Version 2, hand-
    // calibrated) table: the inherently dangerous ones (auth, inventory, production)
    // plus the customer money / order surfaces (checkout, order management, orders /
    // notifications), where a base defect ships real customer harm. Payouts /
    // statements / quotes stay at T1 and reach T2 only via Step 3's money trigger.
    expect(t2).toEqual(
      [
        'auth_accounts',
        'inventory_materials',
        'production_workflow',
        'shopping_checkout',
        'order_management',
        'orders_notifications',
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
    // Page Version 2 (hand-calibrated): the customer money/order surfaces sit at T2
    // base — a base defect there ships real customer harm. Payouts / statements /
    // quotes (marketplace and MadeOS) stay at T1 and reach T2 only via Step 3's
    // money trigger. These are the invariants the final model depends on.
    expect(DOMAIN_BASE_TIER.shopping_checkout).toBe('T2');
    expect(DOMAIN_BASE_TIER.orders_notifications).toBe('T2');
    expect(DOMAIN_BASE_TIER.order_management).toBe('T2');
    expect(DOMAIN_BASE_TIER.payouts_statements).toBe('T1');
    expect(DOMAIN_BASE_TIER.made_quoting_billing).toBe('T1');
    expect(DOMAIN_BASE_TIER.made_order_management).toBe('T1');
  });
});

describe('decideTier — runtime tableMap parameter (live Notion base tiers)', () => {
  // The whole point of the runtime rubric: editing a domain's base-tier row on the
  // Notion page must change the tier the classifier assigns. `decideTier` takes the
  // parsed table as an argument; these tests prove it consumes that argument and does
  // NOT read the committed DOMAIN_BASE_TIER directly. A behaviour-changing ticket with
  // no hard trigger and no restore lands exactly at the domain base tier, so the base
  // is the sole thing under test here.
  const behaviorAtBase = facts({ behavior_change: 'yes', domain: 'content_marketing' });

  it('defaults to the committed base tier when no map is passed', () => {
    expect(decideTier(behaviorAtBase).tier).toBe('T1'); // content_marketing base = T1
  });

  it('honours an overridden base tier from the passed map (raise T1 → T2)', () => {
    const raised = { ...DOMAIN_BASE_TIER, content_marketing: 'T2' as const };
    const d = decideTier(behaviorAtBase, raised);
    expect(d.tier).toBe('T2');
    expect(d.baseTier).toBe('T2');
  });

  it('honours an overridden base tier from the passed map (lower T1 → T0)', () => {
    const lowered = { ...DOMAIN_BASE_TIER, content_marketing: 'T0' as const };
    const d = decideTier(behaviorAtBase, lowered);
    expect(d.tier).toBe('T0');
    expect(d.baseTier).toBe('T0');
  });
});

describe('decideTier — money-adjacent domain invariants', () => {
  it('payouts/statements behaviour change with no hard trigger keeps the T1 base', () => {
    // A behaviour-changing payouts ticket with no money/irreversible/integrity/access
    // trigger is T1 — matching a human applying page Version 2 (payouts / statements /
    // quotes = T1 base). It only reaches T2 when a hard trigger fires.
    const d = decideTier(facts({ behavior_change: 'yes', domain: 'payouts_statements' }));
    expect(d.tier).toBe('T1');
    expect(d.baseTier).toBe('T1');
    expect(d.firedRule).toBe('behavior_at_base');
  });

  it('payouts bookkeeping stamp (mark statement Paid, money=no) stays at the T1 base', () => {
    // Step 3's money-trigger carve-out: internal bookkeeping such as marking a
    // statement Paid or stamping a status date does NOT fire the money trigger even
    // though it changes behaviour. The extractor answers money=no, so this keeps the
    // payouts_statements T1 base instead of escalating to T2.
    const d = decideTier(facts({ behavior_change: 'yes', money: 'no', domain: 'payouts_statements' }));
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

describe('decideTier — Version 4 money boundary (bookkeeping vs will-pay calculation)', () => {
  // Danny's calibration, root-caused: "Purchase view: record inbound shipping and
  // tariff (duty) costs on each purchase" (golden row 13) was wrongly T2 via a false
  // money trigger. Version 4 makes the money trigger forward-looking: it fires only on
  // an amount someone WILL pay or be charged from now on (a calculation or path);
  // recording amounts ALREADY paid or incurred — costs, landed costs, purchase-cost
  // capture — is bookkeeping and does NOT fire. The domain routing then decides the
  // tier: an admin data-entry form is factory_administration (T1 base).

  it('recording already-paid costs (purchase cost capture): money=no, behaviour change routes by domain to T1', () => {
    // The extractor answers money=no (bookkeeping — the costs were already incurred)
    // and domain=factory_administration (an admin data-entry form). With no hard
    // trigger, decideTier keeps the domain base tier = T1.
    const d = decideTier(
      facts({ behavior_change: 'yes', money: 'no', domain: 'factory_administration' }),
    );
    expect(d.tier).toBe('T1');
    expect(d.baseTier).toBe('T1');
    expect(d.firedRule).toBe('behavior_at_base');
  });

  it('a pricing / quote CALCULATION change: money=yes → T2 (the trigger still fires forward-looking)', () => {
    // The mirror case: a change that alters an amount someone will be charged from now
    // on (a price / quote calculation or path) DOES fire the money trigger and escalates
    // to T2, whatever the base.
    const d = decideTier(
      facts({ behavior_change: 'yes', money: 'yes', domain: 'made_quoting_billing' }),
    );
    expect(d.tier).toBe('T2');
    expect(d.firedRule).toBe('t2_risk_trigger');
    expect(d.evidenceFact).toBe('money');
  });
});

describe('decideTier — ui_testable drivability boundary (DRIVE + VERIFY + COVER)', () => {
  // Danny's cancel-order correction upgraded ui_testable from a file-location blanket
  // to a three-question determination — a change is ui-testable only when a tester
  // can DRIVE it from a UI flow, VERIFY the outcome in the UI, and that pass would
  // COVER the change's plausible failure modes. The three worked examples below are
  // what the extractor answers for each; decideTier turns the answer into the tier.

  it('worked example #1 — cancel-order: cron+service diff, but DRIVE+VERIFY+COVER all yes → T1', () => {
    // "Bug: Cannot cancel full order" (golden row 41). The fix is 100% backend (cron +
    // transaction service), but QA DRIVEs it (cancel the order in admin), VERIFYs it
    // (the order shows Cancelled), and that pass COVERs the bug — so ui_testable=yes.
    // It restores already-approved cancel behavior with the order/state logic untouched
    // (restores_approved_behavior=yes), so the irreversible-cancel trigger does NOT
    // fire and the order_management T2 base caps at min(T2, T1) = T1.
    const d = decideTier(
      facts({
        ui_testable: 'yes',
        behavior_change: 'yes',
        irreversible_external: 'yes',
        restores_approved_behavior: 'yes',
        domain: 'order_management',
      }),
    );
    expect(d.tier).toBe('T1');
    expect(d.firedRule).toBe('restore_approved');
    expect(d.baseTier).toBe('T2');
    // A drivable change never takes the Step-1 terminal T0 path.
    expect(d.flags).not.toContain('non_ui_lane');
  });

  it('worked example #2 — xFleet / carrier webhook race: fails DRIVE (not reproducible) → T0 + Non-UI Lane', () => {
    // A wrong-machine xFleet event, or the SPS/Shippo shipping-webhook races (golden
    // rows 18 and 36): an async worker / webhook race with no product-UI flow that can
    // reproduce it. It fails DRIVE, so the extractor answers ui_testable=no and it takes
    // the Step-1 terminal T0 with the Non-UI Lane note (sensitive backend domain).
    const d = decideTier(
      facts({ ui_testable: 'no', behavior_change: 'yes', domain: 'porter_fulfillment_shipping' }),
    );
    expect(d.tier).toBe('T0');
    expect(d.firedRule).toBe('not_ui_testable');
    expect(d.flags).toContain('non_ui_lane');
  });

  it('worked example #3 — shared-helper refactor across many flows: DRIVE yes but COVER no → T0', () => {
    // A refactor of a shared helper used by a dozen flows is drivable, but driving one
    // flow gives false confidence — the automated suite + engineering review are the
    // real net, not a manual UI pass. COVER fails, so the extractor answers
    // ui_testable=no and it takes the Step-1 terminal T0. design_system is not a
    // sensitive backend domain, so there is no Non-UI Lane note.
    const d = decideTier(
      facts({ ui_testable: 'no', behavior_change: 'yes', domain: 'design_system' }),
    );
    expect(d.tier).toBe('T0');
    expect(d.firedRule).toBe('not_ui_testable');
    expect(d.flags).toEqual([]);
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
    expect(d.baseTier).toBe('T2');
  });

  it('checkout restyle, logic intact → T1 (behaviour-preserving cap min(base, T1))', () => {
    const d = decideTier(
      facts({ behavior_change: 'no', cosmetic_only: 'no', visual_blast_radius: 'yes', domain: 'shopping_checkout' }),
    );
    expect(d.tier).toBe('T1');
    expect(d.firedRule).toBe('behavior_preserving');
    // Base restored to T2 (page Version 2), but a behaviour-preserving change is
    // capped at min(base, T1) = T1.
    expect(d.baseTier).toBe('T2');
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

  it.each(['shopping_checkout', 'order_management', 'orders_notifications'] as const)(
    '%s behaviour change without a hard trigger → T2 (restored T2 base, page Version 2)',
    (domain) => {
      // Page Version 2 (hand-calibrated) restores these customer money/order surfaces
      // to a T2 base: a behaviour change with no money/irreversible/integrity/access
      // trigger now keeps the T2 base instead of the old T1.
      const d = decideTier(facts({ behavior_change: 'yes', domain }));
      expect(d.tier).toBe('T2');
      expect(d.firedRule).toBe('behavior_at_base');
      expect(d.baseTier).toBe('T2');
    },
  );

  it('wrong-data display bug is behaviour (not cosmetic) → keeps its domain base tier', () => {
    // Page Version 2: "Showing wrong data is not cosmetic — that is a behavior bug."
    // The extractor answers behavior_change=yes / cosmetic_only=no, so the change is
    // NOT downgraded to T0; with no hard trigger it keeps the domain base (T1 here).
    const d = decideTier(
      facts({ behavior_change: 'yes', cosmetic_only: 'no', domain: 'production_monitoring' }),
    );
    expect(d.tier).toBe('T1');
    expect(d.firedRule).toBe('behavior_at_base');
    expect(d.baseTier).toBe('T1');
  });

  it('editable internal admin surface (Grafana panel) → production_monitoring base T1', () => {
    // Page Version 3: internal admin surfaces that EDIT data (e.g. editable Grafana
    // panels) sit in production_monitoring (T1 base) — a read-only Grafana report is
    // reporting_analytics (T0). A behaviour change here with no hard trigger stays T1.
    expect(DOMAIN_BASE_TIER.production_monitoring).toBe('T1');
    const d = decideTier(facts({ behavior_change: 'yes', domain: 'production_monitoring' }));
    expect(d.tier).toBe('T1');
    expect(d.firedRule).toBe('behavior_at_base');
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

describe('decideTier — Step 3 restore carve-out (Version 3)', () => {
  it('a restore of approved behaviour in a T2 domain caps at T1 even with a hard trigger', () => {
    // "Unable to place an order" style regression fix: it commits an order again
    // (irreversible trigger would fire), but it only lets already-approved order
    // logic run — it decides no new amount and opens no new path — so the trigger
    // does not fire and it caps at min(T2, T1) = T1.
    const d = decideTier(
      facts({
        behavior_change: 'yes',
        irreversible_external: 'yes',
        restores_approved_behavior: 'yes',
        domain: 'order_management',
      }),
    );
    expect(d.tier).toBe('T1');
    expect(d.firedRule).toBe('restore_approved');
    expect(d.evidenceFact).toBe('restores_approved_behavior');
    expect(d.baseTier).toBe('T2');
  });

  it('a restore that also trips the money signal still caps at T1 (logic untouched)', () => {
    // A restore leaves the money / order / state logic untouched, so a money=yes
    // from the extractor is subordinate to the restore carve-out: the change lets
    // existing approved logic run again rather than deciding a new amount.
    const d = decideTier(
      facts({
        behavior_change: 'yes',
        money: 'yes',
        restores_approved_behavior: 'yes',
        domain: 'shopping_checkout',
      }),
    );
    expect(d.tier).toBe('T1');
    expect(d.firedRule).toBe('restore_approved');
  });

  it('a restore in a T1 domain stays T1', () => {
    const d = decideTier(
      facts({ behavior_change: 'yes', restores_approved_behavior: 'yes', domain: 'product_discovery' }),
    );
    expect(d.tier).toBe('T1');
    expect(d.firedRule).toBe('restore_approved');
  });

  it('a restore in an unknown domain caps at T1', () => {
    const d = decideTier(
      facts({ behavior_change: 'yes', irreversible_external: 'yes', restores_approved_behavior: 'yes', domain: 'unknown' }),
    );
    expect(d.tier).toBe('T1');
    expect(d.firedRule).toBe('restore_approved');
  });

  it('restores=unclear does NOT grant the carve-out: a hard trigger still escalates to T2', () => {
    // Version 3 clarifier: `unclear` is not a definite restore — it falls through to
    // the normal trigger / base handling, so a real money trigger keeps its T2.
    const d = decideTier(
      facts({
        behavior_change: 'yes',
        money: 'yes',
        restores_approved_behavior: 'unclear',
        domain: 'shopping_checkout',
      }),
    );
    expect(d.tier).toBe('T2');
    expect(d.firedRule).toBe('t2_risk_trigger');
  });

  it('restores=no leaves the hard trigger in force (new logic → T2)', () => {
    const d = decideTier(
      facts({
        behavior_change: 'yes',
        money: 'yes',
        restores_approved_behavior: 'no',
        domain: 'order_management',
      }),
    );
    expect(d.tier).toBe('T2');
    expect(d.firedRule).toBe('t2_risk_trigger');
  });

  it('a genuine new-logic behaviour change (restores=no, no trigger) keeps the base tier', () => {
    const d = decideTier(
      facts({ behavior_change: 'yes', restores_approved_behavior: 'no', domain: 'inventory_materials' }),
    );
    expect(d.tier).toBe('T2');
    expect(d.firedRule).toBe('behavior_at_base');
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
