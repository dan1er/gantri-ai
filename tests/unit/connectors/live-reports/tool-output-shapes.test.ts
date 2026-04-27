import { describe, it, expect } from 'vitest';
import { TOOL_OUTPUT_SHAPES } from '../../../../src/connectors/live-reports/tool-output-shapes.js';
import { WHITELISTED_TOOLS } from '../../../../src/reports/live/spec.js';

/**
 * Internal-consistency tests for the live-reports tool output catalog.
 *
 * The catalog is the single source of truth that the compiler LLM uses to
 * decide which field names exist on each tool's output. If the catalog drifts
 * from reality, the compiler generates broken specs and the verifier blocks
 * publish — but the LLM keeps trying the same wrong paths because the prompt
 * still says they're valid.
 *
 * This test enforces three things at CI time:
 *  1. Every whitelisted tool has a catalog entry.
 *  2. Each entry's `example` is an object (not a string / array).
 *  3. The example's top-level keys exactly match `expectedTopLevelKeys`.
 *  4. For each documented array field, the example's first element contains
 *     every key declared in `expectedArrayElementKeys`.
 *
 * Drift inside the file (catalog author updated example but forgot the
 * declared contract, or vice versa) is caught here. Drift between the
 * catalog and the actual connector return shape is caught by code review +
 * the publish-time verifier — see `connector.ts > verifyResolvedRefs`.
 */

describe('tool-output-shapes catalog', () => {
  it('covers every whitelisted live-report tool', () => {
    const documented = new Set(Object.keys(TOOL_OUTPUT_SHAPES));
    const missing = [...WHITELISTED_TOOLS].filter((t) => !documented.has(t));
    expect(missing).toEqual([]);
  });

  for (const [tool, sample] of Object.entries(TOOL_OUTPUT_SHAPES)) {
    describe(tool, () => {
      it('has an object example (not a string / array / scalar)', () => {
        expect(sample.example).toBeTypeOf('object');
        expect(sample.example).not.toBeNull();
        expect(Array.isArray(sample.example)).toBe(false);
      });

      it('example.top-level keys exactly match expectedTopLevelKeys', () => {
        const actualKeys = Object.keys(sample.example as Record<string, unknown>).sort();
        const declaredKeys = [...sample.expectedTopLevelKeys].sort();
        expect(actualKeys).toEqual(declaredKeys);
      });

      if (sample.expectedArrayElementKeys) {
        for (const [field, declaredElementKeys] of Object.entries(sample.expectedArrayElementKeys)) {
          it(`example.${field}[0] contains every key in expectedArrayElementKeys.${field}`, () => {
            const arr = (sample.example as Record<string, unknown>)[field];
            expect(Array.isArray(arr), `${field} must be an array in example`).toBe(true);
            const first = (arr as unknown[])[0];
            expect(first, `${field}[0] must be present in example`).toBeTypeOf('object');
            const actualKeys = new Set(Object.keys(first as Record<string, unknown>));
            const missing = declaredElementKeys.filter((k) => !actualKeys.has(k));
            expect(missing, `${field}[0] missing keys: ${missing.join(', ')}`).toEqual([]);
          });
        }
      }
    });
  }
});
