import { describe, it, expect } from 'vitest';
import {
  METRIC_CATALOG,
  ATTRIBUTION_MODELS,
  ATTRIBUTION_WINDOWS,
  ACCOUNTING_MODES,
  TIME_GRANULARITIES,
  SALES_LEVELS,
  describeCatalog,
} from '../../../src/connectors/northbeam/catalog.js';

describe('catalog', () => {
  it('includes core metric IDs', () => {
    const ids = METRIC_CATALOG.map((m) => m.id);
    for (const core of ['spend', 'rev', 'roas', 'cpm', 'ctr', 'visits']) {
      expect(ids).toContain(core);
    }
  });

  it('exposes fixed enumerations expected by the API', () => {
    expect(ATTRIBUTION_MODELS).toContain('linear');
    expect(ATTRIBUTION_WINDOWS).toContain('1');
    expect(ACCOUNTING_MODES).toContain('accrual');
    expect(TIME_GRANULARITIES).toContain('daily');
    expect(SALES_LEVELS).toContain('campaign');
  });

  it('describeCatalog returns a human-readable summary with each metric and its description', () => {
    const text = describeCatalog();
    expect(text).toContain('spend');
    expect(text).toContain('roas');
    expect(text).toMatch(/ROAS.*return/i);
  });
});
