import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ConnectorRegistry } from '../../../../src/connectors/base/registry.js';
import type { Connector, ToolDef } from '../../../../src/connectors/base/connector.js';
import { CachingRegistry } from '../../../../src/connectors/base/caching-registry.js';

function fakeRegistry(execImpl: (args: any) => any) {
  const exec = vi.fn(async (args: any) => execImpl(args));
  const tool: ToolDef = {
    name: 'gantri.order_stats',
    description: '',
    schema: z.object({}).passthrough(),
    jsonSchema: { type: 'object' },
    execute: exec,
  };
  const conn: Connector = { name: 'gantri', tools: [tool], async healthCheck() { return { ok: true }; } };
  const r = new ConnectorRegistry();
  r.register(conn);
  return { registry: r, exec };
}

function memCache() {
  const store = new Map<string, { value: unknown; frozen: boolean; expiresAt: number }>();
  return {
    store,
    async get(key: string) {
      const hit = store.get(key);
      if (!hit) return null;
      if (!hit.frozen && hit.expiresAt < Date.now()) return null;
      return hit.value;
    },
    async set(key: string, value: unknown, opts: { frozen?: boolean; ttlSec?: number; tool?: string }) {
      store.set(key, {
        value,
        frozen: !!opts.frozen,
        expiresAt: opts.frozen ? Number.MAX_SAFE_INTEGER : Date.now() + (opts.ttlSec ?? 0) * 1000,
      });
    },
  };
}

describe('CachingRegistry', () => {
  const NOW = new Date('2026-04-25T12:00:00.000Z');

  it('caches a frozen result for a fully closed range', async () => {
    const { registry, exec } = fakeRegistry((args) => ({ totalOrders: 5, dateRange: args.dateRange }));
    const cache = memCache();
    const policies = {
      'gantri.order_stats': {
        version: 1,
        settleDays: 30,
        openTtlSec: 60,
        dateRangePath: 'dateRange',
      },
    };
    const c = new CachingRegistry(registry, cache as any, policies, () => NOW);
    const args = { dateRange: { startDate: '2025-01-01', endDate: '2025-12-31' } };
    const r1 = await c.execute('gantri.order_stats', args);
    const r2 = await c.execute('gantri.order_stats', args);
    expect(r1).toEqual(r2);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(cache.store.size).toBe(1);
    const stored = [...cache.store.values()][0];
    expect(stored.frozen).toBe(true);
  });

  it('does NOT cache when policy is missing', async () => {
    const { registry, exec } = fakeRegistry(() => ({ x: 1 }));
    const cache = memCache();
    const c = new CachingRegistry(registry, cache as any, {}, () => NOW);
    await c.execute('gantri.order_stats', { dateRange: { startDate: '2025-01-01', endDate: '2025-12-31' } });
    await c.execute('gantri.order_stats', { dateRange: { startDate: '2025-01-01', endDate: '2025-12-31' } });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(cache.store.size).toBe(0);
  });

  it('does NOT cache failed tool results', async () => {
    const { registry, exec } = fakeRegistry(() => { throw new Error('boom'); });
    const cache = memCache();
    const policies = {
      'gantri.order_stats': { version: 1, settleDays: 30, openTtlSec: 60, dateRangePath: 'dateRange' },
    };
    const c = new CachingRegistry(registry, cache as any, policies, () => NOW);
    const r = await c.execute('gantri.order_stats', { dateRange: { startDate: '2025-01-01', endDate: '2025-12-31' } });
    expect(r.ok).toBe(false);
    expect(cache.store.size).toBe(0);
    // retry — should hit the tool again, not the cache
    await c.execute('gantri.order_stats', { dateRange: { startDate: '2025-01-01', endDate: '2025-12-31' } });
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
