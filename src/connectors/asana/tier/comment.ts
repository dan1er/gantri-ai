import type { DeliveryTier } from '../board-config.js';
import type { Decision, Domain, Facts } from './decide.js';

/**
 * Pure template renderer for the Asana comment. No LLM — the comment is a
 * deterministic function of the decision + facts, so it is cheap and the wording
 * is auditable. English, to match the board.
 *
 * The comment is deliberately COMPACT: at most three lines.
 *   Line 1 — verdict · short rule clause · domain (+ Non-UI Lane tag when flagged).
 *   Line 2 — the evidence quote (truncated), omitted when there is none.
 *   Line 3 — status + the Rubric link.
 * The longer prose (dispute policy, per-trigger enumerations, the "Why" sentence,
 * the standalone Domain line, the Non-UI Lane paragraph) lives on the rubric page,
 * not on every ticket.
 */

/** Public rubric link cited in every comment (the Delivery Tier rubric in Notion). */
export const RUBRIC_URL = 'https://www.notion.so/39ddb572aef48169897efefd543290b9';

/** Longest evidence quote we inline before truncating with a trailing ellipsis. */
const MAX_EVIDENCE = 90;

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

/** The provisional-pass marker: the tier is an early guess and will be re-checked
 *  from the real PR diff once the ticket reaches Code Review. */
export const PROVISIONAL_LINE = 'Provisional until Code Review';

/** The actionable tail shown on the inconclusive (unclear → T1 floor) case. */
const UNCLEAR_TAIL = 'Add detail and the bot re-classifies';

/** The suffix that replaces the long Non-UI Lane sentence when the flag is set. */
const NON_UI_LANE_TAG = ' · Non-UI Lane (eng gate)';

/**
 * The short rule clause for line 1 — a ≤6-word phrase per fired rule, with the
 * rubric step it came from. Derived from the FiredRule cases in `decide.ts`.
 */
function ruleClause(decision: Decision): string {
  switch (decision.firedRule) {
    case 'not_ui_testable':
      return 'no UI flow to gate (Step 1)';
    case 'cosmetic':
      return 'cosmetic only (Step 3)';
    case 'behavior_preserving':
      return 'behavior-preserving (Step 3)';
    case 'restore_approved':
      return 'restores approved behavior (Step 3)';
    case 't2_risk_trigger':
      switch (decision.evidenceFact) {
        case 'money':
          return 'changes money (Step 3)';
        case 'irreversible_external':
          return 'irreversible for a customer (Step 3)';
        case 'data_integrity':
          return 'data/inventory integrity (Step 3)';
        case 'access_security':
          return 'access/security (Step 3)';
        default:
          return 'hard risk trigger (Step 3)';
      }
    case 'behavior_at_base':
      return 'behavior change at domain base (Step 2)';
    case 'inconclusive':
      return 'unclear → T1 floor (Step 4)';
  }
}

/** Line 1 tail shared by both renderers: `<rule clause> · <domain>` (+ Non-UI Lane). */
function ruleAndDomain(decision: Decision, facts: Facts): string {
  const laneTag = decision.flags.includes('non_ui_lane') ? NON_UI_LANE_TAG : '';
  return `${ruleClause(decision)} · ${DOMAIN_LABEL[facts.domain]}${laneTag}`;
}

/** The evidence quote line, truncated to MAX_EVIDENCE chars with a trailing ellipsis
 *  when longer. Null when there is no meaningful quote (or on the inconclusive case,
 *  where there is nothing to cite). */
function evidenceLine(decision: Decision, facts: Facts): string | null {
  if (!decision.evidenceFact || decision.firedRule === 'inconclusive') return null;
  const raw = facts[decision.evidenceFact].evidence.trim();
  if (!raw) return null;
  if (raw.length <= MAX_EVIDENCE) return `"${raw}"`;
  return `"${raw.slice(0, MAX_EVIDENCE).trimEnd()}…"`;
}

/** Line 3: status + rubric link. `Provisional until Code Review` prefix on the
 *  provisional pass; the actionable tail on the inconclusive case; the Rubric link
 *  is rendered as plain `Rubric vN · <url>` (Asana comments carry no markdown). */
function statusLine(decision: Decision, promptVersion: number, provisional: boolean): string {
  const segs: string[] = [];
  if (provisional) segs.push(PROVISIONAL_LINE);
  if (decision.firedRule === 'inconclusive') segs.push(UNCLEAR_TAIL);
  segs.push(`Rubric v${promptVersion}`);
  segs.push(RUBRIC_URL);
  return segs.join(' · ');
}

/** Assemble the (up to) three lines. */
function assemble(line1: string, decision: Decision, facts: Facts, promptVersion: number, provisional: boolean): string {
  const lines: string[] = [line1];
  const ev = evidenceLine(decision, facts);
  if (ev) lines.push(ev);
  lines.push(statusLine(decision, promptVersion, provisional));
  return lines.join('\n');
}

/**
 * Render the compact provisional comment. Prefixed with 🤖 so bot authorship is
 * obvious even though the write uses Danny's PAT. `provisional` marks line 3 as an
 * early guess that will be confirmed from the PR diff at Code Review.
 */
export function renderTierComment(
  decision: Decision,
  facts: Facts,
  promptVersion: number,
  opts: { provisional?: boolean } = {},
): string {
  const line1 = `🤖 ${TIER_HEADLINE[decision.tier]} · ${ruleAndDomain(decision, facts)}`;
  return assemble(line1, decision, facts, promptVersion, !!opts.provisional);
}

/**
 * Render the comment posted by the authoritative Code-Review pass. The PR diff is
 * the authoritative risk source, so this SUPERSEDES a bot-provisional tier in
 * EITHER direction (raise or lower — finalizing the bot's own early guess is not
 * "lowering a decision"). When the diff is unavailable it re-confirms from the now-
 * mature description. `fromTier === toTier` means the provisional guess held; a
 * null `fromTier` means the field was empty and this is the first tier written.
 */
export function renderAuthoritativeComment(args: {
  fromTier: DeliveryTier | null;
  toTier: DeliveryTier;
  source: 'diff' | 'description';
  prNumber?: number;
  decision: Decision;
  facts: Facts;
  promptVersion: number;
}): string {
  const { fromTier, toTier, source, prNumber, decision, facts, promptVersion } = args;
  const sourcePhrase =
    source === 'diff' && prNumber ? `from PR diff (#${prNumber})` : 'at Code Review (no PR linked)';
  let verb: string;
  if (fromTier === null) {
    verb = `${toTier} set`;
  } else if (fromTier === toTier) {
    verb = `${toTier} confirmed`;
  } else {
    verb = `${fromTier} → ${toTier}`;
  }
  const line1 = `🤖 ${verb} ${sourcePhrase} · ${ruleAndDomain(decision, facts)}`;
  return assemble(line1, decision, facts, promptVersion, false);
}
