import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { Connector, ToolDef } from '../../../src/connectors/base/connector.js';
import { ConnectorRegistry } from '../../../src/connectors/base/registry.js';
import { executePlan } from '../../../src/reports/plan-executor.js';
import type { ReportPlan } from '../../../src/reports/plan-types.js';

function fakeConnector(name: string, tools: ToolDef[]): Connector {
  return {
    name,
    tools,
    async healthCheck() { return { ok: true }; },
  };
}

function fakeTool(name: string, execute: (args: any) => Promise<unknown>): ToolDef {
  return {
    name,
    description: name,
    schema: z.object({}).passthrough(),
    jsonSchema: { type: 'object' },
    execute,
  };
}

describe('executePlan', () => {
  const runAt = new Date('2026-04-25T14:23:00.000Z');

  it('executes independent steps in parallel and renders blocks', async () => {
    const sqlExec = vi.fn(async (args: any) => ({ rows: [{ x: 1 }, { x: 2 }] }));
    const overviewExec = vi.fn(async (args: any) => ({ spend: 100 }));
    const registry = new ConnectorRegistry();
    registry.register(fakeConnector('grafana', [fakeTool('grafana.sql', sqlExec)]));
    registry.register(fakeConnector('northbeam', [fakeTool('northbeam.overview', overviewExec)]));

    const plan: ReportPlan = {
      schemaVersion: 1,
      steps: [
        { alias: 'late', tool: 'grafana.sql', args: { sql: 'select 1', dateRange: { $time: 'today_pt' } } },
        { alias: 'spend', tool: 'northbeam.overview', args: { dateRange: { $time: 'today_pt' } } },
      ],
      output: {
        blocks: [
          { type: 'header', text: 'Daily report' },
          { type: 'text', text: 'Spend: ${spend.spend}' },
        ],
      },
    };

    const result = await executePlan({ plan, registry, runAt, timezone: 'America/Los_Angeles' });
    expect(result.status).toBe('ok');
    expect(result.text).toContain('*Daily report*');
    expect(result.text).toContain('Spend: 100');
    expect(sqlExec).toHaveBeenCalled();
    expect(overviewExec).toHaveBeenCalled();
    const sqlArgs = sqlExec.mock.calls[0][0];
    expect(sqlArgs.dateRange.startDate).toBe('2026-04-25');
    expect(sqlArgs.dateRange.fromMs).toBeTypeOf('number');
  });

  it('resolves StepRefs from earlier step results', async () => {
    const listExec = vi.fn(async () => ({ rows: [{ id: 7 }] }));
    const detailExec = vi.fn(async (args: any) => ({ id: args.id, name: 'foo' }));
    const registry = new ConnectorRegistry();
    registry.register(fakeConnector('a', [fakeTool('a.list', listExec), fakeTool('a.detail', detailExec)]));

    const plan: ReportPlan = {
      schemaVersion: 1,
      steps: [
        { alias: 'list', tool: 'a.list', args: {} },
        { alias: 'detail', tool: 'a.detail', args: { id: { $ref: 'list.rows[0].id' } }, dependsOn: ['list'] },
      ],
      output: { blocks: [{ type: 'text', text: 'name: ${detail.name}' }] },
    };

    const result = await executePlan({ plan, registry, runAt, timezone: 'America/Los_Angeles' });
    expect(detailExec).toHaveBeenCalledWith({ id: 7 });
    expect(result.text).toBe('name: foo');
    expect(result.status).toBe('ok');
  });

  it('marks status partial when one step fails but others render', async () => {
    const okExec = vi.fn(async () => ({ ok: true, n: 5 }));
    const badExec = vi.fn(async () => { throw new Error('boom'); });
    const registry = new ConnectorRegistry();
    registry.register(fakeConnector('a', [fakeTool('a.ok', okExec), fakeTool('a.bad', badExec)]));

    const plan: ReportPlan = {
      schemaVersion: 1,
      steps: [
        { alias: 'good', tool: 'a.ok', args: {} },
        { alias: 'broken', tool: 'a.bad', args: {} },
      ],
      output: {
        blocks: [
          { type: 'text', text: 'good=${good.n}' },
          { type: 'text', text: 'broken=${broken.n}' },
        ],
      },
    };

    const result = await executePlan({ plan, registry, runAt, timezone: 'America/Los_Angeles' });
    expect(result.status).toBe('partial');
    expect(result.text).toContain('good=5');
    expect(result.errors).toEqual([{ alias: 'broken', message: 'boom' }]);
  });

  it('expands a wow_compare_pt TimeRef into current+previous calls', async () => {
    const exec = vi.fn(async (args: any) => ({ tag: args.dateRange.startDate }));
    const registry = new ConnectorRegistry();
    registry.register(fakeConnector('a', [fakeTool('a.t', exec)]));

    const plan: ReportPlan = {
      schemaVersion: 1,
      steps: [
        { alias: 'wow', tool: 'a.t', args: { dateRange: { $time: 'wow_compare_pt' } } },
      ],
      output: { blocks: [{ type: 'text', text: 'cur=${wow.current.tag} prev=${wow.previous.tag}' }] },
    };

    const result = await executePlan({ plan, registry, runAt, timezone: 'America/Los_Angeles' });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('cur=2026-04-20 prev=2026-04-13');
  });
});
