import type { DeliveryTier } from '../board-config.js';
import type { Decision, Domain, FactKey, Facts, FlagKey } from './decide.js';

/**
 * Pure template renderer for the Asana comment. No LLM — the comment is a
 * deterministic function of the decision + facts, so it is cheap and the wording
 * is auditable. English, to match the board.
 */

/** Public rubric link cited in every comment (the Delivery Tier rubric in Notion). */
export const RUBRIC_URL = 'https://www.notion.so/39ddb572aef48169897efefd543290b9';

const TIER_HEADLINE: Record<DeliveryTier, string> = {
  T0: 'T0 — engineering validation',
  T1: 'T1 — production, then QA',
  T2: 'T2 — QA before production',
};

/** Human labels for the functional domains (output tag only). */
const DOMAIN_LABEL: Record<Domain, string> = {
  auth_accounts: 'Auth & Accounts',
  shopping_checkout: 'Shopping & Checkout',
  orders_notifications: 'Orders & Notifications',
  order_management: 'Order Management',
  gift_cards: 'Gift Cards',
  trade_b2b: 'Trade / B2B',
  promotions_gifting: 'Promotions & Gifting',
  organizations_wholesale: 'Organizations & Wholesale',
  product_discovery: 'Product Discovery',
  product_configuration: 'Product Configuration',
  content_marketing: 'Content & Marketing',
  creators_referral: 'Creators & Referral',
  inventory_materials: 'Inventory & Materials',
  production_workflow: 'Production Workflow',
  product_catalog_design: 'Product Catalog & Design',
  machines_fleet: 'Machines & Fleet',
  production_monitoring: 'Production Monitoring',
  factory_administration: 'Factory Administration',
  payouts_statements: 'Payouts & Statements',
  made_order_management: 'Made Order Management',
  made_quoting_billing: 'Made Quoting & Billing',
  design_workflow: 'Design Workflow',
  customer_operations: 'Customer Operations',
  made_products_catalog: 'Made Products Catalog',
  made_administration: 'Made Administration',
  reporting_analytics: 'Reporting & Analytics',
  design_system: 'Design System',
  platform_infra: 'Platform & Infrastructure',
  porter_orders_payments: 'Porter — Orders & Payments',
  porter_accounts_orgs: 'Porter — Accounts & Orgs',
  porter_inventory_materials: 'Porter — Inventory & Materials',
  porter_manufacturing_jobs: 'Porter — Manufacturing Jobs',
  porter_fulfillment_shipping: 'Porter — Fulfillment & Shipping',
  porter_integrations: 'Porter — Integrations',
  porter_catalog_products: 'Porter — Catalog & Products',
  unknown: 'Unknown',
};

const FLAG_TEXT: Record<FlagKey, string> = {
  non_ui_lane: 'Non-UI Lane — binding engineering gate: extra reviewer + E2E + staging.',
};

/** Human-readable name of a signal, for the inconclusive "couldn't determine X" line. */
const FACT_PHRASE: Record<FactKey, string> = {
  ui_testable: 'whether this is testable through the UI',
  behavior_change: 'whether this changes how the feature works',
  cosmetic_only: 'whether this is a purely cosmetic change',
  money: 'whether this changes money the customer is charged',
  irreversible_external: 'whether this takes an irreversible action for a real customer',
  data_integrity: 'whether this can corrupt orders, inventory, or stored records',
  access_security: 'whether this changes authentication, access, or permissions',
  visual_blast_radius: 'the visual blast radius of this change',
};

const DISPUTE_LINE =
  'Disagree? You can raise a tier yourself; lowering is never a solo call — the Engineering Manager is the tie-break.';

