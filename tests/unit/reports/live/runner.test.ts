import { describe, it, expect, vi } from 'vitest';
import { runLiveSpec } from '../../../../src/reports/live/runner.js';
import type { LiveReportSpec } from '../../../../src/reports/live/spec.js';

function fakeRegistry(map: Record<string, unknown>) {
  return {
    execute: vi.fn(async (toolName: string, _args: unknown) => {
      if (map[toolName] === undefined) return { ok: false, error: { code: 'NOT_FOUND', message: 'no fixture' } };
      return { ok: true, data: map[toolName] };
    }),
  };
}

describe('runLiveSpec', () => {
  it('parallel-runs each data step and resolves UI blocks', async () => {
    const spec: LiveReportSpec = {
      version: 1,
      title: 'T',
      data: [
        { id: 'a', tool: 'gantri.order_stats', args: {} },
        { id: 'b', tool: 'northbeam.metrics_explorer', args: {} },
      ],
      ui: [
        { type: 'kpi', label: 'Orders', value: 'a.totalOrders', format: 'number', width: 1 },
        { type: 'kpi', label: 'Revenue', value: 'b.rows[0].rev', format: 'currency', width: 1 },
      ],
      cacheTtlSec: 300,
    };
    const reg = fakeRegistry({
      'gantri.order_stats': { totalOrders: 87 },
      'northbeam.metrics_explorer': { rows: [{ rev: 12345.6 }] },
    });
    const out = await runLiveSpec(spec, reg as never);
    expect(out.dataResults.a).toEqual({ totalOrders: 87 });
    expect(out.dataResults.b).toEqual({ rows: [{ rev: 12345.6 }] });
    expect(out.ui).toEqual(spec.ui);
    expect(out.errors).toEqual([]);
  });

  it('records per-step errors and continues', async () => {
    const spec: LiveReportSpec = {
      version: 1, title: 'T',
      data: [
        { id: 'good', tool: 'gantri.order_stats', args: {} },
        { id: 'bad', tool: 'northbeam.list_metrics', args: {} },
      ],
      ui: [{ type: 'text', markdown: 'hi' }],
      cacheTtlSec: 300,
    };
    const reg = fakeRegistry({ 'gantri.order_stats': { x: 1 } });
    const out = await runLiveSpec(spec, reg as never);
    expect(out.dataResults.good).toEqual({ x: 1 });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({ stepId: 'bad' });
  });

  it('rejects a spec referencing a non-whitelisted tool at runtime', async () => {
    const spec = { version: 1, title: 'T', data: [{ id: 'x', tool: 'feedback.send', args: {} }], ui: [], cacheTtlSec: 0 } as unknown as LiveReportSpec;
    const reg = fakeRegistry({});
    await expect(runLiveSpec(spec, reg as never)).rejects.toThrow(/not whitelisted/i);
  });
});
