import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ImpactConnector } from '../../../../src/connectors/impact/connector.js';
import { unstringifyJsonObjects } from '../../../../src/connectors/base/registry.js';

/**
 * Regression test for Lana's feedback 18994b97 (production conversation thread
 * 1777496128.175319). The LLM emitted `dateRange` as a JSON-encoded string
 * instead of a real object, and Impact's local `DateRange` Zod union rejected
 * it because none of the branches accepted a raw string-encoded payload:
 *
 *     "received": "{\"startDate\": \"2026-01-01\", \"endDate\": \"2026-01-31\"}"
 *     "code": "invalid_enum_value"
 *
 * Three-layer fix: (a) registry-level `unstringifyJsonObjects` recursively
 * JSON-parses any string arg that looks like an object/array before validation;
 * (b) Impact migrated to the shared `DateRangeArg` schema; (c) the invariant
 * test in `tests/unit/connectors/base/date-range-invariant.test.ts` now
 * verifies all three input shapes for every whitelisted tool.
 *
 * This test exercises the EXACT input that failed in production — if it ever
 * regresses, we want to know immediately without grinding through the
 * full-coverage invariant.
 */
describe("regression: Lana's stringified dateRange (feedback 18994b97)", () => {
  it('Impact partner_performance accepts the stringified-object dateRange after registry preprocess', () => {
    const conn = new ImpactConnector({} as never);
    const tool = conn.tools.find((t) => t.name === 'impact.partner_performance');
    expect(tool, 'impact.partner_performance must exist').toBeDefined();

    // The exact args the LLM sent in production.
    const rawArgs = {
      dateRange: '{"startDate": "2026-01-01", "endDate": "2026-01-31"}',
      state: 'ALL',
      sortBy: 'revenue',
      limit: 50,
    };

    // What the registry would do BEFORE handing args to the tool's Zod schema.
    const preprocessed = unstringifyJsonObjects(rawArgs);

    const result = (tool!.schema as z.ZodType<unknown>).safeParse(preprocessed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`Schema rejected the preprocessed args. Issues:\n${issues}`);
    }
    expect(result.success).toBe(true);
  });

  it('Impact list_actions accepts the stringified-object dateRange after registry preprocess', () => {
    const conn = new ImpactConnector({} as never);
    const tool = conn.tools.find((t) => t.name === 'impact.list_actions');
    expect(tool, 'impact.list_actions must exist').toBeDefined();

    const rawArgs = {
      dateRange: '{"startDate": "2026-01-01", "endDate": "2026-01-31"}',
      state: 'ALL',
      limit: 200,
    };
    const preprocessed = unstringifyJsonObjects(rawArgs);
    const result = (tool!.schema as z.ZodType<unknown>).safeParse(preprocessed);
    expect(result.success).toBe(true);
  });
});
