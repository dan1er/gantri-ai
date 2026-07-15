import { describe, it, expect } from 'vitest';
import {
  renderTierComment,
  renderAuthoritativeComment,
  PROVISIONAL_LINE,
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

describe('renderTierComment', () => {
  it('renders a compact T2 money change: verdict · rule · domain, then the evidence and rubric', () => {
    const f = facts({
      behavior_change: { v: 'yes' },
      money: { v: 'yes', e: 'refunds will now be issued automatically for cancelled orders' },
      domain: 'shopping_checkout',
    });
    const text = renderTierComment(decideTier(f), f, 2);
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('🤖 T2 — QA before production · changes money (Step 3) · Shopping & Checkout');
    expect(lines[1]).toBe('"refunds will now be issued automatically for cancelled orders"');
    expect(lines[2]).toBe(`Rubric v2 · ${RUBRIC_URL}`);
    // The verbose prose is gone.
    expect(text).not.toContain('Why:');
    expect(text).not.toContain('Domain:');
    expect(text).not.toContain('lowering is never');
  });

  it('truncates a long evidence quote to ≤90 chars with a trailing ellipsis', () => {
    const long =
      'recording what was actually paid for shipping and duty separately from the product subtotal so refunds reconcile';
    const f = facts({
      behavior_change: { v: 'yes' },
      money: { v: 'yes', e: long },
      domain: 'order_management',
    });
    const text = renderTierComment(decideTier(f), f, 2);
    const evidence = text.split('\n')[1];
    expect(evidence.startsWith('"recording what was actually paid for shipping and duty')).toBe(true);
    expect(evidence.endsWith('…"')).toBe(true);
    // The quoted body (between the quotes, minus the ellipsis) never exceeds the cap.
    const body = evidence.slice(1, -2);
    expect(body.length).toBeLessThanOrEqual(90);
  });

  it('renders a backend T0 with the Non-UI Lane tag replacing the long sentence', () => {
    const f = facts({ ui_testable: { v: 'no' }, money: { v: 'yes' }, domain: 'shopping_checkout' });
    const text = renderTierComment(decideTier(f), f, 2);
    const lines = text.split('\n');
    expect(lines[0]).toBe(
      '🤖 T0 — engineering validation · no UI flow to gate (Step 1) · Shopping & Checkout · Non-UI Lane (eng gate)',
    );
    // No evidence quote (none supplied) → only verdict + rubric.
    expect(lines).toHaveLength(2);
    expect(text).not.toContain('binding engineering gate');
  });

  it('renders the inconclusive T1 message with the actionable tail and no evidence line', () => {
    const f = facts({ behavior_change: { v: 'unclear' }, domain: 'unknown' });
    const text = renderTierComment(decideTier(f), f, 2);
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('🤖 T1 — production, then QA · unclear → T1 floor (Step 4) · Unknown');
    expect(lines[1]).toBe(`Add detail and the bot re-classifies · Rubric v2 · ${RUBRIC_URL}`);
    expect(text).not.toContain('"');
  });

  it('prefixes line 3 with the provisional marker when asked', () => {
    const f = facts({ behavior_change: { v: 'yes' }, domain: 'product_discovery' });
    const text = renderTierComment(decideTier(f), f, 2, { provisional: true });
    const lines = text.split('\n');
    expect(lines[lines.length - 1]).toBe(`${PROVISIONAL_LINE} · Rubric v2 · ${RUBRIC_URL}`);
    expect(text).toContain(PROVISIONAL_LINE);
  });

  it('floors a calibration mismatch to T1 (logic unchanged) without a note line', () => {
    const f = facts({
      behavior_change: { v: 'no' },
      cosmetic_only: { v: 'yes' },
      domain: 'content_marketing',
      llmTier: 'T2',
    });
    const d = decideTier(f);
    const text = renderTierComment(d, f, 2);
    expect(d.tier).toBe('T1');
    expect(d.calibrationMismatch).toBe(true);
    expect(text.split('\n').length).toBeLessThanOrEqual(3);
    expect(text).not.toContain('disagreed on the tier');
  });
});

describe('renderAuthoritativeComment', () => {
  it('leads with the superseded delta from the PR diff when the tier moves', () => {
    const f = facts({
      behavior_change: { v: 'yes' },
      money: { v: 'yes', e: 'total charged now includes tax' },
      domain: 'shopping_checkout',
    });
    const text = renderAuthoritativeComment({
      fromTier: 'T0',
      toTier: 'T2',
      source: 'diff',
      prNumber: 5180,
      decision: decideTier(f),
      facts: f,
      promptVersion: 2,
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('🤖 T0 → T2 from PR diff (#5180) · changes money (Step 3) · Shopping & Checkout');
    expect(lines[1]).toBe('"total charged now includes tax"');
    expect(lines[2]).toBe(`Rubric v2 · ${RUBRIC_URL}`);
    expect(text).not.toContain('Why:');
  });

  it('reads "confirmed" from the PR diff when the provisional guess held', () => {
    const f = facts({ behavior_change: { v: 'yes' }, domain: 'product_discovery' });
    const text = renderAuthoritativeComment({
      fromTier: 'T1',
      toTier: 'T1',
      source: 'diff',
      prNumber: 42,
      decision: decideTier(f),
      facts: f,
      promptVersion: 2,
    });
    expect(text.split('\n')[0]).toBe(
      '🤖 T1 confirmed from PR diff (#42) · behavior change at domain base (Step 2) · Product Discovery',
    );
  });

  it('says "at Code Review (no PR linked)" when only the description was available', () => {
    const f = facts({ behavior_change: { v: 'no' }, cosmetic_only: { v: 'yes' }, domain: 'content_marketing' });
    const text = renderAuthoritativeComment({
      fromTier: 'T1',
      toTier: 'T0',
      source: 'description',
      decision: decideTier(f),
      facts: f,
      promptVersion: 2,
    });
    expect(text.split('\n')[0]).toBe(
      '🤖 T1 → T0 at Code Review (no PR linked) · cosmetic only (Step 3) · Content & Marketing',
    );
  });

  it('says "set" on the first-ever write (null prior tier)', () => {
    const f = facts({ behavior_change: { v: 'yes' }, money: { v: 'yes', e: 'charge amount changes' }, domain: 'shopping_checkout' });
    const text = renderAuthoritativeComment({
      fromTier: null,
      toTier: 'T2',
      source: 'diff',
      prNumber: 77,
      decision: decideTier(f),
      facts: f,
      promptVersion: 2,
    });
    expect(text.split('\n')[0]).toBe('🤖 T2 set from PR diff (#77) · changes money (Step 3) · Shopping & Checkout');
  });
});
