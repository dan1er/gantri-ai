import { describe, it, expect } from 'vitest';
import { loadTierStandard, parseTierPromptVersion } from '../../../../../src/connectors/asana/tier/extract.js';

/**
 * The public rubric prompt must stay aligned with the design spec's fact
 * boundaries. This guards the `money_visible` boundary specifically: the spec
 * fires it for ANY customer-visible price / total / tax / shipping / discount
 * change, not only numbers on the cart / checkout / payment surface. A narrower
 * prompt boundary would silently drop those tickets to T0/T1.
 */
describe('delivery-tier rubric prompt', () => {
  const prompt = loadTierStandard();

  it('has a parseable version header', () => {
    expect(parseTierPromptVersion(prompt)).toBeGreaterThanOrEqual(1);
  });

  it('money_visible fires on customer-visible price changes regardless of surface', () => {
    const section = prompt.slice(
      prompt.indexOf('### `money_visible`'),
      prompt.indexOf('### `visual_blast_radius`'),
    );
    expect(section).toContain('regardless of which surface');
    // The spec's explicit off-cart examples must be present so the model does not
    // scope the fact to cart/checkout/payment only.
    expect(section).toMatch(/product-page price/i);
    expect(section).toMatch(/order-history amount/i);
  });

  it('carves out diff mode: the diff is authoritative and evidence may come from it', async () => {
    // The v2 PR re-check sends this same file as the system prompt while asking the
    // model to judge from the diff. Without a carve-out, the "ticket text ONLY" /
    // "evidence copied from the ticket" ground rules would fight the diff instruction.
    const diffSection = prompt.slice(prompt.indexOf('### Diff mode'), prompt.indexOf('## The facts'));
    expect(diffSection).toMatch(/diff is\*?\*? authoritative/i);
    expect(diffSection).toMatch(/verbatim from the \*?\*?diff/i);
  });
});
