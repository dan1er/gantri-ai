import { describe, it, expect } from 'vitest';
import { loadTierStandard, parseTierPromptVersion } from '../../../../../src/connectors/asana/tier/extract.js';

/**
 * The public rubric prompt must stay verbatim-equivalent to the Notion "Delivery
 * Tier Classifier" page (the change-based model) plus the two bot-only additive
 * sections (diff mode + the machine-appendix signals). These guards keep the four
 * rubric steps and the signals contract intact so page ↔ code ↔ prompt agree.
 */
describe('delivery-tier rubric prompt', () => {
  const prompt = loadTierStandard();

  it('has a parseable version header', () => {
    expect(parseTierPromptVersion(prompt)).toBeGreaterThanOrEqual(1);
  });

  it('carries the four change-based steps in order', () => {
    const s1 = prompt.indexOf('## Step 1 — No UI surface → T0');
    const s2 = prompt.indexOf('## Step 2 — Doesn');
    const s3 = prompt.indexOf('## Step 3 — T2 test');
    const s4 = prompt.indexOf('## Step 4 — Everything else → T1');
    expect(s1).toBeGreaterThanOrEqual(0);
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
    expect(s4).toBeGreaterThan(s3);
  });

  it('Step 3 keeps the four T2 triggers (money, irreversible, integrity, access)', () => {
    const section = prompt.slice(prompt.indexOf('## Step 3'), prompt.indexOf('## Step 4'));
    expect(section).toMatch(/\*\*Money\*\*/);
    expect(section).toMatch(/Irreversible for a real customer/i);
    expect(section).toMatch(/Data or inventory integrity/i);
    expect(section).toMatch(/Access or security/i);
  });

  it('requires the machine-appendix signals object the code recomputes from', () => {
    const section = prompt.slice(prompt.indexOf('## Machine appendix'));
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

  it('carves out diff mode: the diff is authoritative and evidence may come from it', () => {
    // The v2 PR re-check sends this same file as the system prompt while asking the
    // model to judge from the diff. Without a carve-out, the ticket-text ground rules
    // would fight the diff instruction.
    const diffSection = prompt.slice(prompt.indexOf('## Diff mode'), prompt.indexOf('## Output'));
    expect(diffSection).toMatch(/diff is\*?\*? authoritative/i);
    expect(diffSection).toMatch(/verbatim from the \*?\*?diff/i);
  });
});
