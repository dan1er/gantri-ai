import { describe, it, expect } from 'vitest';
import { LiveReportSpec, WHITELISTED_TOOLS } from '../../../../src/reports/live/spec.js';

describe('LiveReportSpec v1', () => {
  it('accepts a minimal valid spec', () => {
    const valid = {
      version: 1,
      title: 'Weekly Sales',
      data: [
        { id: 'rev', tool: 'northbeam.metrics_explorer', args: { dateRange: 'last_7_days', metrics: ['rev'] } },
      ],
      ui: [
        { type: 'kpi', label: 'Revenue', value: 'rev.rows[0].rev', format: 'currency' },
      ],
    };
    expect(LiveReportSpec.safeParse(valid).success).toBe(true);
  });

  it('rejects a spec referencing a non-whitelisted tool', () => {
    const bad = {
      version: 1,
      title: 'Test',
      data: [{ id: 'x', tool: 'reports.create_canvas', args: {} }],
      ui: [],
    };
    expect(LiveReportSpec.safeParse(bad).success).toBe(false);
  });

  it('rejects a spec with no data steps', () => {
    expect(LiveReportSpec.safeParse({ version: 1, title: 'T', data: [], ui: [] }).success).toBe(false);
  });

  it('rejects a spec with version != 1', () => {
    expect(LiveReportSpec.safeParse({ version: 2, title: 'T', data: [{ id: 'x', tool: 'northbeam.metrics_explorer', args: {} }], ui: [] }).success).toBe(false);
  });

  it('accepts all 5 ui block types', () => {
    const spec = {
      version: 1,
      title: 'All blocks',
      data: [{ id: 's', tool: 'gantri.order_stats', args: {} }],
      ui: [
        { type: 'kpi', label: 'X', value: 's.totalOrders' },
        { type: 'chart', variant: 'line', title: 'Trend', data: 's.daily', x: 'date', y: 'orders' },
        { type: 'table', data: 's.rows', columns: [{ field: 'a', label: 'A' }] },
        { type: 'text', markdown: '## Hello' },
        { type: 'divider' },
      ],
    };
    expect(LiveReportSpec.safeParse(spec).success).toBe(true);
  });

  it('exposes WHITELISTED_TOOLS as a non-empty set including northbeam, gantri, ga4, grafana prefixes', () => {
    const tools = [...WHITELISTED_TOOLS];
    expect(tools.length).toBeGreaterThan(5);
    expect(tools.some((t) => t.startsWith('northbeam.'))).toBe(true);
    expect(tools.some((t) => t.startsWith('gantri.'))).toBe(true);
    expect(tools.some((t) => t.startsWith('ga4.'))).toBe(true);
    expect(tools.some((t) => t.startsWith('grafana.'))).toBe(true);
  });
});
