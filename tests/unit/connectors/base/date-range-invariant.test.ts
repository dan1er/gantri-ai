import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { WHITELISTED_TOOLS } from '../../../../src/reports/live/spec.js';
import { unstringifyJsonObjects } from '../../../../src/connectors/base/registry.js';

/**
 * INVARIANT — every whitelisted live-report tool that accepts a `dateRange`
 * argument MUST accept three input shapes (as they appear AFTER the registry's
 * `unstringifyJsonObjects` preprocess runs):
 *
 *   1. Preset string                — `'last_30_days'` (the runtime value
 *                                     `$REPORT_RANGE` resolves to).
 *   2. Object literal               — `{ startDate: '2026-01-01', endDate: '2026-01-31' }`.
 *   3. JSON-stringified object      — `'{"startDate":"2026-01-01","endDate":"2026-01-31"}'`.
 *      The LLM occasionally serializes nested args this way; the registry
 *      preprocess parses it back into an object before validation.
 *
 * Three separate connectors (Impact, Klaviyo, gantri.sales_report) shipped
 * with object-only `dateRange` Zod schemas and silently failed Live-Reports
 * smoke validation. Then in feedback 18994b97, Impact tools rejected a
 * stringified-object dateRange that would have matched if it had arrived as
 * a real object. This test is the systemic guard against ever shipping any
 * of those bugs again.
 *
 * Implementation: import every whitelisted tool's connector module, inspect
 * the Zod schema attached to each ToolDef, find the schema for the
 * `dateRange` arg, and exercise it through the registry's preprocess +
 * `safeParse`. If the schema rejects any of the three shapes, the test fails
 * and prints the offending tool name and Zod path so the dev knows exactly
 * what to migrate.
 */

import * as impact from '../../../../src/connectors/impact/connector.js';
import * as klaviyo from '../../../../src/connectors/klaviyo/connector.js';
import * as pipedrive from '../../../../src/connectors/pipedrive/connector.js';
import * as gsc from '../../../../src/connectors/gsc/connector.js';
import * as ga4 from '../../../../src/connectors/ga4/connector.js';
import * as nbApi from '../../../../src/connectors/northbeam-api/connector.js';
import * as salesReport from '../../../../src/connectors/sales-report/sales-report-connector.js';
import * as compareNb from '../../../../src/connectors/sales-report/compare-nb-tool.js';
import * as marketingAnalysis from '../../../../src/connectors/marketing-analysis/connector.js';

/** Walk a Zod schema for a specific arg name. Handles ZodObject directly and
 *  unwraps optional / default / effects wrappers. Returns the inner schema or
 *  null if the arg doesn't exist on this tool. */
function getArgSchema(schema: unknown, argName: string): z.ZodTypeAny | null {
  if (!(schema instanceof z.ZodType)) return null;
  // Unwrap ZodEffects, ZodDefault, ZodOptional layers.
  let s: z.ZodTypeAny = schema as z.ZodTypeAny;
  for (let i = 0; i < 8; i++) {
    if (s instanceof z.ZodEffects) { s = s._def.schema; continue; }
    if (s instanceof z.ZodDefault) { s = s._def.innerType; continue; }
    if (s instanceof z.ZodOptional) { s = s._def.innerType; continue; }
    if (s instanceof z.ZodNullable) { s = s._def.innerType; continue; }
    break;
  }
  if (s instanceof z.ZodObject) {
    const shape = (s._def as { shape: () => Record<string, z.ZodTypeAny> }).shape();
    return shape[argName] ?? null;
  }
  return null;
}

interface ToolLike { name: string; schema: unknown }

/** Some connectors only expose factory functions (not pre-built instances).
 *  For those we hard-code minimal stubs to satisfy DI and pull tools out. */
const inspectionEntries: Array<{ moduleName: string; mod: Record<string, unknown>; instances: Array<{ tools: ToolLike[] }> }> = [
  { moduleName: 'impact', mod: impact, instances: [
    new impact.ImpactConnector({} as never),
  ]},
  { moduleName: 'klaviyo', mod: klaviyo, instances: [
    new klaviyo.KlaviyoConnector({} as never),
  ]},
  { moduleName: 'pipedrive', mod: pipedrive, instances: [
    new pipedrive.PipedriveConnector({} as never),
  ]},
  { moduleName: 'gsc', mod: gsc, instances: [
    new gsc.SearchConsoleConnector({} as never),
  ]},
  { moduleName: 'ga4', mod: ga4, instances: [
    new ga4.Ga4Connector({} as never),
  ]},
  { moduleName: 'northbeam-api', mod: nbApi, instances: [
    new nbApi.NorthbeamApiConnector({} as never),
  ]},
  { moduleName: 'sales-report', mod: salesReport, instances: [
    new salesReport.SalesReportConnector({ grafana: {} as never }),
  ]},
  { moduleName: 'compare-nb', mod: compareNb, instances: [{ tools: [
    compareNb.buildCompareNbTool({ grafana: {} as never, nb: {} as never }),
    compareNb.buildDiffNbTool({ grafana: {} as never, nb: {} as never }),
  ]}]},
  { moduleName: 'marketing-analysis', mod: marketingAnalysis, instances: [
    new marketingAnalysis.MarketingAnalysisConnector({} as never),
  ]},
];

describe('every whitelisted tool with dateRange accepts all three input shapes via the registry pipeline', () => {
  const allTools: ToolLike[] = inspectionEntries.flatMap((e) => e.instances.flatMap((inst) => inst.tools));
  const whitelistedToolsWithDateRange = allTools.filter((t) => WHITELISTED_TOOLS.has(t.name) && getArgSchema(t.schema, 'dateRange') !== null);

  // Sanity: we found at least the tools we know exist.
  it('discovers ≥ 5 whitelisted tools with dateRange (sanity)', () => {
    expect(whitelistedToolsWithDateRange.length).toBeGreaterThanOrEqual(5);
  });

  // Three shapes the LLM (or the live-reports runner) might emit.
  const inputs: Array<{ name: string; value: unknown }> = [
    { name: 'preset string', value: 'last_30_days' },
    { name: 'object literal {startDate,endDate}', value: { startDate: '2026-01-01', endDate: '2026-01-31' } },
    { name: 'JSON-stringified object', value: '{"startDate":"2026-01-01","endDate":"2026-01-31"}' },
  ];

  for (const tool of whitelistedToolsWithDateRange) {
    for (const input of inputs) {
      it(`${tool.name}: accepts dateRange as ${input.name}`, () => {
        const schema = getArgSchema(tool.schema, 'dateRange');
        expect(schema).not.toBeNull();
        // Run the same preprocess the registry runs before Zod validation.
        const preprocessed = unstringifyJsonObjects({ dateRange: input.value }) as { dateRange: unknown };
        const result = schema!.safeParse(preprocessed.dateRange);
        if (!result.success) {
          const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
          throw new Error(
            `Tool '${tool.name}' rejected ${input.name} for dateRange after registry preprocess. ` +
            `Live-Reports' $REPORT_RANGE substitution and LLM-stringified payloads will both ` +
            `fail validation.\n` +
            `Fix: import { DateRangeArg, normalizeDateRange } from '../base/date-range.js' and use ` +
            `DateRangeArg in the Zod schema, then call normalizeDateRange(args.dateRange) before ` +
            `using startDate/endDate.\nZod issues:\n${issues}`,
          );
        }
      });
    }
  }
});
