import type { ConnectorRegistry } from './registry.js';
import type { Connector, ToolDef, ToolResult } from './connector.js';
import type { CachePolicy } from './cache-policy.js';
import { decideCacheStrategy } from './cache-policy.js';
import { logger } from '../../logger.js';

/** Subset of TtlCache that CachingRegistry needs. Lets us mock cleanly in tests. */
export interface CacheBackend {
  get(key: string): Promise<unknown | null>;
  set(
    key: string,
    value: unknown,
    options: { frozen?: boolean; ttlSec?: number; tool?: string },
  ): Promise<void>;
}

/**
 * Decorator over ConnectorRegistry that consults a per-tool CachePolicy on
 * every execute() and persists results to a CacheBackend. Same public surface
 * as ConnectorRegistry so the orchestrator can use either interchangeably.
 */
export class CachingRegistry {
  constructor(
    private readonly inner: ConnectorRegistry,
    private readonly cache: CacheBackend,
    private readonly policies: Record<string, CachePolicy>,
    private readonly nowFn: () => Date = () => new Date(),
    private readonly timezone: string = 'America/Los_Angeles',
  ) {}

  // Pass-throughs — anything that doesn't go through cache.
  register(connector: Connector): void { this.inner.register(connector); }
  getAllTools(): ToolDef[] { return this.inner.getAllTools(); }
  getConnectors(): Connector[] { return this.inner.getConnectors(); }

  async execute(toolName: string, rawArgs: unknown): Promise<ToolResult> {
    const policy = this.policies[toolName];
    if (!policy) return this.inner.execute(toolName, rawArgs);

    const decision = decideCacheStrategy(toolName, policy, rawArgs, this.nowFn(), this.timezone);
    if (decision.mode === 'skip' || !decision.key) {
      return this.inner.execute(toolName, rawArgs);
    }

    const hit = await this.cache.get(decision.key);
    if (hit) {
      logger.info({ tool: toolName, mode: decision.mode, cached: true }, 'cache hit');
      return hit as ToolResult;
    }

    const result = await this.inner.execute(toolName, rawArgs);
    if (result.ok) {
      try {
        await this.cache.set(decision.key, result, {
          frozen: decision.mode === 'frozen',
          ttlSec: decision.mode === 'ttl' ? decision.ttlSec : undefined,
          tool: toolName,
        });
      } catch (err) {
        logger.warn({ tool: toolName, err: err instanceof Error ? err.message : String(err) }, 'cache set failed');
      }
    }
    return result;
  }
}
