import type { DeliveryTier } from '../board-config.js';

/**
 * Pure, deterministic tier computation. The LLM (see `extract.ts`) only produces
 * `Facts` (signals + a domain tag); this function turns them into a tier. Same
 * facts → same tier, always.
 *
 * The rubric this encodes is the public "Delivery Tier Classifier" Notion page,
 * transcribed verbatim into `src/prompts/delivery-tier-standard.md`. It is a
 * change-based model: risk — not the domain — decides the tier. The domain is an
 * output tag only (used for reporting), never a tier driver.
 *
 * Steps (stop at the first that assigns a tier):
 *   1. No UI surface → T0 (+ Non-UI Lane note when the backend touches
 *      money / orders / inventory / auth / pricing).
 *   2. Doesn't change how the feature works → never T2 (cosmetic → T0; more than
 *      cosmetic but still no behavior change → T1).
 *   3. Changes behavior AND is hard to recover from or costly (money · irreversible
 *      for a real customer · data/inventory integrity · access/security) → T2.
 *   4. Everything else → T1. Unsure whether step 3 applies → T1, never T0.
 */

export type Ternary = 'yes' | 'no' | 'unclear';

/** One extracted signal: a ternary answer plus a short verbatim evidence quote. */
export interface FactValue {
  value: Ternary;
  evidence: string;
}

/**
 * The functional domains from the public rubric page, plus `unknown`. This is an
 * OUTPUT TAG only — it never sets the tier. The page's `porter_catalog_products`
 * spelling is the corrected one (the page's earlier `porter_catlog_products` typo
 * is normalized here and on the page at parity check).
 */
export const DOMAIN_ENUM = [
  // Marketplace
  'auth_accounts',
  'shopping_checkout',
  'orders_notifications',
  'order_management',
  'gift_cards',
  'trade_b2b',
  'promotions_gifting',
  'organizations_wholesale',
  'product_discovery',
  'product_configuration',
  'content_marketing',
  'creators_referral',
  // Factory OS
  'inventory_materials',
  'production_workflow',
  'product_catalog_design',
  'machines_fleet',
  'production_monitoring',
  'factory_administration',
  'payouts_statements',
  // MadeOS
  'made_order_management',
  'made_quoting_billing',
  'design_workflow',
  'customer_operations',
  'made_products_catalog',
  'made_administration',
  // Cross-cutting
  'reporting_analytics',
  'design_system',
  'platform_infra',
  // Porter (backend)
  'porter_orders_payments',
  'porter_accounts_orgs',
  'porter_inventory_materials',
  'porter_manufacturing_jobs',
  'porter_fulfillment_shipping',
  'porter_integrations',
  'porter_catalog_products',
  'unknown',
] as const;

export type Domain = (typeof DOMAIN_ENUM)[number];

/** The full signal set the classifier extracts from a ticket. */
export interface Facts {
  /** Can QA meaningfully validate this through the product UI? */
  ui_testable: FactValue;
  /** Does the change alter how the feature actually works? */
  behavior_change: FactValue;
  /** Copy / text / styling / spacing / layout only — no behavior change? */
  cosmetic_only: FactValue;
  /** Creates or changes a charge, refund, payout, price, tax, shipping, discount,
   *  credit, or gift-card value. */
  money: FactValue;
  /** Commits or cancels a real order, sends a customer email/SMS/push, or
   *  hard-deletes customer data. */
  irreversible_external: FactValue;
  /** Can corrupt orders, inventory, or stored records in a hard-to-undo way. */
  data_integrity: FactValue;
  /** Changes authentication, access, or permissions in a risky way. */
  access_security: FactValue;
  /** Wide visual reach (new/removed screen · shared component · layout
   *  restructure). Extracted for REPORTING ONLY — it never sets the tier. */
  visual_blast_radius: FactValue;
  domain: Domain;
}

/** The signal keys that carry a ternary value + evidence (everything but `domain`). */
export type FactKey = Exclude<keyof Facts, 'domain'>;

/** Which rubric step produced the tier — drives the "Why" line in the comment. */
export type FiredRule =
  | 'not_ui_testable'
  | 'cosmetic'
  | 'no_behavior_change'
  | 't2_risk_trigger'
  | 'behavior_recoverable'
  | 'inconclusive';

/** Non-tier-changing annotations that append to the comment. */
export type FlagKey = 'non_ui_lane';