/** The "Why" sentence for the decision. */
function whyLine(decision: Decision): string {
  switch (decision.firedRule) {
    case 'not_ui_testable':
      return 'nothing can be tested through the product UI, so QA cannot gate it (rubric Step 1).';
    case 'cosmetic':
      return 'it is a purely cosmetic change — copy, styling, or layout only, with no change to how the feature works (rubric Step 2).';
    case 'no_behavior_change':
      return 'it changes the UI but not how the feature works (rubric Step 2) — ship, then QA validates after release.';
    case 't2_risk_trigger':
      switch (decision.evidenceFact) {
        case 'money':
          return 'it changes money — a charge, refund, payout, price, tax, shipping, discount, credit, or gift-card value (rubric Step 3).';
        case 'irreversible_external':
          return 'it takes an irreversible action for a real customer — a committed/cancelled order, a customer email/SMS/push, or a hard-delete (rubric Step 3).';
        case 'data_integrity':
          return 'it can corrupt orders, inventory, or stored records in a way that is hard to undo (rubric Step 3).';
        case 'access_security':
          return 'it changes authentication, access, or permissions in a way that could lock customers out or expose data (rubric Step 3).';
        default:
          return 'it changes behavior in a way that is hard to recover from or costly (rubric Step 3).';
      }
    case 'behavior_recoverable':
      return 'it changes customer-facing behavior but is quickly recoverable (rubric Step 4) — ship, then QA validates after release.';
    case 'inconclusive': {
      const fact = decision.evidenceFact ?? 'behavior_change';
      return `couldn't determine ${FACT_PHRASE[fact]} from the ticket → defaulting to T1 (rubric Step 4: unsure → T1). Add detail to the description and the bot will re-classify.`;
    }
  }
}

/**
 * Render the full comment body. Prefixed with 🤖 so bot authorship is obvious
 * even though the write uses Danny's PAT.
 */
export function renderTierComment(decision: Decision, facts: Facts, promptVersion: number): string {
  const lines: string[] = [];
  lines.push(`🤖 Delivery Tier: ${TIER_HEADLINE[decision.tier]}`);
  lines.push(`Why: ${whyLine(decision)}`);

  // Evidence quote, only when there is a real quote to show (skip for inconclusive
  // and low-risk, where there is nothing meaningful to cite).
  if (decision.evidenceFact && decision.firedRule !== 'inconclusive') {
    const evidence = facts[decision.evidenceFact].evidence.trim();
    if (evidence) lines.push(`Evidence: "${evidence}"`);
  }

  if (decision.flags.length > 0) {
    lines.push(`Flags: ${decision.flags.map((f) => FLAG_TEXT[f]).join(' ')}`);
  }

  lines.push(`Domain: ${DOMAIN_LABEL[facts.domain]}`);
  lines.push(`Rubric v${promptVersion} · ${RUBRIC_URL} · ${DISPUTE_LINE}`);
  return lines.join('\n');
}

/**
 * Render the comment posted when a PR diff re-check RAISES a ticket's tier. The
 * diff is the authoritative source, so the "Why" cites the diff-derived decision.
 * Raise-only: this is never emitted for a lower or equal diff tier.
 */
export function renderTierRaiseComment(args: {
  prNumber: number;
  fromTier: DeliveryTier;
  toTier: DeliveryTier;
  decision: Decision;
  facts: Facts;
  promptVersion: number;
}): string {
  const { prNumber, fromTier, toTier, decision, facts, promptVersion } = args;
  const lines: string[] = [];
  lines.push(`🤖 Tier raised ${fromTier} → ${toTier} after PR #${prNumber} diff review.`);
  lines.push(`Why: ${whyLine(decision)}`);

  if (decision.evidenceFact && decision.firedRule !== 'inconclusive') {
    const evidence = facts[decision.evidenceFact].evidence.trim();
    if (evidence) lines.push(`Evidence: "${evidence}"`);
  }

  if (decision.flags.length > 0) {
    lines.push(`Flags: ${decision.flags.map((f) => FLAG_TEXT[f]).join(' ')}`);
  }

  lines.push(`Domain: ${DOMAIN_LABEL[facts.domain]}`);
  lines.push(`Rubric v${promptVersion} · ${RUBRIC_URL} · ${DISPUTE_LINE}`);
  return lines.join('\n');
}
