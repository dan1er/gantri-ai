import { describe, it, expect, vi } from 'vitest';
import { NorthbeamApiClient, NorthbeamApiError, parseCsv } from '../../../../src/connectors/northbeam-api/client.js';

describe('parseCsv', () => {
  it('parses a vanilla CSV with header + rows', () => {
    const csv = 'a,b,c\n1,2,3\n4,5,6\n';
    const r = parseCsv(csv);
    expect(r.headers).toEqual(['a', 'b', 'c']);
    expect(r.rows).toEqual([{ a: '1', b: '2', c: '3' }, { a: '4', b: '5', c: '6' }]);
  });

  it('handles quoted fields with embedded commas, quotes, and newlines', () => {
    const csv = 'name,note\n"Doe, John","line1\nline2"\n"O""Brien","quoted ""word"""\n';
    const r = parseCsv(csv);
    expect(r.rows).toEqual([
      { name: 'Doe, John', note: 'line1\nline2' },
      { name: 'O"Brien', note: 'quoted "word"' },
    ]);
  });

  it('preserves empty cells', () => {
    const csv = 'a,b,c\n,,3\n1,,3\n';
    const r = parseCsv(csv);
    expect(r.rows).toEqual([{ a: '', b: '', c: '3' }, { a: '1', b: '', c: '3' }]);
  });

  it('returns empty headers/rows for empty input', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [], raw: '' });
  });
});

describe('NorthbeamApiClient', () => {
  const config = (fetchImpl: typeof fetch) => ({
    apiKey: 'test-key',
    dataClientId: 'test-client',
    pollIntervalMs: 5,
    pollTimeoutMs: 200,
    fetchImpl,
  });

  it('sends Authorization (raw key, not Bearer) + Data-Client-ID headers on createExport', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'abc' }), { status: 201 })) as unknown as typeof fetch;
    const c = new NorthbeamApiClient(config(fetchImpl));
    const r = await c.createExport({
      attribution_options: { attribution_models: ['x'], accounting_modes: ['cash'], attribution_windows: ['1'] },
      metrics: [{ id: 'rev' }],
    });
    expect(r).toEqual({ id: 'abc' });
    const callArgs = (fetchImpl as any).mock.calls[0];
    expect(callArgs[0]).toBe('https://api.northbeam.io/v1/exports/data-export');
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('test-key');
    expect(headers.Authorization.startsWith('Bearer ')).toBe(false);
    expect(headers['Data-Client-ID']).toBe('test-client');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('throws NorthbeamApiError on non-2xx with the parsed body', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: [{ msg: 'bad metric' }] }), { status: 422 })) as unknown as typeof fetch;
    const c = new NorthbeamApiClient(config(fetchImpl));
    await expect(c.createExport({
      attribution_options: { attribution_models: ['x'], accounting_modes: ['cash'], attribution_windows: ['1'] },
      metrics: [{ id: 'doesnotexist' }],
    })).rejects.toBeInstanceOf(NorthbeamApiError);
  });

  it('runExport: createExport → poll → SUCCESS → downloadCsv → parsed rows', async () => {
    let pollCount = 0;
    const csvBody = 'rev,spend\n100,50\n200,80\n';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/exports/data-export')) return new Response(JSON.stringify({ id: 'export-1' }), { status: 201 });
      if (url.includes('/v1/exports/data-export/result/')) {
        pollCount++;
        if (pollCount < 2) return new Response(JSON.stringify({ status: 'PENDING' }), { status: 200 });
        return new Response(JSON.stringify({ status: 'SUCCESS', result: ['https://signed-url.example/csv'] }), { status: 200 });
      }
      if (url === 'https://signed-url.example/csv') return new Response(csvBody, { status: 200 });
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const c = new NorthbeamApiClient(config(fetchImpl));
    const r = await c.runExport({
      attribution_options: { attribution_models: ['x'], accounting_modes: ['cash'], attribution_windows: ['1'] },
      metrics: [{ id: 'rev' }, { id: 'spend' }],
    });
    expect(r.headers).toEqual(['rev', 'spend']);
    expect(r.rows).toEqual([{ rev: '100', spend: '50' }, { rev: '200', spend: '80' }]);
  });

  it('waitForExport throws on poll timeout (still PENDING when budget elapses)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'PENDING' }), { status: 200 })) as unknown as typeof fetch;
    const c = new NorthbeamApiClient({ ...config(fetchImpl), pollIntervalMs: 5, pollTimeoutMs: 30 });
    await expect(c.waitForExport('export-1')).rejects.toBeInstanceOf(NorthbeamApiError);
  });

  it('runExport throws when status terminates as FAILED', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/exports/data-export')) return new Response(JSON.stringify({ id: 'export-2' }), { status: 201 });
      return new Response(JSON.stringify({ status: 'FAILED', error: 'something' }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new NorthbeamApiClient(config(fetchImpl));
    await expect(c.runExport({
      attribution_options: { attribution_models: ['x'], accounting_modes: ['cash'], attribution_windows: ['1'] },
      metrics: [{ id: 'rev' }],
    })).rejects.toBeInstanceOf(NorthbeamApiError);
  });

  it('listMetrics / listBreakdowns / listAttributionModels unwrap the wire envelope', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/exports/metrics')) return new Response(JSON.stringify({ metrics: [{ id: 'rev', label: 'Revenue' }] }), { status: 200 });
      if (url.endsWith('/v1/exports/breakdowns')) return new Response(JSON.stringify({ breakdowns: [{ key: 'Forecast', values: ['Email'] }] }), { status: 200 });
      if (url.endsWith('/v1/exports/attribution-models')) return new Response(JSON.stringify({ attribution_models: [{ id: 'm', name: 'Model' }] }), { status: 200 });
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const c = new NorthbeamApiClient(config(fetchImpl));
    expect(await c.listMetrics()).toEqual([{ id: 'rev', label: 'Revenue' }]);
    expect(await c.listBreakdowns()).toEqual([{ key: 'Forecast', values: ['Email'] }]);
    expect(await c.listAttributionModels()).toEqual([{ id: 'm', name: 'Model' }]);
  });
});
