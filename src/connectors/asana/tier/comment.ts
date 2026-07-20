import type { DeliveryTier } from '../board-config.js';
import type { Decision, Domain, FactKey, Facts } from './decide.js';

/**
 * Pure template renderer for the Asana delivery-tier comment. No LLM — the comment
 * is a deterministic function of the decision + facts, so it is cheap and the wording
 * is auditable. English, to match the board.
 *
 * Every comment is exactly THREE lines, one job each, and is rendered as Asana rich
 * text so the verdict is bold and the rubric reference is a compact hyperlink (no raw
 * URL):
 *   Line 1 — verdict:  `Decision: <strong>{verdict}</strong> — {meaning}` — the tier
 *            (or the delta / "confirmed") plus what it means for shipping. The
 *            provisional pass appends ` (provisional)`.
 *   Line 2 — reason:   `Why: {one plain-English sentence}` composed deterministically
 *            from the fired rule + domain + the evidence quote (lower-cased, trimmed,
 *            truncated on a word boundary; its clause is dropped when there is none).
 *   Line 3 — meta:     the source (a PR number, the no-PR note, or the provisional
 *            re-check note), an optional `Non-UI Lane` tag, and the Rubric link,
 *            joined by ` · `.
 *
 * Each renderer returns BOTH forms (`RenderedComment`): `html` is the `<body>…</body>`
 * rich-text body Asana stores as `html_text` (with `<strong>` on the verdict, an
 * `<a href>` on the rubric link, and — when a PR URL is supplied — an `<a href>` on the
 * `PR #<n>` source segment, with `&`/`<`/`>` escaped in any interpolated dynamic
 * content); `text` is the same content as plain text, the rubric rendered as
 * `Rubric vN · <url>` — a resilience fallback used when the rich-text write is
 * rejected. The longer prose (dispute policy, per-trigger enumerations, the Non-UI
 * Lane paragraph) lives on the rubric page, not on every ticket.
 */

/** Public rubric link cited in every comment (the Delivery Tier rubric in Notion). */
export const RUBRIC_URL = 'https://www.notion.so/39ddb572aef48169897efefd543290b9';

/** Longest evidence clause we inline before truncating on a word boundary. */
const MAX_EVIDENCE = 160;

/** Both forms of one rendered comment: `html` is the Asana rich-text body
 *  (`<body>…</body>`), `text` is the plain-text fallback with the same content. */
export interface RenderedComment {
  text: string;
  html: string;
}

