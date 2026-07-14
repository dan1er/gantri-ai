import type { DeliveryTier } from '../board-config.js';

/**
 * Pure, deterministic tier computation. The LLM (see `extract.ts`) only produces
 * `Facts`; this function turns facts into a tier. Same facts → same tier, always.
 * The rubric this encodes is the public "Pre-Production Test Tiering" decision
 * tree, plus Danny's two automation rules: not UI-testable → T0; inconclusive →
 * lift to T1.
 */

export type Ternary = 'yes' | 'no' | 'unclear';

/** One extracted fact: a ternary answer plus a short verbatim evidence quote. */
export interface FactValue {
  value: Ternary;
  evidence: string;
}

/** The functional domains from the public framework, plus `unknown`. */
export const DOMAIN_ENUM = [
  'auth_accounts',
  'product_discovery',
  'product_configuration',
  'shopping_checkout',
  'orders_notifications',
  'content_marketing',
  'production_workflow',
  'scheduling_fulfillment',
  'inventory_materials',
  'production_monitoring',
  'factory_administration',
  'made_order_management',
  'design_workflow',
  'customer_operations',
  'reporting_analytics',
  'made_administration',
  'unknown',
] as const;

export type Domain = (typeof DOMAIN_ENUM)[number];

/** The full fact set the classifier extracts from a ticket. */
export interface Facts {
  ui_testable: FactValue;
  irreversible_external: FactValue;
  money_visible: FactValue;
  visual_blast_radius: FactValue;
  brand_critical: FactValue;
  backend_data: FactValue;
  coordinated_launch: FactValue;
  domain: Domain;
}

/** The fact keys that carry a ternary value + evidence (everything but `domain`). */
export type FactKey = Exclude<keyof Facts, 'domain'>;

/** Which rubric rule produced the tier — drives the "Why" line in the comment. */
export type FiredRule =
  | 'not_ui_testable'
  | 'money_or_irreversible'
  | 'visual_blast'
  | 'inconclusive_lift'
  | 'low_risk';

/** Non-tier-changing annotations that append to the comment. */
export type FlagKey = 'non_ui_lane' | 'brand_critical' | 'coordinated_launch';

export interface Decision {
  tier: DeliveryTier;
  /** True when the inconclusive rule raised the tier to T1. */
  liftedByUnclear: boolean;
  flags: FlagKey[];
  firedRule: FiredRule;
  /** The fact whose evidence best explains the decision, or null for `low_risk`. */
  evidenceFact: FactKey | null;
}

/**
 * The facts, in priority order, that can change the tier (used both by the base
 * computation and by the inconclusive-lift check). `brand_critical`,
 * `backend_data`, and `coordinated_launch` are flags only, never tier drivers.
 */
const DECISION_FACTS: FactKey[] = [
  'ui_testable',
  'irreversible_external',
  'money_visible',
  'visual_blast_radius',
];

/** Compute the flags that append to the comment (they never change the tier). */
function computeFlags(facts: Facts): FlagKey[] {
  const flags: FlagKey[] = [];
  const moneyOrIrreversible =
    facts.money_visible.value === 'yes' || facts.irreversible_external.value === 'yes';
  // Non-UI Lane: engineering verification is the binding gate whenever there is
  // backend-data risk, or when a non-UI-testable change still moves real money /
  // fires an irreversible external effect (QA cannot gate it, so engineering must).
  if (facts.backend_data.value === 'yes' || (facts.ui_testable.value === 'no' && moneyOrIrreversible)) {
    flags.push('non_ui_lane');
  }
  if (facts.brand_critical.value === 'yes') flags.push('brand_critical');
  if (facts.coordinated_launch.value === 'yes') flags.push('coordinated_launch');
  return flags;
}

/** First decision-relevant fact whose value is `unclear`, in priority order. */
function firstUnclearDecisionFact(facts: Facts): FactKey | null {
  for (const key of DECISION_FACTS) {
    if (facts[key].value === 'unclear') return key;
  }
  return null;
}

export function decideTier(facts: Facts): Decision {
  const flags = computeFlags(facts);

  // 1. Not UI-testable is terminal T0 — QA cannot gate it, so QA tiers are moot.
  //    Backend/money/irreversible risk still surfaces as the Non-UI Lane flag,
  //    which is engineering's binding gate. Only a LITERAL `no` is terminal;
  //    `unclear` falls through and can lift to T1.
  if (facts.ui_testable.value === 'no') {
    return {
      tier: 'T0',
      liftedByUnclear: false,
      flags,
      firedRule: 'not_ui_testable',
      evidenceFact: 'ui_testable',
    };
  }

  // 2-4. Base tier (treating `unclear` as `no`), first match wins.
  let baseTier: DeliveryTier;
  let firedRule: FiredRule;
  let evidenceFact: FactKey | null;
  if (facts.irreversible_external.value === 'yes' || facts.money_visible.value === 'yes') {
    baseTier = 'T2';
    firedRule = 'money_or_irreversible';
    evidenceFact = facts.money_visible.value === 'yes' ? 'money_visible' : 'irreversible_external';
  } else if (facts.visual_blast_radius.value === 'yes') {
    baseTier = 'T1';
    firedRule = 'visual_blast';
    evidenceFact = 'visual_blast_radius';
  } else {
    baseTier = 'T0';
    firedRule = 'low_risk';
    evidenceFact = null;
  }

  // Inconclusive lift (Danny's rule): a definite T2 stays T2, but when the base
  // tier is below T1 and any decision-relevant fact is unclear, lift to T1 — we
  // cannot let inconclusive risk ship as T0. The lift is capped at T1.
  if (baseTier === 'T0') {
    const unclearFact = firstUnclearDecisionFact(facts);
    if (unclearFact) {
      return {
        tier: 'T1',
        liftedByUnclear: true,
        flags,
        firedRule: 'inconclusive_lift',
        evidenceFact: unclearFact,
      };
    }
  }

  return { tier: baseTier, liftedByUnclear: false, flags, firedRule, evidenceFact };
}
