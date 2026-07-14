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
});