/** What each tier means for shipping — the meaning shown after the verdict. */
const TIER_MEANING: Record<DeliveryTier, string> = {
  T0: 'engineering validation',
  T1: 'production, then QA',
  T2: 'QA before production',
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

/** The hard-trigger tail phrase per T2 risk signal (line 2, evidence-present form). */
const TRIGGER_TAIL: Partial<Record<FactKey, string>> = {
  money: 'money movement is a hard T2 trigger',
  irreversible_external: 'it is irreversible for a customer, a hard T2 trigger',
  data_integrity: 'data/inventory integrity is a hard T2 trigger',
  access_security: 'access/security is a hard T2 trigger',
};

/** The trigger noun per T2 risk signal (line 2, no-evidence form). */
const TRIGGER_NOUN: Partial<Record<FactKey, string>> = {
  money: 'money',
  irreversible_external: 'irreversibility',
  data_integrity: 'data integrity',
  access_security: 'access/security',
};

/** One line in both forms: plain `text` and rich `html`. */
interface Line {
  text: string;
  html: string;
}

/** Escape the three XML/HTML-significant characters in interpolated dynamic content
 *  (evidence, domain labels — a label like "Porter — Orders & Payments" carries an
 *  `&`). Ampersand first so an already-escaped `<`/`>` is not double-escaped. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape a URL for a double-quoted `href` attribute: the three markup characters
 *  plus the double-quote that would otherwise close the attribute. Ampersand first so
 *  an already-escaped entity is not double-escaped. */
function escAttr(url: string): string {
  return esc(url).replace(/"/g, '&quot;');
}

/** A line whose text and html forms are identical (no dynamic content to escape). */
function plain(s: string): Line {
  return { text: s, html: s };
}

/** Truncate to at most `max` chars, cutting on the last word boundary and adding a
 *  trailing ellipsis. Short strings pass through unchanged. */
function truncateOnWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/** The evidence clause for line 2: the fired signal's quote, lower-cased at the first
 *  letter, a trailing period stripped, truncated on a word boundary. Empty string when
 *  the decision cites no evidence (or on the inconclusive case) so the caller can drop
 *  the clause gracefully. */
function evidenceClause(decision: Decision, facts: Facts): string {
  if (!decision.evidenceFact || decision.firedRule === 'inconclusive') return '';
  const raw = facts[decision.evidenceFact].evidence.trim();
  if (!raw) return '';
  const lowered = raw.charAt(0).toLowerCase() + raw.slice(1);
  const noPeriod = lowered.replace(/\.$/, '');
  return truncateOnWord(noPeriod, MAX_EVIDENCE);
}

/** The `— {evidence}.` tail shared by most Why sentences, dropped to a bare `.` when
 *  there is no evidence to cite. */
function tail(ev: string): Line {
  if (!ev) return { text: '.', html: '.' };
  return { text: ` — ${ev}.`, html: ` — ${esc(ev)}.` };
}

/**
 * Line 2 — the plain-English "Why" sentence for the fired rule. `src` is `PR` when the
 * facts came from a diff, else `ticket`. Only the evidence quote and the domain label
 * are dynamic, so those are the only pieces that differ between the text and html forms.
 */
function composeWhy(decision: Decision, facts: Facts, fromDiff: boolean): Line {
  const src = fromDiff ? 'PR' : 'ticket';
  const ev = evidenceClause(decision, facts);

  switch (decision.firedRule) {
    case 'behavior_at_base': {
      const label = facts.domain === 'unknown' ? null : DOMAIN_LABEL[facts.domain];
      const coreText = label
        ? `changes behavior in a core ${label} flow`
        : 'changes behavior in a core flow (domain unclear)';
      const coreHtml = label
        ? `changes behavior in a core ${esc(label)} flow`
        : 'changes behavior in a core flow (domain unclear)';
      const t = tail(ev);
      return { text: `Why: the ${src} ${coreText}${t.text}`, html: `Why: the ${src} ${coreHtml}${t.html}` };
    }
    case 't2_risk_trigger': {
      const key = decision.evidenceFact;
      const tailPhrase = key ? TRIGGER_TAIL[key] : undefined;
      if (ev && tailPhrase) {
        return { text: `Why: ${ev} — ${tailPhrase}.`, html: `Why: ${esc(ev)} — ${tailPhrase}.` };
      }
      const noun = (key ? TRIGGER_NOUN[key] : undefined) ?? 'money';
      const s = `Why: the ${src} hits a hard T2 risk trigger (${noun}).`;
      return { text: s, html: s };
    }
    case 'cosmetic': {
      const t = tail(ev);
      return {
        text: `Why: the change is visual-only with no behavior change${t.text}`,
        html: `Why: the change is visual-only with no behavior change${t.html}`,
      };
    }
    case 'behavior_preserving': {
      const t = tail(ev);
      return {
        text: `Why: the change preserves existing behavior${t.text}`,
        html: `Why: the change preserves existing behavior${t.html}`,
      };
    }
    case 'restore_approved': {
      const t = tail(ev);
      return {
        text: `Why: it restores previously approved behavior${t.text}`,
        html: `Why: it restores previously approved behavior${t.html}`,
      };
    }
    case 'not_ui_testable': {
      const t = tail(ev);
      return {
        text: `Why: there is no UI flow to gate, so engineering validates${t.text}`,
        html: `Why: there is no UI flow to gate, so engineering validates${t.html}`,
      };
    }
    case 'inconclusive': {
      const s =
        "Why: the description doesn't give enough detail to assess risk, so the T1 floor applies. Add detail and the bot re-classifies.";
      return { text: s, html: s };
    }
  }
  // Exhaustiveness: every FiredRule is handled above.
  const never: never = decision.firedRule;
  throw new Error(`unhandled fired rule: ${String(never)}`);
}

/** Line 1 — the verdict and its meaning. The provisional pass appends ` (provisional)`. */
function verdictLine(verdict: string, meaning: string, provisional: boolean): Line {
  const suffix = provisional ? ' (provisional)' : '';
  return {
    text: `Decision: ${verdict} — ${meaning}${suffix}`,
    html: `Decision: <strong>${esc(verdict)}</strong> — ${meaning}${suffix}`,
  };
}

/** Line 3 — the source segment, an optional Non-UI Lane tag, and the Rubric link. The
 *  source carries its own text/html forms (the html form may hyperlink the `PR #<n>`
 *  segment); the rubric link is a compact hyperlink in html and `Rubric vN · <url>` in
 *  plain text. */
function metaLine(source: Line, nonUiLane: boolean, version: number): Line {
  const segsText: string[] = [source.text];
  const segsHtml: string[] = [source.html];
  if (nonUiLane) {
    segsText.push('Non-UI Lane');
    segsHtml.push('Non-UI Lane');
  }
  segsText.push(`Rubric v${version} · ${RUBRIC_URL}`);
  segsHtml.push(`<a href="${RUBRIC_URL}">Rubric v${version}</a>`);
  return { text: segsText.join(' · '), html: segsHtml.join(' · ') };
}

/** Join the three lines into the plain-text body and the `<body>…</body>` html body. */
function assemble(line1: Line, line2: Line, line3: Line): RenderedComment {
  return {
    text: [line1.text, line2.text, line3.text].join('\n'),
    html: `<body>${[line1.html, line2.html, line3.html].join('\n')}</body>`,
  };
}

/**
 * Render the provisional comment posted by the poller before Code Review. The verdict
 * is the tier alone; `provisional` appends ` (provisional)` to the meaning and the meta
 * line notes that the PR diff re-checks it at Code Review.
 */
export function renderTierComment(
  decision: Decision,
  facts: Facts,
  promptVersion: number,
  opts: { provisional?: boolean } = {},
): RenderedComment {
  const provisional = !!opts.provisional;
  const line1 = verdictLine(decision.tier, TIER_MEANING[decision.tier], provisional);
  const line2 = composeWhy(decision, facts, false);
  const line3 = metaLine(
    plain('Re-checked from the PR diff at Code Review'),
    decision.flags.includes('non_ui_lane'),
    promptVersion,
  );
  return assemble(line1, line2, line3);
}

/**
 * Render the comment posted by the authoritative Code-Review pass. The PR diff is the
 * authoritative risk source, so this SUPERSEDES a bot-provisional tier in EITHER
 * direction (raise or lower — finalizing the bot's own early guess is not "lowering a
 * decision"). When the diff is unavailable it re-confirms from the now-mature
 * description. The verdict reads `T2` on a first-ever write (null `fromTier`),
 * `T2 confirmed` when the guess held (`fromTier === toTier`), or `T1 → T2` on a move.
 *
 * When the source is a diff with a PR number AND `prUrl` is supplied, the html form of
 * the source segment hyperlinks `PR #<n>` to the PR (the plain-text form stays the bare
 * `PR #<n>`). Omitting `prUrl` keeps the previous behavior (an un-linked segment).
 */
export function renderAuthoritativeComment(args: {
  fromTier: DeliveryTier | null;
  toTier: DeliveryTier;
  source: 'diff' | 'description';
  prNumber?: number;
  prUrl?: string;
  decision: Decision;
  facts: Facts;
  promptVersion: number;
}): RenderedComment {
  const { fromTier, toTier, source, prNumber, prUrl, decision, facts, promptVersion } = args;

  let verdict: string;
  if (fromTier === null) verdict = toTier;
  else if (fromTier === toTier) verdict = `${toTier} confirmed`;
  else verdict = `${fromTier} → ${toTier}`;

  const hasPr = source === 'diff' && !!prNumber;
  const sourceSeg: Line = hasPr
    ? {
        text: `PR #${prNumber}`,
        html: prUrl ? `<a href="${escAttr(prUrl)}">PR #${prNumber}</a>` : `PR #${prNumber}`,
      }
    : plain('Code Review (no PR linked)');
  const line1 = verdictLine(verdict, TIER_MEANING[toTier], false);
  const line2 = composeWhy(decision, facts, source === 'diff');
  const line3 = metaLine(sourceSeg, decision.flags.includes('non_ui_lane'), promptVersion);
  return assemble(line1, line2, line3);
}
