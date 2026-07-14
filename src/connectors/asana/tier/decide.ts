import { TIER_RANK, maxTier, type DeliveryTier } from '../board-config.js';

/**
 * Pure, deterministic tier computation. The LLM (see `extract.ts`) produces the
 * `Facts` (a domain tag + signals + the model's own tier); this function turns
 * them into the authoritative tier. Same facts → same tier, always.
 *
 * This encodes the FINAL rubric — the public "Delivery Tier Classifier" Notion
 * page (Version 2), transcribed verbatim into
 * `src/prompts/delivery-tier-standard.md`. It is a DOMAIN-BASE model: the
 * functional domain sets a base tier and the actual change raises or lowers it.
 *
 * Steps (stop at the first that assigns a tier):
 *   1. No UI surface → T0 (+ Non-UI Lane note when the backend touches
 *      money / orders / inventory / auth / pricing). Terminal.
 *   2. base = DOMAIN_BASE_TIER[domain] (unknown → T1).
 *   3. Risk downgrade: no behaviour change → cosmetic → T0, else visible-but-
 *      behaviour-preserving → min(base, T1); behaviour change → keep base.
 *   4. Hard-trigger escalation: behaviour change AND (money · irreversible for a
 *      real customer · data/inventory integrity · access/security) → T2.
 *   5. Uncertainty floor: any decision-relevant unclear or domain unknown →
 *      at least T1 (a definite T2 stays T2; a step-1 terminal T0 is unaffected
 *      unless `ui_testable` itself is unclear).
 *
 * Finally, a calibration cross-check: the LLM also returns its own tier; when it
 * disagrees with the code-computed tier we floor the result to at least T1 and
 * flag the record so the Monday report can count the miss.
 */

export type Ternary = 'yes' | 'no' | 'unclear';

/** One extracted signal: a ternary answer plus a short verbatim evidence quote. */
export interface FactValue {
  value: Ternary;
  evidence: string;
}

/**
 * The functional domains from the public rubric page, plus `unknown`. Each maps
 * to a base tier in `DOMAIN_BASE_TIER`. The page's `porter_catlog_products` typo
 * is normalized to `porter_catalog_products` in code and on the page at the
 * parity check.
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

/**
 * DOMAIN_BASE_TIER — the base tier each functional domain starts at, transcribed
 * verbatim from the Notion rubric page (Version 2). The change (Step 3/4) raises
 * or lowers it. Only the domains where a base defect is dangerous regardless of
 * money sit at T2 (auth, inventory, production, and the customer money/order
 * surfaces); read-only reporting and pure infra sit at T0; everything else, and
 * `unknown`, is T1.
 */
export const DOMAIN_BASE_TIER: Record<Domain, DeliveryTier> = {
  auth_accounts: 'T2',
  inventory_materials: 'T2',
  production_workflow: 'T2',
  shopping_checkout: 'T2',
  orders_notifications: 'T2',
  order_management: 'T2',
  payouts_statements: 'T1',
  made_order_management: 'T1',
  made_quoting_billing: 'T1',
  gift_cards: 'T1',
  trade_b2b: 'T1',
  promotions_gifting: 'T1',
  organizations_wholesale: 'T1',
  product_discovery: 'T1',
  product_configuration: 'T1',
  content_marketing: 'T1',
  creators_referral: 'T1',
  product_catalog_design: 'T1',
  machines_fleet: 'T1',
  production_monitoring: 'T1',
  factory_administration: 'T1',
  design_workflow: 'T1',
  customer_operations: 'T1',
  made_products_catalog: 'T1',
  made_administration: 'T1',
  porter_orders_payments: 'T1',
  porter_inventory_materials: 'T1',
  porter_accounts_orgs: 'T1',
  porter_manufacturing_jobs: 'T1',
  porter_fulfillment_shipping: 'T1',
  porter_integrations: 'T1',
  porter_catalog_products: 'T1',
  design_system: 'T1',
  unknown: 'T1',
  reporting_analytics: 'T0',
  platform_infra: 'T0',
};

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
  /** The model's own tier answer, kept for the calibration cross-check. Null when
   *  the model omitted it or returned an unrecognized value. */
  llmTier: DeliveryTier | null;
}

/** The signal keys that carry a ternary value + evidence (everything but `domain`
 *  and `llmTier`). */
export type FactKey = Exclude<keyof Facts, 'domain' | 'llmTier'>;

/** Which rubric step produced the tier — drives the "Why" line in the comment. */
export type FiredRule =
  | 'not_ui_testable'
  | 'cosmetic'
  | 'behavior_preserving'
  | 't2_risk_trigger'
  | 'behavior_at_base'
  | 'inconclusive';

/** Non-tier-changing annotations that append to the comment. */
export type FlagKey = 'non_ui_lane';

