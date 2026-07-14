import { describe, it, expect } from 'vitest';
import { loadTierStandard, parseTierPromptVersion } from '../../../../../src/connectors/asana/tier/extract.js';
import { DOMAIN_BASE_TIER, type Domain } from '../../../../../src/connectors/asana/tier/decide.js';

/**
 * The public rubric prompt must stay verbatim-equivalent to the Notion "Delivery
 * Tier Classifier" page (Version 2, the domain-base model) plus the clearly-marked
 * bot-only machine appendix (signals contract + diff-mode carve-out). These guards
 * keep the four rubric steps, the domain→base-tier table, and the signals contract
 * in sync so page ↔ code ↔ prompt agree.
 */
describe('delivery-tier rubric prompt', () => {
  const prompt = loadTierStandard();

  it('is Version 2 (matches the Notion page header)', () => {
    expect(parseTierPromptVersion(prompt)).toBe(2);
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

  it('the domain→base-tier table lists every code domain with a matching base tier', () => {
    const table = prompt.slice(prompt.indexOf('| Domain |'), prompt.indexOf('## Step 3'));
    for (const [domain, base] of Object.entries(DOMAIN_BASE_TIER) as [Domain, string][]) {
      // Each domain appears as a table row `| <domain> | ... | <base> |`.
      const row = new RegExp(`\\|\\s*${domain}\\s*\\|[^\\n]*\\|\\s*${base}\\s*\\|`);
      expect(table, `${domain} → ${base}`).toMatch(row);
    }
  });

  it('the Step 2 prose agrees with the base-tier table (money-adjacent are T1)', () => {
    const step2 = prompt.slice(prompt.indexOf('## Step 2'), prompt.indexOf('## Step 3'));
    // Page Version 2: the money-adjacent domains sit at T1 base and reach T2 only via
    // Step 3's money trigger. The prose bullet must say they "sit at T1", and the four
    // rows must be T1 — prose and table must agree so page ↔ code ↔ prompt line up.
    expect(step2).toMatch(/Money-adjacent[^\n]*sit at\s+T1/i);
    for (const domain of ['shopping_checkout', 'orders_notifications', 'order_management', 'payouts_statements']) {
      const row = new RegExp(`\\|\\s*${domain}\\s*\\|[^\\n]*\\|\\s*T1\\s*\\|`);
      expect(step2, `${domain} → T1`).toMatch(row);
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
      'money',
      'irreversible_external',
      'data_integrity',
      'access_security',
      'visual_blast_radius',
    ]) {
      expect(section).toContain(signal);
    }
  });

  it('carves out diff mode inside the machine appendix: the diff is authoritative', () => {
    const section = prompt.slice(prompt.indexOf('--- MACHINE APPENDIX'));
    expect(section).toMatch(/diff is\*?\*? authoritative/i);
    expect(section).toMatch(/verbatim from the \*?\*?diff/i);
  });
});
