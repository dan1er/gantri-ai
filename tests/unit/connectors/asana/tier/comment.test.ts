import { describe, it, expect } from 'vitest';
import {
  renderTierComment,
  renderAuthoritativeComment,
  RUBRIC_URL,
} from '../../../../../src/connectors/asana/tier/comment.js';
import { decideTier, type Facts, type Ternary } from '../../../../../src/connectors/asana/tier/decide.js';
import type { DeliveryTier } from '../../../../../src/connectors/asana/board-config.js';

function facts(
  o: Partial<Record<keyof Omit<Facts, 'domain' | 'llmTier'>, { v: Ternary; e?: string }>> & {
    domain?: Facts['domain'];
    llmTier?: DeliveryTier | null;
  } = {},
): Facts {
  const f = (x?: { v: Ternary; e?: string }) => ({ value: x?.v ?? 'no', evidence: x?.e ?? '' });
  return {
    ui_testable: f(o.ui_testable ?? { v: 'yes' }),
    behavior_change: f(o.behavior_change),
    cosmetic_only: f(o.cosmetic_only),
    restores_approved_behavior: f(o.restores_approved_behavior),
    money: f(o.money),
    irreversible_external: f(o.irreversible_external),
    data_integrity: f(o.data_integrity),
    access_security: f(o.access_security),
    visual_blast_radius: f(o.visual_blast_radius),
    domain: o.domain ?? 'content_marketing',
    llmTier: o.llmTier ?? null,
  };
}

