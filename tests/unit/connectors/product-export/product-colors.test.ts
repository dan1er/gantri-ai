import { describe, it, expect } from 'vitest';
import {
  getColorsByProduct,
  PRODUCT_COLORS,
} from '../../../../src/connectors/product-export/product-colors.js';

// Expected outputs verified against the installed gantri-components build
// (mantle@2.261.2) by executing the real getColorsByProduct — see the connector
// PR. These lock the port to production behavior.

describe('getColorsByProduct (ported palette)', () => {
  const base = { allowTradeColors: true, allowGantriColors: false };

  it('returns [] for a non-painted product', () => {
    expect(getColorsByProduct({ productId: 10018, isPainted: false, productCategory: 'Table Light', ...base })).toEqual([]);
  });

  it('returns the full marketplace-parity palette for a painted Table Light', () => {
    const codes = getColorsByProduct({ productId: 10018, isPainted: true, productCategory: 'Table Light', ...base }).map((c) => c.code);
    expect(codes).toEqual([
      'blossompink', 'canyon', 'carbon', 'cobalt', 'meadow', 'midnight', 'mist', 'mustard',
      'olive', 'peach', 'persimmon', 'poppy', 'sage', 'sand', 'sedona', 'smoke', 'snow',
      'spruce', 'stone', 'sunrise', 'walnut',
    ]);
    // Archived, gantri-exclusive, and wireless-only colors are excluded.
    expect(codes).not.toContain('coral'); // archived
    expect(codes).not.toContain('gantri'); // flag-gated
    expect(codes).not.toContain('lichen'); // wireless-only
  });

  it('adds the wireless-exclusive colors for a wireless category', () => {
    const codes = getColorsByProduct({ productId: 99999, isPainted: true, productCategory: 'Wireless Table Light', ...base }).map((c) => c.code);
    expect(codes).toContain('lichen');
    expect(codes).toContain('lilac');
    expect(codes).toContain('magnolia');
    expect(codes).toContain('manzanita');
    // Non-wireless Table Light did NOT include them (guard above); count is larger.
    expect(codes.length).toBe(25);
  });

  it('gates only-on-products colors (glossysnowwhite) to their product ids', () => {
    // Kobble product 10100 with archived opt-in → glossysnowwhite available.
    const kobble = getColorsByProduct({ productId: 10100, isPainted: true, productCategory: 'Table Light', includeArchived: true, ...base }).map((c) => c.code);
    expect(kobble).toContain('glossysnowwhite');
    // A different product does not get it even with includeArchived.
    const other = getColorsByProduct({ productId: 10018, isPainted: true, productCategory: 'Table Light', includeArchived: true, ...base }).map((c) => c.code);
    expect(other).not.toContain('glossysnowwhite');
  });

  it('includes gantri green only when allowGantriColors is true', () => {
    const withGantri = getColorsByProduct({ productId: 10018, isPainted: true, productCategory: 'Table Light', allowTradeColors: true, allowGantriColors: true }).map((c) => c.code);
    expect(withGantri).toContain('gantri');
  });

  it('defaults allowGantriColors to true when omitted (mirrors upstream)', () => {
    // Omitting the flag → gantri included (upstream default is true).
    const codes = getColorsByProduct({ productId: 10018, isPainted: true, productCategory: 'Table Light', allowTradeColors: true }).map((c) => c.code);
    expect(codes).toContain('gantri');
    expect(codes).toHaveLength(22); // 21 marketplace-parity + gantri
  });

  it('only-on-categories colors are allowed when there is no category context', () => {
    // No productCategory → the wireless-only colors remain valid options
    // (matches upstream "no category → allow" branch).
    const codes = getColorsByProduct({ productId: 99999, isPainted: true, ...base }).map((c) => c.code);
    expect(codes).toContain('lichen');
    expect(codes).toContain('manzanita');
  });

  it('maps codes to storefront display names', () => {
    const colors = getColorsByProduct({ productId: 10018, isPainted: true, productCategory: 'Table Light', ...base });
    const byCode = Object.fromEntries(colors.map((c) => [c.code, c.name]));
    expect(byCode.snow).toBe('Snow');
    expect(byCode.carbon).toBe('Carbon');
    expect(byCode.blossompink).toBe('Blossom');
  });

  it('palette has 33 entries', () => {
    expect(PRODUCT_COLORS).toHaveLength(33);
  });
});
