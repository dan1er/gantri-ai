/**
 * Product color palette + availability rules — PORTED FROM `gantri-components`,
 * KEEP IN SYNC.
 *
 * Source (verified identical in the installed builds mantle@2.261.2 /
 * porter@2.254.2):
 *   - gantri-components/src/styles/theme.tsx → `productColorsDefinition`
 *   - .../helpers/generate-skus-functions/get-colors-by-product/get-colors-by-product.ts
 *   - .../helpers/get-is-color-available-for-product-id/get-is-color-available-for-product-id.ts
 *
 * Why mirrored (not imported): `gantri-components` is a React UI package; the bot
 * is a lean backend that builds the CSV from Grafana SQL and can't pull it in.
 * When a color is added/archived or an availability rule changes upstream, mirror
 * the change here.
 *
 * `Products.colors` (the Porter column) is ONLY the designer/creator-selected
 * subset. The full set of colors a product can actually be ordered in is derived
 * from this palette via `getColorsByProduct`, exactly like the mantle PDP "All
 * colors" tab and Porter's cut-sheet PDF.
 */

type ProductColorStatus = 'active' | 'archived';

type ColorAvailabilityRule =
  | { type: 'flag-gated'; flag: 'allowGantriColors' }
  | { type: 'only-on-products'; productIds: number[] }
  | { type: 'trade-only-on-products'; productIds: number[] }
  | { type: 'only-on-categories'; categories: string[]; productIds?: number[] };

interface ProductColorEntry {
  code: string;
  /** Display name used on the storefront swatch (e.g. "Snow", "Carbon"). */
  shortColorName: string;
  status: ProductColorStatus;
  availability?: ColorAvailabilityRule;
}

// The four wireless categories that unlock the wireless-exclusive colors.
const WIRELESS_COLOR_CATEGORIES = [
  'Wireless Floor Lantern',
  'Wireless Mini Light',
  'Wireless Table Light',
  'Wireless Task Light',
];

/**
 * The full Gantri product-color palette. INSERTION ORDER MATTERS —
 * `getColorsByProduct` returns colors in this order (mirrors
 * `Object.values(productColorsMap)`).
 */
export const PRODUCT_COLORS: ProductColorEntry[] = [
  { code: 'blossompink', shortColorName: 'Blossom', status: 'active' },
  { code: 'canyon', shortColorName: 'Canyon', status: 'active' },
  { code: 'carbon', shortColorName: 'Carbon', status: 'active' },
  { code: 'cobalt', shortColorName: 'Cobalt', status: 'active' },
  { code: 'coral', shortColorName: 'Coral', status: 'archived' },
  { code: 'fog', shortColorName: 'Fog', status: 'archived' },
  { code: 'forest', shortColorName: 'Forest', status: 'archived' },
  { code: 'gantri', shortColorName: 'Gantri Green', status: 'active', availability: { type: 'flag-gated', flag: 'allowGantriColors' } },
  { code: 'glossysnowwhite', shortColorName: 'Glossy Snow', status: 'archived', availability: { type: 'only-on-products', productIds: [10100, 10101, 10105, 10106] } },
  { code: 'hibiscus', shortColorName: 'Hibiscus', status: 'archived' },
  { code: 'lichen', shortColorName: 'Lichen', status: 'active', availability: { type: 'only-on-categories', categories: WIRELESS_COLOR_CATEGORIES, productIds: [10283] } },
  { code: 'lilac', shortColorName: 'Lilac', status: 'active', availability: { type: 'only-on-categories', categories: WIRELESS_COLOR_CATEGORIES, productIds: [10283] } },
  { code: 'magnolia', shortColorName: 'Magnolia', status: 'active', availability: { type: 'only-on-categories', categories: WIRELESS_COLOR_CATEGORIES, productIds: [10283] } },
  { code: 'manzanita', shortColorName: 'Manzanita', status: 'active', availability: { type: 'only-on-categories', categories: WIRELESS_COLOR_CATEGORIES, productIds: [10283] } },
  { code: 'meadow', shortColorName: 'Meadow', status: 'active' },
  { code: 'midnight', shortColorName: 'Midnight', status: 'active' },
  { code: 'mist', shortColorName: 'Mist', status: 'active' },
  { code: 'mustard', shortColorName: 'Mustard', status: 'active' },
  { code: 'olive', shortColorName: 'Olive', status: 'active' },
  { code: 'peach', shortColorName: 'Peach', status: 'active' },
  { code: 'persimmon', shortColorName: 'Persimmon', status: 'active' },
  { code: 'poppy', shortColorName: 'Poppy', status: 'active' },
  { code: 'sage', shortColorName: 'Sage', status: 'active' },
  { code: 'sand', shortColorName: 'Sand', status: 'active' },
  { code: 'sedona', shortColorName: 'Sedona', status: 'active' },
  { code: 'sky', shortColorName: 'Sky', status: 'archived' },
  { code: 'smoke', shortColorName: 'Smoke', status: 'active' },
  { code: 'snow', shortColorName: 'Snow', status: 'active' },
  { code: 'sproutgreen', shortColorName: 'Sprout', status: 'archived' },
  { code: 'spruce', shortColorName: 'Spruce', status: 'active' },
  { code: 'stone', shortColorName: 'Stone', status: 'active' },
  { code: 'sunrise', shortColorName: 'Sunrise', status: 'active' },
  { code: 'walnut', shortColorName: 'Walnut', status: 'active' },
];

export interface AvailableColor {
  code: string;
  /** Display name (shortColorName). */
  name: string;
}

export interface GetColorsByProductProps {
  productId: number;
  isPainted: boolean;
  productCategory?: string | null;
  /** Include trade-only colors on their exclusive products. */
  allowTradeColors?: boolean;
  /** Include the Gantri-brand-exclusive color. */
  allowGantriColors?: boolean;
  /** Include archived colors (fulfillment/admin only). */
  includeArchived?: boolean;
}

/** Mirrors `getIsColorAvailableForProductId` — status + availability-rule gate. */
function isColorAvailableForProduct(entry: ProductColorEntry, props: GetColorsByProductProps): boolean {
  const { includeArchived = false, productCategory, productId, allowTradeColors, allowGantriColors } = props;

  if (entry.status === 'archived' && !includeArchived) return false;

  const { availability } = entry;
  if (!availability) return true;

  switch (availability.type) {
    case 'only-on-products':
      return availability.productIds.includes(productId);
    case 'trade-only-on-products':
      // Gated only ON its exclusive products; freely available elsewhere.
      return availability.productIds.includes(productId) ? !!allowTradeColors : true;
    case 'flag-gated':
      return availability.flag === 'allowGantriColors' ? !!allowGantriColors : true;
    case 'only-on-categories':
      if (availability.productIds?.includes(productId)) return true;
      // No category context → keep as a valid option (matches upstream).
      if (!productCategory) return true;
      return availability.categories.includes(productCategory);
    default:
      return true;
  }
}

/**
 * Every color a product can actually be ordered in ({code, name}), mirroring
 * `gantri-components` `getColorsByProduct`. Non-painted products have no color
 * options → returns []. Order follows the palette.
 */
export function getColorsByProduct(props: GetColorsByProductProps): AvailableColor[] {
  if (!props.isPainted) return [];
  return PRODUCT_COLORS.filter((entry) => isColorAvailableForProduct(entry, props)).map((entry) => ({
    code: entry.code,
    name: entry.shortColorName,
  }));
}