export interface Decision {
  tier: DeliveryTier;
  /** The domain's base tier before the change adjusted it (reporting/debugging). */
  baseTier: DeliveryTier;
  /** True when uncertainty forced the tier up to T1 (never leave unsure at T0). */
  liftedByUnclear: boolean;
  /** True when the LLM's own tier disagreed with the code-computed tier: the
   *  result was floored to at least T1 and the miss is counted in the report. */
  calibrationMismatch: boolean;
  flags: FlagKey[];
  firedRule: FiredRule;
  /** The signal whose evidence best explains the decision, or null when none. */
  evidenceFact: FactKey | null;
}

/** The four risk signals that make a behavior-changing ticket T2 (rubric step 4). */
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

/** min of two tiers (used by the behavior-preserving cap: min(base, T1)). */
function minTier(a: DeliveryTier, b: DeliveryTier): DeliveryTier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

export function decideTier(facts: Facts): Decision {
  // Step 1 — no UI surface → T0 (terminal). The Non-UI Lane note is engineering's
  // binding gate whenever the backend touches money / orders / inventory / auth /
  // pricing. Only a LITERAL `no` is terminal; `unclear` falls through. The
  // calibration cross-check does NOT touch a step-1 terminal (QA-is-UI-only stays
  // supreme) unless `ui_testable` itself is unclear (handled below).
  if (facts.ui_testable.value === 'no') {
    const flags: FlagKey[] = touchesSensitiveBackend(facts) ? ['non_ui_lane'] : [];
    return {
      tier: 'T0',
      baseTier: DOMAIN_BASE_TIER[facts.domain],
      liftedByUnclear: false,
      calibrationMismatch: false,
      flags,
      firedRule: 'not_ui_testable',
      evidenceFact: 'ui_testable',
    };
  }

  // Step 2 — domain base tier.
  const base = DOMAIN_BASE_TIER[facts.domain];
  const domainUnknown = facts.domain === 'unknown';
  const uiUnclear = facts.ui_testable.value === 'unclear';

  // Steps 3 & 4 — the change adjusts the base.
  let tier: DeliveryTier;
  let firedRule: FiredRule;
  let evidenceFact: FactKey | null;
  // Signals that could still flip the decision if they were clearer.
  let relevantUnclear = uiUnclear || domainUnknown;

  const bc = facts.behavior_change.value;
  if (bc === 'no') {
    // Step 3 — no behavior change: cosmetic → T0, otherwise the visible-but-
    // behavior-preserving cap → min(base, T1).
    if (facts.cosmetic_only.value === 'yes') {
      tier = 'T0';
      firedRule = 'cosmetic';
      evidenceFact = 'cosmetic_only';
    } else {
      tier = minTier(base, 'T1');
      firedRule = 'behavior_preserving';
      evidenceFact = 'behavior_change';
      if (facts.cosmetic_only.value === 'unclear') relevantUnclear = true;
    }
  } else if (bc === 'yes') {
    // Step 4 — hard-trigger escalation.
    const trigger = T2_TRIGGERS.find((k) => facts[k].value === 'yes');
    if (trigger) {
      tier = 'T2';
      firedRule = 't2_risk_trigger';
      evidenceFact = trigger;
    } else {
      tier = base;
      firedRule = 'behavior_at_base';
      evidenceFact = 'behavior_change';
      if (T2_TRIGGERS.some((k) => facts[k].value === 'unclear')) relevantUnclear = true;
    }
  } else {
    // behavior_change unclear → keep the base and let the floor decide.
    tier = base;
    firedRule = 'behavior_at_base';
    evidenceFact = 'behavior_change';
    relevantUnclear = true;
  }

  // Step 5 — uncertainty floor. A definite T2 stays T2; the floor only ever lifts
  // a sub-T1 tier up to T1 when a decision-relevant answer is unclear/unknown.
  let liftedByUnclear = false;
  if (relevantUnclear && TIER_RANK[tier] < TIER_RANK.T1) {
    tier = 'T1';
    liftedByUnclear = true;
    firedRule = 'inconclusive';
    // Prefer the ui/behaviour/domain uncertainty as the cited fact.
    evidenceFact = uiUnclear ? 'ui_testable' : evidenceFact;
  } else if (bc === 'unclear' && tier === 'T1') {
    // Behaviour could not be determined and the tier landed at the T1 default — this
    // is an inconclusive classification, even though the base did not need lifting.
    liftedByUnclear = true;
    firedRule = 'inconclusive';
    evidenceFact = uiUnclear ? 'ui_testable' : 'behavior_change';
  }

  // Calibration cross-check — the LLM's own tier vs the code-computed tier. On a
  // disagreement, floor to at least T1 and flag the record so the miss is counted.
  let calibrationMismatch = false;
  if (facts.llmTier && facts.llmTier !== tier) {
    calibrationMismatch = true;
    tier = maxTier(tier, 'T1');
  }

  return {
    tier,
    baseTier: base,
    liftedByUnclear,
    calibrationMismatch,
    flags: [],
    firedRule,
    evidenceFact,
  };
}
