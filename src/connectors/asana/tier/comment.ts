import type { DeliveryTier } from '../board-config.js';
import type { Decision, Domain, FactKey, Facts, FlagKey } from './decide.js';

/**
 * Pure template renderer for the Asana comment. No LLM — the comment is a
 * deterministic function of the decision + facts, so it is cheap and the wording
 * is auditable. English, to match the board.
 */

/** Public rubric link cited in every comment (the practical guide in Notion). */
export const RUBRIC_URL = 'https://www.notion.so/38ddb572aef4810d95d9fdd36fa3bda1';

const TIER_HEADLINE: Record<DeliveryTier, string> = {
  T0: 'T0 — engineering validation',
  T1: 'T1 — targeted QA',
  T2: 'T2 — QA before production',
};

/** Human labels for the functional domains. */
const DOMAIN_LABEL: Record<Domain, string> = {
  auth_accounts: 'Auth & Accounts',
  product_discovery: 'Product Discovery',
  product_configuration: 'Product Configuration',
  shopping_checkout: 'Shopping & Checkout',
  orders_notifications: 'Orders & Notifications',
  content_marketing: 'Content & Marketing',
  production_workflow: 'Production Workflow',
  scheduling_fulfillment: 'Scheduling & Fulfillment',
  inventory_materials: 'Inventory & Materials',
  production_monitoring: 'Production Monitoring',
  factory_administration: 'Factory Administration',
  made_order_management: 'Made Order Management',
  design_workflow: 'Design Workflow',
  customer_operations: 'Customer Operations',
  reporting_analytics: 'Reporting & Analytics',
  made_administration: 'Made Administration',
  unknown: 'Unknown',
};

const FLAG_TEXT: Record<FlagKey, string> = {
  non_ui_lane:
    'Non-UI Lane — engineering verification is the binding gate (extra reviewer + E2E + staging).',
  brand_critical:
    'Brand-critical surface — author self-check against the approved design; QA looks first post-release.',
  coordinated_launch:
    'Coordinated launch — verify ahead of the date on preview; a binding pass upfront.',
};

/** Human-readable name of a fact, for the inconclusive "couldn't determine X" line. */
const FACT_PHRASE: Record<FactKey, string> = {
  ui_testable: 'whether this is testable through the UI',
  irreversible_external: 'whether this fires an irreversible external effect on a customer',
  money_visible: 'whether this changes the money the customer sees or pays',
  visual_blast_radius: 'the visual blast radius of this change',
  brand_critical: 'whether this touches a brand-critical surface',
  backend_data: 'whether this touches data-critical backend',
  coordinated_launch: 'whether this is tied to a coordinated launch',
};

const DISPUTE_LINE =
  'Disagree? You can raise a tier yourself; lowering is never a solo call — the Engineering Manager is the tie-break.';

/** The "Why" sentence for the decision. */
function whyLine(decision: Decision): string {
  switch (decision.firedRule) {
    case 'not_ui_testable':
      return 'this change cannot be validated through the product UI, so QA cannot gate it (rubric: Non-UI Lane).';
    case 'money_or_irreversible':
      return decision.evidenceFact === 'money_visible'
        ? 'it changes the money the customer sees or pays (rubric Q3).'
        : 'it fires an irreversible external effect on a real customer (rubric Q2).';
    case 'visual_blast':
      return 'it has a wide visual blast radius — a shared component, new/removed screen, or layout restructure (rubric Q4).';
    case 'low_risk':
      return 'it is a low-risk, UI-testable change with no money, irreversible, or wide-visual impact.';
    case 'inconclusive_lift': {
      const fact = decision.evidenceFact ?? 'ui_testable';
      return `couldn't determine ${FACT_PHRASE[fact]} from the ticket → defaulting to T1 (inconclusive rule). Add detail to the description and the bot will re-classify.`;
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
  if (decision.evidenceFact && decision.firedRule !== 'inconclusive_lift') {
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