describe('renderTierComment — three lines, one job each', () => {
  it('renders a T2 money trigger: verdict, plain-English why, and the meta line', () => {
    const f = facts({
      behavior_change: { v: 'yes' },
      money: { v: 'yes', e: 'refunds will now be issued automatically for cancelled orders' },
      domain: 'shopping_checkout',
    });
    const { text, html } = renderTierComment(decideTier(f), f, 2);
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Decision: T2 — QA before production');
    expect(lines[1]).toBe(
      'Why: refunds will now be issued automatically for cancelled orders — money movement is a hard T2 trigger.',
    );
    expect(lines[2]).toBe(`Re-checked from the PR diff at Code Review · Rubric v2 · ${RUBRIC_URL}`);
    // No robot emoji, no leftover verbose prose.
    expect(text).not.toContain('🤖');
    expect(text).not.toContain('Domain:');
    // The html body is Asana rich text: bold verdict, hyperlinked rubric, no raw URL
    // outside the href.
    expect(html).toBe(
      '<body>Decision: <strong>T2</strong> — QA before production\n' +
        'Why: refunds will now be issued automatically for cancelled orders — money movement is a hard T2 trigger.\n' +
        `Re-checked from the PR diff at Code Review · <a href="${RUBRIC_URL}">Rubric v2</a></body>`,
    );
  });

  it('appends " (provisional)" to the meaning when the provisional flag is set', () => {
    const f = facts({ behavior_change: { v: 'yes' }, domain: 'product_discovery' });
    const { text, html } = renderTierComment(decideTier(f), f, 4, { provisional: true });
    expect(text.split('\n')[0]).toBe('Decision: T1 — production, then QA (provisional)');
    expect(html).toContain('Decision: <strong>T1</strong> — production, then QA (provisional)');
  });

  it('composes the behavior-at-base sentence from the domain label (ticket source)', () => {
    const f = facts({
      behavior_change: { v: 'yes', e: 'orders now capture per-item sidemarks' },
      domain: 'order_management',
    });
    const { text } = renderTierComment(decideTier(f), f, 4);
    expect(text.split('\n')[1]).toBe(
      'Why: the ticket changes behavior in a core Order Management flow — orders now capture per-item sidemarks.',
    );
  });

  it('says "(domain unclear)" for behavior-at-base when the domain is unknown', () => {
    const f = facts({
      behavior_change: { v: 'yes', e: 'the retry logic now runs on every save' },
      domain: 'unknown',
    });
    const d = decideTier(f);
    expect(d.firedRule).toBe('behavior_at_base');
    expect(renderTierComment(d, f, 4).text.split('\n')[1]).toBe(
      'Why: the ticket changes behavior in a core flow (domain unclear) — the retry logic now runs on every save.',
    );
  });

  it('renders each hard T2 trigger tail', () => {
    const cases: Array<{ key: keyof Facts; e: string; tail: string }> = [
      { key: 'money', e: 'charges the customer a restocking fee', tail: 'money movement is a hard T2 trigger' },
      {
        key: 'irreversible_external',
        e: 'cancels the order and emails the customer',
        tail: 'it is irreversible for a customer, a hard T2 trigger',
      },
      {
        key: 'data_integrity',
        e: 'a bulk update rewrites on-hand stock counts',
        tail: 'data/inventory integrity is a hard T2 trigger',
      },
      {
        key: 'access_security',
        e: 'changes who can open the admin settings',
        tail: 'access/security is a hard T2 trigger',
      },
    ];
    for (const c of cases) {
      const f = facts({ behavior_change: { v: 'yes' }, [c.key]: { v: 'yes', e: c.e }, domain: 'shopping_checkout' } as never);
      const d = decideTier(f);
      expect(d.firedRule).toBe('t2_risk_trigger');
      expect(renderTierComment(d, f, 2).text.split('\n')[1]).toBe(`Why: ${c.e} — ${c.tail}.`);
    }
  });

  it('uses the no-evidence trigger form when the trigger fired without a quote', () => {
    const f = facts({ behavior_change: { v: 'yes' }, money: { v: 'yes' }, domain: 'shopping_checkout' });
    const d = decideTier(f);
    expect(d.firedRule).toBe('t2_risk_trigger');
    expect(renderTierComment(d, f, 2).text.split('\n')[1]).toBe(
      'Why: the ticket hits a hard T2 risk trigger (money).',
    );
  });

  it('renders the cosmetic, behavior-preserving, and restore sentences', () => {
    const cosmetic = facts({
      behavior_change: { v: 'no' },
      cosmetic_only: { v: 'yes', e: 'renames the Save button label' },
      domain: 'content_marketing',
    });
    expect(renderTierComment(decideTier(cosmetic), cosmetic, 2).text.split('\n')[1]).toBe(
      'Why: the change is visual-only with no behavior change — renames the Save button label.',
    );

    const preserving = facts({
      behavior_change: { v: 'no', e: 'reorders the table columns without touching totals' },
      cosmetic_only: { v: 'no' },
      domain: 'order_management',
    });
    expect(renderTierComment(decideTier(preserving), preserving, 2).text.split('\n')[1]).toBe(
      'Why: the change preserves existing behavior — reorders the table columns without touching totals.',
    );

    const restore = facts({
      behavior_change: { v: 'yes' },
      restores_approved_behavior: { v: 'yes', e: 'lets the existing checkout guard run again' },
      domain: 'shopping_checkout',
    });
    expect(renderTierComment(decideTier(restore), restore, 2).text.split('\n')[1]).toBe(
      'Why: it restores previously approved behavior — lets the existing checkout guard run again.',
    );
  });

  it('renders the Non-UI Lane T0 with its own why sentence and a Non-UI Lane meta tag', () => {
    const f = facts({
      ui_testable: { v: 'no', e: 'a backend-only migration of the charge job' },
      money: { v: 'yes' },
      domain: 'shopping_checkout',
    });
    const d = decideTier(f);
    const { text } = renderTierComment(d, f, 2);
    const lines = text.split('\n');
    expect(lines[0]).toBe('Decision: T0 — engineering validation');
    expect(lines[1]).toBe(
      'Why: there is no UI flow to gate, so engineering validates — a backend-only migration of the charge job.',
    );
    expect(lines[2]).toBe(
      `Re-checked from the PR diff at Code Review · Non-UI Lane · Rubric v2 · ${RUBRIC_URL}`,
    );
    expect(text).not.toContain('binding engineering gate');
  });

  it('drops the evidence clause gracefully when there is no quote', () => {
    const f = facts({ behavior_change: { v: 'yes' }, domain: 'order_management' });
    expect(renderTierComment(decideTier(f), f, 2).text.split('\n')[1]).toBe(
      'Why: the ticket changes behavior in a core Order Management flow.',
    );
  });

  it('renders the inconclusive T1 message with the actionable tail and no evidence quote', () => {
    const f = facts({ behavior_change: { v: 'unclear' }, domain: 'unknown' });
    const d = decideTier(f);
    expect(d.firedRule).toBe('inconclusive');
    const { text } = renderTierComment(d, f, 2);
    const lines = text.split('\n');
    expect(lines[0]).toBe('Decision: T1 — production, then QA');
    expect(lines[1]).toBe(
      "Why: the description doesn't give enough detail to assess risk, so the T1 floor applies. Add detail and the bot re-classifies.",
    );
    expect(lines[2]).toBe(`Re-checked from the PR diff at Code Review · Rubric v2 · ${RUBRIC_URL}`);
  });

  it('truncates a long evidence quote on a word boundary with a trailing ellipsis', () => {
    const long =
      'the order confirmation flow now recalculates shipping and tax for every line item before the customer submits payment, and it re-validates the discount codes against the latest promotion rules';
    const f = facts({ behavior_change: { v: 'yes', e: long }, domain: 'order_management' });
    const line2 = renderTierComment(decideTier(f), f, 2).text.split('\n')[1];
    // The full quote is not inlined; a truncated prefix is, ending with an ellipsis
    // then the sentence period.
    expect(line2).not.toContain(long);
    expect(line2.startsWith('Why: the ticket changes behavior in a core Order Management flow — the order confirmation flow')).toBe(true);
    expect(line2.endsWith('….')).toBe(true);
    // The inlined evidence (between " — " and the final ".") never exceeds ~160 chars.
    const evidence = line2.split(' — ')[1].replace(/\.$/, '');
    expect(evidence.length).toBeLessThanOrEqual(161);
    expect(evidence).not.toContain(' —'); // no dangling word cut mid-way
  });

  it('escapes &, <, > in the evidence and the domain label in the html body only', () => {
    const f = facts({
      behavior_change: { v: 'yes', e: 'admin can set price < cost & margin > 0' },
      domain: 'porter_orders_payments', // label carries an ampersand: "Porter — Orders & Payments"
    });
    const { text, html } = renderTierComment(decideTier(f), f, 2);
    // Plain text keeps the raw characters.
    expect(text).toContain('price < cost & margin > 0');
    expect(text).toContain('Porter — Orders & Payments');
    // The html escapes the three significant characters in both dynamic pieces.
    expect(html).toContain('price &lt; cost &amp; margin &gt; 0');
    expect(html).toContain('Porter — Orders &amp; Payments');
    expect(html).not.toContain('price < cost');
    expect(html).not.toContain('Orders & Payments');
  });
});