export interface Decision {
  tier: DeliveryTier;
  /** True when uncertainty forced the tier up to T1 (never leave unsure at T0). */
  liftedByUnclear: boolean;
  flags: FlagKey[];
  firedRule: FiredRule;
  /** The signal whose evidence best explains the decision, or null when none. */
  evidenceFact: FactKey | null;
}

/** The four risk signals that make a behavior-changing ticket T2 (rubric step 3). */
const T2_TRIGGERS: FactKey[] = ['money', 'irreversible_external', 'data_integrity', 'access_security'];

/**
 * Domains whose backend is money / orders / inventory / auth / pricing sensitive.
 * A non-UI-testable change in one of these carries the Non-UI Lane note even when
 * no risk signal fired yes (e.g. a behavior-preserving refactor of payments code).
 */
const SENSITIVE_NONUI_DOMAINS: ReadonlySet<Domain> = new Set<Domain>([
  'shopping_checkout',
  'orders_notifications',
  'order_management',
  'gift_cards',
  'promotions_gifting',
  'payouts_statements',
  'made_order_management',
  'made_quoting_billing',
  'inventory_materials',
  'auth_accounts',
  'organizations_wholesale',
  'porter_orders_payments',
  'porter_accounts_orgs',
  'porter_inventory_materials',
  'porter_fulfillment_shipping',
]);

/** True when a non-UI-testable change should carry the Non-UI Lane note. */
function touchesSensitiveBackend(facts: Facts): boolean {
  if (T2_TRIGGERS.some((k) => facts[k].value === 'yes')) return true;
  return SENSITIVE_NONUI_DOMAINS.has(facts.domain);
}

export function decideTier(facts: Facts): Decision {
  // Step 1 — no UI surface → T0 (terminal). The Non-UI Lane note is engineering's
  // binding gate whenever the backend touches money / orders / inventory / auth /
  // pricing. Only a LITERAL `no` is terminal; `unclear` falls through.
  if (facts.ui_testable.value === 'no') {
    const flags: FlagKey[] = touchesSensitiveBackend(facts) ? ['non_ui_lane'] : [];
    return { tier: 'T0', liftedByUnclear: false, flags, firedRule: 'not_ui_testable', evidenceFact: 'ui_testable' };
  }

  // When UI-testability itself is unclear, a cosmetic-looking change must not settle
  // at T0 — we cannot confirm there is nothing to test, so it floors at T1.
  const uiUnclear = facts.ui_testable.value === 'unclear';

  // Step 2 — the change does NOT alter how the feature works → never T2.
  if (facts.behavior_change.value === 'no') {
    if (facts.cosmetic_only.value === 'yes') {
      if (uiUnclear) {
        return { tier: 'T1', liftedByUnclear: true, flags: [], firedRule: 'inconclusive', evidenceFact: 'ui_testable' };
      }
      // Purely cosmetic — copy / style / layout only → T0.
      return { tier: 'T0', liftedByUnclear: false, flags: [], firedRule: 'cosmetic', evidenceFact: 'cosmetic_only' };
    }
    // More than cosmetic but still no behavior change → T1.
    return { tier: 'T1', liftedByUnclear: false, flags: [], firedRule: 'no_behavior_change', evidenceFact: 'behavior_change' };
  }

  // Step 3 — the change DOES alter behavior. T2 only if it is also hard to recover
  // from or costly (money · irreversible external · data integrity · access/security).
  if (facts.behavior_change.value === 'yes') {
    const trigger = T2_TRIGGERS.find((k) => facts[k].value === 'yes');
    if (trigger) {
      return { tier: 'T2', liftedByUnclear: false, flags: [], firedRule: 't2_risk_trigger', evidenceFact: trigger };
    }
    // Unsure whether step 3 applies (a risk signal is unclear) → T1, never leave it
    // at a lower tier.
    const unclearTrigger = T2_TRIGGERS.find((k) => facts[k].value === 'unclear');
    if (unclearTrigger) {
      return { tier: 'T1', liftedByUnclear: true, flags: [], firedRule: 'inconclusive', evidenceFact: unclearTrigger };
    }
    // Step 4 — behavior change that is quickly recoverable → T1.
    return { tier: 'T1', liftedByUnclear: false, flags: [], firedRule: 'behavior_recoverable', evidenceFact: 'behavior_change' };
  }

  // `behavior_change` is unclear → step 4 uncertainty rule → T1 (never T0).
  return { tier: 'T1', liftedByUnclear: true, flags: [], firedRule: 'inconclusive', evidenceFact: 'behavior_change' };
}
