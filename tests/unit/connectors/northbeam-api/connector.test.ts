import { describe, it, expect, vi } from 'vitest';
import { NorthbeamApiConnector, buildExportPayload } from '../../../../src/connectors/northbeam-api/connector.js';

describe('buildExportPayload', () => {
  it('translates a preset dateRange into the right period_type', () => {
    const p = buildExportPayload({
      dateRange: 'last_7_days',
      metrics: ['rev', 'spend'],
      attributionModel: 'northbeam_custom__va',
      accountingMode: 'cash',
      attributionWindow: '1',
      granularity: 'DAILY',
      aggregateData: true,
    });
    expect(p.period_type).toBe('LAST_7_DAYS');
    expect(p.period_options).toBeUndefined();
    expect(p.metrics).toEqual([{ id: 'rev' }, { id: 'spend' }]);
    expect(p.attribution_options).toEqual({
      attribution_models: ['northbeam_custom__va'],
      accounting_modes: ['cash'],
      attribution_windows: ['1'],
    });
  });

  it('translates a fixed dateRange into period_type FIXED + period_options.from/to', () => {
    const p = buildExportPayload({
      dateRange: { start: '2026-01-01', end: '2026-01-01' },
      metrics: ['spend'],
      attributionModel: 'northbeam_custom__va',
      accountingMode: 'cash',
      attributionWindow: '1',
      granularity: 'DAILY',
      aggregateData: true,
    });
    expect(p.period_type).toBe('FIXED');
    expect(p.period_options).toEqual({ from: '2026-01-01', to: '2026-01-01' });
  });

  it('passes the breakdown through unchanged', () => {
    const p = buildExportPayload({
      dateRange: 'yesterday',
      metrics: ['rev'],
      breakdown: { key: 'Forecast', values: ['Email', 'Google Ads'] },
      attributionModel: 'northbeam_custom__va',
      accountingMode: 'cash',
      attributionWindow: '1',
      granularity: 'DAILY',
      aggregateData: true,
    });
    expect(p.breakdowns).toEqual([{ key: 'Forecast', values: ['Email', 'Google Ads'] }]);
  });
});

describe('NorthbeamApiConnector', () => {
  const successfulFetch = (csv: string) =>
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (u.endsWith('/v1/exports/data-export') && method === 'POST') return new Response(JSON.stringify({ id: 'export-1' }), { status: 201 });
      if (u.includes('/v1/exports/data-export/result/')) return new Response(JSON.stringify({ status: 'SUCCESS', result: ['https://signed/csv'] }), { status: 200 });
      if (u === 'https://signed/csv') return new Response(csv, { status: 200 });
      if (u.endsWith('/v1/exports/metrics')) return new Response(JSON.stringify({ metrics: [{ id: 'rev', label: 'Revenue' }] }), { status: 200 });
      if (u.endsWith('/v1/exports/breakdowns')) return new Response(JSON.stringify({ breakdowns: [{ key: 'Forecast', values: ['Email'] }] }), { status: 200 });
      if (u.endsWith('/v1/exports/attribution-models')) return new Response(JSON.stringify({ attribution_models: [{ id: 'northbeam_custom__va', name: 'Clicks + Modeled Views' }] }), { status: 200 });
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;

  it('exposes the four expected tools by name', () => {
    const c = new NorthbeamApiConnector({ apiKey: 'k', dataClientId: 'cid', fetchImpl: successfulFetch('a,b\n1,2\n') });
    expect(c.tools.map((t) => t.name).sort()).toEqual([
      'northbeam.list_attribution_models',
      'northbeam.list_breakdowns',
      'northbeam.list_metrics',
      'northbeam.metrics_explorer',
    ]);
  });

  it('metrics_explorer returns parsed rows and surfaces metadata', async () => {
    const c = new NorthbeamApiConnector({ apiKey: 'k', dataClientId: 'cid', pollIntervalMs: 1, fetchImpl: successfulFetch('rev,spend\n100,50\n') });
    const tool = c.tools.find((t) => t.name === 'northbeam.metrics_explorer')!;
    const r = await tool.execute({
      dateRange: 'yesterday',
      metrics: ['rev', 'spend'],
      attributionModel: 'northbeam_custom__va',
      accountingMode: 'cash',
      attributionWindow: '1',
      granularity: 'DAILY',
      aggregateData: true,
    } as any) as { rowCount: number; rows: Array<Record<string, string>> };
    expect(r.rowCount).toBe(1);
    expect(r.rows).toEqual([{ rev: '100', spend: '50' }]);
  });

  it('list_metrics / list_breakdowns / list_attribution_models call the catalog endpoints', async () => {
    const c = new NorthbeamApiConnector({ apiKey: 'k', dataClientId: 'cid', fetchImpl: successfulFetch('') });
    const lm = c.tools.find((t) => t.name === 'northbeam.list_metrics')!;
    const lb = c.tools.find((t) => t.name === 'northbeam.list_breakdowns')!;
    const la = c.tools.find((t) => t.name === 'northbeam.list_attribution_models')!;
    expect((await lm.execute({} as any) as { count: number }).count).toBe(1);
    expect((await lb.execute({} as any) as { count: number }).count).toBe(1);
    expect((await la.execute({} as any) as { count: number }).count).toBe(1);
  });

  it('healthCheck pings the metrics catalog and reports ok', async () => {
    const c = new NorthbeamApiConnector({ apiKey: 'k', dataClientId: 'cid', fetchImpl: successfulFetch('') });
    const h = await c.healthCheck();
    expect(h.ok).toBe(true);
    expect(h.detail).toContain('catalog has');
  });
});