describe('renderAuthoritativeComment', () => {
  it('renders the exact sidemarks example (first write, T2 from a PR diff)', () => {
    const f = facts({
      behavior_change: {
        v: 'yes',
        e: 'new orders now capture per-item sidemarks and create sidemark records with the transaction',
      },
      domain: 'order_management',
    });
    const d = decideTier(f);
    expect(d.tier).toBe('T2');
    expect(d.firedRule).toBe('behavior_at_base');
    const { text, html } = renderAuthoritativeComment({
      fromTier: null,
      toTier: 'T2',
      source: 'diff',
      prNumber: 2180,
      decision: d,
      facts: f,
      promptVersion: 4,
    });
    expect(text).toBe(
      'Decision: T2 — QA before production\n' +
        'Why: the PR changes behavior in a core Order Management flow — new orders now capture per-item sidemarks and create sidemark records with the transaction.\n' +
        `PR #2180 · Rubric v4 · ${RUBRIC_URL}`,
    );
    expect(html).toBe(
      '<body>Decision: <strong>T2</strong> — QA before production\n' +
        'Why: the PR changes behavior in a core Order Management flow — new orders now capture per-item sidemarks and create sidemark records with the transaction.\n' +
        `PR #2180 · <a href="${RUBRIC_URL}">Rubric v4</a></body>`,
    );
  });

  it('reads "confirmed" when the provisional guess held (fromTier === toTier)', () => {
    const f = facts({ behavior_change: { v: 'yes', e: 'orders capture sidemarks' }, domain: 'order_management' });
    const { text } = renderAuthoritativeComment({
      fromTier: 'T2',
      toTier: 'T2',
      source: 'diff',
      prNumber: 42,
      decision: decideTier(f),
      facts: f,
      promptVersion: 2,
    });
    expect(text.split('\n')[0]).toBe('Decision: T2 confirmed — QA before production');
    expect(text.split('\n')[2]).toBe(`PR #42 · Rubric v2 · ${RUBRIC_URL}`);
  });

  it('leads with the delta when the tier moves (fromTier !== toTier)', () => {
    const f = facts({
      behavior_change: { v: 'yes' },
      money: { v: 'yes', e: 'total charged now includes tax' },
      domain: 'shopping_checkout',
    });
    const { text, html } = renderAuthoritativeComment({
      fromTier: 'T0',
      toTier: 'T2',
      source: 'diff',
      prNumber: 5180,
      decision: decideTier(f),
      facts: f,
      promptVersion: 2,
    });
    expect(text.split('\n')[0]).toBe('Decision: T0 → T2 — QA before production');
    expect(html).toContain('Decision: <strong>T0 → T2</strong> — QA before production');
  });

  it('says "Code Review (no PR linked)" when only the description was available', () => {
    const f = facts({ behavior_change: { v: 'no' }, cosmetic_only: { v: 'yes', e: 'fixes the label' }, domain: 'content_marketing' });
    const { text } = renderAuthoritativeComment({
      fromTier: 'T1',
      toTier: 'T0',
      source: 'description',
      decision: decideTier(f),
      facts: f,
      promptVersion: 2,
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Decision: T1 → T0 — engineering validation');
    expect(lines[1]).toBe('Why: the change is visual-only with no behavior change — fixes the label.');
    expect(lines[2]).toBe(`Code Review (no PR linked) · Rubric v2 · ${RUBRIC_URL}`);
    // Description source → the why sentence reads "ticket", not "PR".
    expect(text).not.toContain('the PR ');
  });

  it('hyperlinks the PR number in the html when a prUrl is given; the plain text stays bare', () => {
    const f = facts({
      behavior_change: { v: 'yes', e: 'orders capture sidemarks' },
      domain: 'order_management',
    });
    const url = 'https://github.com/gantri/core/pull/2180';
    const { text, html } = renderAuthoritativeComment({
      fromTier: null,
      toTier: 'T2',
      source: 'diff',
      prNumber: 2180,
      prUrl: url,
      decision: decideTier(f),
      facts: f,
      promptVersion: 4,
    });
    // Plain text is unchanged: the source segment is the bare `PR #2180`.
    expect(text.split('\n')[2]).toBe(`PR #2180 · Rubric v4 · ${RUBRIC_URL}`);
    // The html links `PR #2180` to the PR URL, before the (still hyperlinked) rubric.
    // Line 3 is the last html line, so it carries the closing `</body>`.
    expect(html.split('\n')[2]).toBe(
      `<a href="${url}">PR #2180</a> · <a href="${RUBRIC_URL}">Rubric v4</a></body>`,
    );
  });

  it('leaves the PR segment un-linked when no prUrl is supplied (unchanged behavior)', () => {
    const f = facts({
      behavior_change: { v: 'yes', e: 'orders capture sidemarks' },
      domain: 'order_management',
    });
    const { text, html } = renderAuthoritativeComment({
      fromTier: null,
      toTier: 'T2',
      source: 'diff',
      prNumber: 2180,
      decision: decideTier(f),
      facts: f,
      promptVersion: 4,
    });
    expect(text.split('\n')[2]).toBe(`PR #2180 · Rubric v4 · ${RUBRIC_URL}`);
    expect(html.split('\n')[2]).toBe(`PR #2180 · <a href="${RUBRIC_URL}">Rubric v4</a></body>`);
    expect(html).not.toContain('<a href="https://github.com');
  });

  it('escapes the prUrl for the href attribute (& and the closing double-quote)', () => {
    const f = facts({ behavior_change: { v: 'yes' }, domain: 'order_management' });
    const { html } = renderAuthoritativeComment({
      fromTier: null,
      toTier: 'T2',
      source: 'diff',
      prNumber: 7,
      prUrl: 'https://github.com/o/r/pull/7?a=1&b=2"',
      decision: decideTier(f),
      facts: f,
      promptVersion: 4,
    });
    expect(html).toContain('href="https://github.com/o/r/pull/7?a=1&amp;b=2&quot;"');
    expect(html).not.toContain('a=1&b=2"');
  });

  it('ignores prUrl when the source is the description (no PR segment to link)', () => {
    const f = facts({
      behavior_change: { v: 'no' },
      cosmetic_only: { v: 'yes', e: 'fixes the label' },
      domain: 'content_marketing',
    });
    const { text, html } = renderAuthoritativeComment({
      fromTier: 'T1',
      toTier: 'T0',
      source: 'description',
      prUrl: 'https://github.com/gantri/core/pull/2180',
      decision: decideTier(f),
      facts: f,
      promptVersion: 2,
    });
    expect(text.split('\n')[2]).toBe(`Code Review (no PR linked) · Rubric v2 · ${RUBRIC_URL}`);
    expect(html).not.toContain('pull/2180');
  });
});
