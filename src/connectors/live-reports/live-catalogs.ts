/**
 * Live, runtime-discovered enum catalogs that the compiler injects into its
 * system prompt. The output-shapes catalog (tool-output-shapes.ts) tells the
 * LLM what FIELDS exist; this one tells it what VALUES are valid for tool
 * args — so it can't hallucinate a breakdown key like "Forecast" if NB
 * doesn't actually have one named that.
 *
 * Source of truth: the NB API's own list endpoints. We cache the result for
 * ~1 hour so the compile path doesn't re-fetch on every report.
 */

import type { NorthbeamApiClient } from '../northbeam-api/client.js';
import { logger } from '../../logger.js';

const TTL_MS = 60 * 60 * 1000; // 1 hour — NB catalog changes rarely

interface CachedCatalogs {
  nbMetrics: Array<{ id: string; label: string }>;
  nbBreakdowns: Array<{ key: string; values: string[] }>;
  nbAttributionModels: Array<{ id: string; name: string }>;
}

interface CacheEntry {
  fetchedAt: number;
  data: CachedCatalogs;
}

export class LiveCatalogs {
  private cache: CacheEntry | null = null;
  private inflight: Promise<CachedCatalogs> | null = null;

  constructor(private readonly nb: NorthbeamApiClient) {}

  async get(): Promise<CachedCatalogs> {
    if (this.cache && Date.now() - this.cache.fetchedAt < TTL_MS) {
      return this.cache.data;
    }
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const [nbMetrics, nbBreakdowns, nbAttributionModels] = await Promise.all([
          this.nb.listMetrics(),
          this.nb.listBreakdowns(),
          this.nb.listAttributionModels(),
        ]);
        const data: CachedCatalogs = { nbMetrics, nbBreakdowns, nbAttributionModels };
        this.cache = { fetchedAt: Date.now(), data };
        return data;
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'live-catalogs fetch failed; serving stale or empty');
        // Graceful degradation: if we have a stale cache, keep using it; else
        // return empty arrays so the prompt still compiles, just without enum
        // info. The retry feedback loop will catch any resulting bad args.
        return this.cache?.data ?? { nbMetrics: [], nbBreakdowns: [], nbAttributionModels: [] };
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}

/** Render the catalogs as a markdown section the compiler prompt embeds.
 *  Designed to be terse but exhaustive — every valid enum value is listed. */
export function renderLiveCatalogs(c: CachedCatalogs): string {
  if (c.nbMetrics.length === 0 && c.nbBreakdowns.length === 0 && c.nbAttributionModels.length === 0) {
    return '# NB LIVE CATALOGS — UNAVAILABLE (network or auth issue). Be conservative with NB args; the runner will reject anything invalid.';
  }
  const lines: string[] = [
    '# NB LIVE CATALOGS — these are the ONLY valid values for the corresponding NB args. Do NOT invent IDs or keys.',
    '',
    '## Valid `metrics[]` values for `northbeam.metrics_explorer` (use the `id`, NOT the label):',
    c.nbMetrics.map((m) => `- \`${m.id}\` (${m.label})`).join('\n'),
    '',
    '## Valid `breakdown.key` values for `northbeam.metrics_explorer`:',
    c.nbBreakdowns.map((b) => `- \`${b.key}\` — values: ${b.values.slice(0, 12).map((v) => `"${v}"`).join(', ')}${b.values.length > 12 ? `, …(+${b.values.length - 12} more)` : ''}`).join('\n'),
    '',
    '## Valid `attributionModel` IDs:',
    c.nbAttributionModels.map((m) => `- \`${m.id}\` (${m.name})`).join('\n'),
  ];
  return lines.join('\n');
}
