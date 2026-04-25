import { describe, it, expect } from 'vitest';
import { TtlCache } from '../../src/storage/cache.js';

function makeClient() {
  const store = new Map<string, { response: unknown; expires_at: string; tool?: string; frozen?: boolean }>();
  let lastFromTable: string | null = null;
  return {
    store,
    get lastTable() { return lastFromTable; },
    client: {
      from(table: string) {
        lastFromTable = table;
        return {
          select(_cols: string) {
            return {
              eq(_c: string, key: string) {
                return {
                  gt(_col: string, nowIso: string) {
                    return {
                      maybeSingle() {
                        const row = store.get(key);
                        if (row && row.expires_at > nowIso) {
                          return Promise.resolve({ data: row, error: null });
                        }
                        return Promise.resolve({ data: null, error: null });
                      },
                    };
                  },
                };
              },
            };
          },
          upsert(row: any) {
            store.set(row.cache_key, {
              response: row.response,
              expires_at: row.expires_at,
              tool: row.tool,
              frozen: row.frozen,
            });
            return Promise.resolve({ error: null });
          },
        };
      },
    } as any,
  };
}

describe('TtlCache', () => {
  it('returns undefined on miss', async () => {
    const { client } = makeClient();
    const c = new TtlCache(client);
    expect(await c.get('k')).toBeUndefined();
  });

  it('stores and retrieves a value within TTL', async () => {
    const { client } = makeClient();
    const c = new TtlCache(client);
    await c.set('k', { x: 1 }, 60);
    expect(await c.get('k')).toEqual({ x: 1 });
  });

  it('returns undefined once TTL has elapsed', async () => {
    const { client, store } = makeClient();
    const c = new TtlCache(client);
    await c.set('k', { x: 1 }, 60);
    const row = store.get('k')!;
    row.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await c.get('k')).toBeUndefined();
  });

  it('key() produces stable hash for equivalent inputs regardless of key order', () => {
    const a = TtlCache.key('Op', { b: 2, a: 1 });
    const b = TtlCache.key('Op', { a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it('writes/reads against the tool_result_cache table', async () => {
    const c1 = makeClient();
    const c = new TtlCache(c1.client);
    await c.set('k', { x: 1 }, 60);
    expect(c1.lastTable).toBe('tool_result_cache');
    await c.get('k');
    expect(c1.lastTable).toBe('tool_result_cache');
  });

  it('frozen set persists with a far-future expiry and frozen=true', async () => {
    const { client, store } = makeClient();
    const c = new TtlCache(client);
    await c.set('frozenkey', { hello: 'world' }, { frozen: true, tool: 'grafana.sql' });
    const row = store.get('frozenkey')!;
    expect(row.frozen).toBe(true);
    expect(row.tool).toBe('grafana.sql');
    expect(new Date(row.expires_at).getUTCFullYear()).toBeGreaterThanOrEqual(2099);
  });

  it('options-form set with ttlSec works alongside the legacy 3-arg form', async () => {
    const { client, store } = makeClient();
    const c = new TtlCache(client);
    await c.set('k', { x: 1 }, { ttlSec: 60, tool: 'northbeam.overview' });
    const row = store.get('k')!;
    expect(row.frozen).toBe(false);
    expect(row.tool).toBe('northbeam.overview');
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now() + 50_000);
  });
});
