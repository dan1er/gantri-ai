import { describe, it, expect } from 'vitest';
import { loadTierStandard, parseTierPromptVersion } from '../../../../../src/connectors/asana/tier/extract.js';
import { DOMAIN_BASE_TIER, type Domain } from '../../../../../src/connectors/asana/tier/decide.js';

/**
 * The public rubric prompt must stay verbatim-equivalent to the Notion "Delivery
 * Tier Classifier" page (Version 4, the domain-base model) plus the clearly-marked
 * bot-only machine appendix (signals contract + diff-mode carve-out). These guards
 * keep the four rubric steps, the domain→base-tier table, and the signals contract
 * in sync so page ↔ code ↔ prompt agree.
 */
describe('delivery-tier rubric prompt', () => {
  const prompt = loadTierStandard();

  it('is Version 4 (matches the Notion page header)', () => {
    expect(parseTierPromptVersion(prompt)).toBe(4);
  });

  it('Step 3 carries the restore-vs-rework carve-out', () => {
    const section = prompt.slice(prompt.indexOf('## Step 3'), prompt.indexOf('## Step 4'));
    expect(section).toMatch(/restores already-shipped, already-approved behavior/i);
    expect(section).toMatch(/decides a new amount, or creates a new way for money, inventory, or order state to move/i);
  });

  it('carries the four domain-base steps in order', () => {
    const s1 = prompt.indexOf('## Step 1 — Can QA test it through the UI?');
    const s2 = prompt.indexOf('## Step 2 — Functional domain → base tier');
    const s3 = prompt.indexOf('## Step 3 — Risk check');
    const s4 = prompt.indexOf('## Step 4 — Uncertainty floor');
    expect(s1).toBeGreaterThanOrEqual(0);
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
    expect(s4).toBeGreaterThan(s3);
  });

  it('Step 3 keeps the four hard-trigger cases (money, irreversible, integrity, access)', () => {
    const section = prompt.slice(prompt.indexOf('## Step 3'), prompt.indexOf('## Step 4'));
    expect(section).toMatch(/\*\*money\*\*/i);
    expect(section).toMatch(/irreversible for a real customer/i);
    expect(section).toMatch(/data \/ inventory integrity/i);
    expect(section).toMatch(/access \/ security/i);
  });

  it('Step 3 states the Version 4 forward-looking money boundary (will-pay vs already-paid bookkeeping)', () => {
    // Version 4 (Danny's calibration): the money trigger fires on an amount someone
    // WILL pay or be charged from now on — a calculation or path — while recording /
    // importing / displaying amounts ALREADY paid or incurred (costs, landed costs,
    // historical charges) is bookkeeping and does NOT fire. This is what stops the
    // "record inbound shipping and tariff costs" ticket from mis-firing T2.
    const section = prompt.slice(prompt.indexOf('## Step 3'), prompt.indexOf('## Step 4'));
    expect(section).toMatch(/will\s+pay or be charged from now on/i);
    expect(section).toMatch(/calculation or path/i);
    expect(section).toMatch(/already paid or incurred/i);
    expect(section).toMatch(/landed costs/i);
    expect(section).toMatch(/is bookkeeping — it does \*\*not\*\* fire/i);
  });

  it('the domain→base-tier table lists every code domain with a matching base tier', () => {
    const table = prompt.slice(prompt.indexOf('| Domain |'), prompt.indexOf('## Step 3'));
    for (const [domain, base] of Object.entries(DOMAIN_BASE_TIER) as [Domain, string][]) {
      // Each domain appears as a table row `| <domain> | ... | <base> |`.
      const row = new RegExp(`\\|\\s*${domain}\\s*\\|[^\\n]*\\|\\s*${base}\\s*\\|`);
      expect(table, `${domain} → ${base}`).toMatch(row);
    }
  });

  it('the Step 2 prose agrees with the base-tier table (payouts/quotes/statements are T1)', () => {
    const step2 = prompt.slice(prompt.indexOf('## Step 2'), prompt.indexOf('## Step 3'));
    // Page Version 2 (hand-calibrated): only payouts / quotes / statements sit at T1
    // among the money surfaces; they reach T2 only via Step 3's money trigger. The
    // customer money/order surfaces (checkout, order management, orders / notifications)
    // sit at T2 base. Prose and table must agree so page ↔ code ↔ prompt line up.
    expect(step2).toMatch(/Payouts \/ quotes \/ statements[^\n]*sit at\s+T1/i);
    const t1Row = new RegExp(`\\|\\s*payouts_statements\\s*\\|[^\\n]*\\|\\s*T1\\s*\\|`);
    expect(step2, 'payouts_statements → T1').toMatch(t1Row);
    for (const domain of ['shopping_checkout', 'order_management', 'orders_notifications']) {
      const row = new RegExp(`\\|\\s*${domain}\\s*\\|[^\\n]*\\|\\s*T2\\s*\\|`);
      expect(step2, `${domain} → T2`).toMatch(row);
    }
  });

  it('marks the machine appendix as not-on-the-Notion-page and requires the signals object', () => {
    const idx = prompt.indexOf('--- MACHINE APPENDIX (not on the Notion page) ---');
    expect(idx).toBeGreaterThan(0);
    const section = prompt.slice(idx);
    for (const signal of [
      'ui_testable',
      'behavior_change',
      'cosmetic_only',
      'restores_approved_behavior',
      'money',
      'irreversible_external',
      'data_integrity',
      'access_security',
      'visual_blast_radius',
    ]) {
      expect(section).toContain(signal);
    }
  });

  it('the appendix money signal uses the same forward-looking test (bookkeeping does not fire)', () => {
    // The machine `money` signal must mirror Step 3's Version 4 boundary so the
    // deterministic recompute agrees with the prose: will-pay-from-now-on = yes;
    // recording already-paid / incurred costs (landed costs, purchase-cost capture) = no.
    const section = prompt.slice(prompt.indexOf('--- MACHINE APPENDIX'));
    const moneyLine = section.slice(section.indexOf('- `money`'), section.indexOf('- `irreversible_external`'));
    expect(moneyLine).toMatch(/forward-looking/i);
    expect(moneyLine).toMatch(/will\*?\*? pay or be charged from now on/i);
    expect(moneyLine).toMatch(/already paid or incurred/i);
    expect(moneyLine).toMatch(/landed costs/i);
    expect(moneyLine).toMatch(/purchase-cost capture/i);
  });

  it('carves out diff mode inside the machine appendix: the diff is authoritative', () => {
    const section = prompt.slice(prompt.indexOf('--- MACHINE APPENDIX'));
    expect(section).toMatch(/diff is\*?\*? authoritative/i);
    expect(section).toMatch(/verbatim from the \*?\*?diff/i);
  });

  it('defines ui_testable by drivability (DRIVE+VERIFY+COVER), not file location', () => {
    // Danny's cancel-order correction: a 100%-backend fix is ui_testable when a
    // tester can DRIVE an existing screen to exercise the change, VERIFY the outcome
    // in the UI, and the failure would be COVERed there. The appendix states the
    // drivability boundary as the three-question determination and drops the
    // backend-only blanket.
    const section = prompt.slice(prompt.indexOf('--- MACHINE APPENDIX'));
    expect(section).toMatch(/drivability,? not file location/i);
    expect(section).toMatch(/would a manual UI pass be the thing that catches this change'?s failure/i);
    expect(section).toMatch(/\*\*DRIVE\*\*/);
    expect(section).toMatch(/\*\*VERIFY\*\*/);
    expect(section).toMatch(/\*\*COVER\*\*/);
    expect(section).toMatch(/100% backend/i);
    expect(section).not.toMatch(/a backend-only change offers nothing to click/i);
    // Always-no cases survive the rewrite.
    expect(section).toMatch(/data migrations and one-off backfills are \*\*always\*\* `no`/i);
    expect(section).toMatch(/webhook \/ sync \/ race internals/i);
  });
});
