export const ATTRIBUTION_MODELS = [
  'linear', 'first_click', 'clicks_only', 'northbeam_custom',
] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

export const ATTRIBUTION_WINDOWS = ['1', '7', '30'] as const;
export type AttributionWindow = (typeof ATTRIBUTION_WINDOWS)[number];

export const ACCOUNTING_MODES = ['accrual', 'cash'] as const;
export type AccountingMode = (typeof ACCOUNTING_MODES)[number];

export const TIME_GRANULARITIES = ['daily', 'weekly', 'monthly'] as const;
export type TimeGranularity = (typeof TIME_GRANULARITIES)[number];

export const SALES_LEVELS = ['campaign', 'adset', 'ad', 'platform'] as const;
export type SalesLevel = (typeof SALES_LEVELS)[number];

export interface MetricDef {
  id: string;
  label: string;
  description: string;
}

export const METRIC_CATALOG: MetricDef[] = [
  { id: 'spend', label: 'Spend', description: 'Marketing dollars spent.' },
  { id: 'rev', label: 'Revenue', description: 'Attributed revenue.' },
  { id: 'roas', label: 'ROAS', description: 'Return on ad spend (rev / spend).' },
  { id: 'roasFt', label: 'ROAS (First-touch)', description: 'Return on ad spend computed with a first-touch model.' },
  { id: 'roasLtv', label: 'ROAS (LTV)', description: 'Return on ad spend adjusted for lifetime value.' },
  { id: 'googleROAS', label: 'Google ROAS', description: 'ROAS as reported natively by Google Ads.' },
  { id: 'metaROAS7DClick1DView', label: 'Meta ROAS (7D Click, 1D View)', description: 'ROAS as reported by Meta with 7-day click / 1-day view attribution.' },
  { id: 'cpm', label: 'CPM', description: 'Cost per thousand impressions.' },
  { id: 'ctr', label: 'CTR', description: 'Click-through rate.' },
  { id: 'ecpc', label: 'eCPC', description: 'Effective cost per click.' },
  { id: 'ecpnv', label: 'eCPNV', description: 'Effective cost per new visitor.' },
  { id: 'ecr', label: 'ECR', description: 'E-commerce conversion rate (orders / visits).' },
  { id: 'visits', label: 'Visits', description: 'Session count from tracked sources.' },
  { id: 'percentageNewVisits', label: '% New visits', description: 'Share of visits from new users.' },
  { id: 'avgTouchpointsPerOrderNew', label: 'Avg touchpoints / new order', description: 'Average number of attributed touchpoints preceding a new-customer order.' },
  { id: 'cpo', label: 'CPO', description: 'Cost per order.' },
  { id: 'aov', label: 'AOV', description: 'Average order value.' },
  { id: 'orders', label: 'Orders', description: 'Attributed order count.' },
  { id: 'rev_new', label: 'New customer revenue', description: 'Revenue attributed to first-time customers.' },
  { id: 'rev_returning', label: 'Returning customer revenue', description: 'Revenue from repeat customers.' },
];

export function describeCatalog(): string {
  const metrics = METRIC_CATALOG
    .map((m) => `- \`${m.id}\` (${m.label}): ${m.description}`)
    .join('\n');
  return [
    'Available metricIds:',
    metrics,
    '',
    `Attribution models: ${ATTRIBUTION_MODELS.join(', ')}`,
    `Attribution windows (days, as string): ${ATTRIBUTION_WINDOWS.join(', ')}`,
    `Accounting modes: ${ACCOUNTING_MODES.join(', ')}`,
    `Time granularities: ${TIME_GRANULARITIES.join(', ')}`,
    `Sales levels: ${SALES_LEVELS.join(', ')}`,
  ].join('\n');
}
