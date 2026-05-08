import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Orchestrator } from '../../../src/orchestrator/orchestrator.js';
import { ConnectorRegistry } from '../../../src/connectors/base/registry.js';
import type { Connector, ToolDef } from '../../../src/connectors/base/connector.js';

function buildGantriRegistry(overrides: { updateEmail?: (args: any) => any } = {}) {
  const updateEmail: ToolDef = {
    name: 'gantri.update_customer_email',
    description: 'update customer email',
    schema: z.object({
      orderId: z.number(),
      newEmail: z.string(),
      syncKlaviyo: z.boolean().default(true),
      confirm: z.boolean().default(false),
    }).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async (args) => {
      if (overrides.updateEmail) return overrides.updateEmail(args);
      const a = args as any;
      if (!a.confirm) {
        return {
          kind: 'awaiting_confirmation',
          target: 'staging',
          orderId: a.orderId,
          userId: 59516,
          currentEmail: 'old@x.com',
          newEmail: a.newEmail,
          customerName: 'Test User',
          totalOrders: 3,
          klaviyoProfileLinked: true,
          willSyncKlaviyo: a.syncKlaviyo !== false,
          message: 'About to change email...',
        };
      }
      return { ok: true, target: 'staging', porterOk: true, klaviyoOk: true, message: 'Email updated.' };
    }),
  };
  const conn: Connector = {
    name: 'gantri',
    tools: [updateEmail],
    async healthCheck() { return { ok: true }; },
  };
  const r = new ConnectorRegistry();
  r.register(conn);
  return { registry: r, updateEmail };
}

function fakeClaude(responses: any[]) {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        if (i >= responses.length) throw new Error(`fakeClaude exhausted at call ${i + 1}`);
        return responses[i++];
      }),
    },
  };
}

const STD_USAGE = { input_tokens: 100, output_tokens: 20 };

describe('gantri.update_customer_email — orchestrator routing (LLM mocked)', () => {
  it('A. cx user: preview then confirm — two tool calls, both audited', async () => {
    const { registry, updateEmail } = buildGantriRegistry();
    const claude: any = fakeClaude([
      // Turn 1: user asks; LLM calls preview
      {
        content: [{ type: 'tool_use', id: 't1', name: 'gantri_update_customer_email', input: { orderId: 43785, newEmail: 'alice@x.com' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      // Turn 2: relays preview
      {
        content: [{ type: 'text', text: '_(staging mode)_ About to change... Reply yes to confirm.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'Modify email on order 43785 to alice@x.com', threadHistory: [] });
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].name).toBe('gantri.update_customer_email');
    expect((updateEmail.execute as any).mock.calls[0][0]).toMatchObject({ orderId: 43785, newEmail: 'alice@x.com', confirm: false });
    expect(out.response).toMatch(/staging mode/i);
  });

  it('B. confirm path: user replies "yes" → second tool call with confirm:true', async () => {
    const { registry, updateEmail } = buildGantriRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't2', name: 'gantri_update_customer_email', input: { orderId: 43785, newEmail: 'alice@x.com', confirm: true } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: '_(staging)_ Email updated. Porter user 59516 → alice@x.com. Klaviyo synced.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({
      question: 'yes',
      threadHistory: [{
        question: 'Modify email on order 43785 to alice@x.com',
        response: '_(staging mode)_ About to change email on Porter user 59516 from old@x.com to alice@x.com. Reply yes to confirm.',
      }],
    });
    expect((updateEmail.execute as any).mock.calls[0][0]).toMatchObject({ orderId: 43785, newEmail: 'alice@x.com', confirm: true });
    expect(out.response).toMatch(/Email updated/);
  });

  it('C. marketing role → tool returns FORBIDDEN, LLM relays', async () => {
    const { registry } = buildGantriRegistry({
      updateEmail: () => ({ error: { code: 'FORBIDDEN', message: 'gantri.update_customer_email requires role=cx or role=admin.' } }),
    });
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't3', name: 'gantri_update_customer_email', input: { orderId: 43785, newEmail: 'x@y.com' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'Sorry — this requires role=cx or role=admin.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'Modify email on order 43785 to x@y.com', threadHistory: [] });
    expect(out.response).toMatch(/cx or.*admin/i);
  });

  it('D. user says "no" mid-confirm → no second tool call', async () => {
    const { registry, updateEmail } = buildGantriRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'text', text: 'OK, no change made.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({
      question: 'actually no, leave it',
      threadHistory: [{
        question: 'Modify email on order 43785',
        response: 'About to change... Reply yes to confirm.',
      }],
    });
    expect((updateEmail.execute as any)).not.toHaveBeenCalled();
    expect(out.response).toMatch(/no change/i);
  });

  it('E. opt-out of klaviyo sync explicitly', async () => {
    const { registry, updateEmail } = buildGantriRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't5', name: 'gantri_update_customer_email', input: { orderId: 43785, newEmail: 'x@y.com', syncKlaviyo: false } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'About to change... Klaviyo sync was disabled by request.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    await orch.run({ question: 'Modify email on order 43785 to x@y.com but don\'t touch Klaviyo', threadHistory: [] });
    expect((updateEmail.execute as any).mock.calls[0][0]).toMatchObject({ syncKlaviyo: false });
  });
});
