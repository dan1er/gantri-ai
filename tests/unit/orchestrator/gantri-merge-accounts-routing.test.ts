import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Orchestrator } from '../../../src/orchestrator/orchestrator.js';
import { ConnectorRegistry } from '../../../src/connectors/base/registry.js';
import type { Connector, ToolDef } from '../../../src/connectors/base/connector.js';

// Build a registry that exposes BOTH gantri.update_customer_email and
// gantri.merge_customer_accounts plus feedback.flag_response so the LLM has
// a realistic choice between them. The merge-routing test asserts the model
// (via its prompt + the orchestrator's tool dispatch) routes to the new
// merge tool, NOT to update_customer_email or feedback.flag_response.
function buildRegistry() {
  const updateEmail: ToolDef = {
    name: 'gantri.update_customer_email',
    description: 'update customer email',
    schema: z.object({
      orderId: z.number().optional(),
      oldEmail: z.string().optional(),
      newEmail: z.string(),
      syncKlaviyo: z.boolean().default(true),
      confirm: z.boolean().default(false),
    }).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async () => ({ kind: 'awaiting_confirmation', target: 'staging' })),
  };
  const mergeAccounts: ToolDef = {
    name: 'gantri.merge_customer_accounts',
    description: 'merge duplicate customer accounts',
    schema: z.object({
      oldEmail: z.string(),
      newEmail: z.string(),
      confirm: z.boolean().default(false),
    }).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async (args) => {
      const a = args as any;
      if (!a.confirm) {
        return {
          kind: 'awaiting_confirmation',
          target: 'staging',
          oldUserId: 100,
          newUserId: 200,
          oldEmail: a.oldEmail,
          newEmail: a.newEmail,
          ordersToMove: 1,
          klaviyoConflict: false,
          message: '_(staging mode)_ About to merge ... Reply yes to confirm.',
        };
      }
      return {
        ok: true,
        target: 'staging',
        oldUserId: 100,
        newUserId: 200,
        ordersMoved: 1,
        message: '_(staging)_ Done. Moved 1 order.',
      };
    }),
  };
  const flagResponse: ToolDef = {
    name: 'feedback.flag_response',
    description: 'flag a response to maintainer',
    schema: z.object({ reason: z.string().optional() }).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async () => ({ ok: true })),
  };
  const conn: Connector = {
    name: 'gantri',
    tools: [updateEmail, mergeAccounts],
    async healthCheck() { return { ok: true }; },
  };
  const feedbackConn: Connector = {
    name: 'feedback',
    tools: [flagResponse],
    async healthCheck() { return { ok: true }; },
  };
  const r = new ConnectorRegistry();
  r.register(conn);
  r.register(feedbackConn);
  return { registry: r, updateEmail, mergeAccounts, flagResponse };
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

describe('gantri.merge_customer_accounts — orchestrator routing (LLM mocked)', () => {
  it('Han Nguyen duplicate-account ask routes to gantri.merge_customer_accounts (NOT update_customer_email, NOT flag_response)', async () => {
    const { registry, mergeAccounts, updateEmail, flagResponse } = buildRegistry();
    const claude: any = fakeClaude([
      {
        content: [{
          type: 'tool_use',
          id: 't1',
          name: 'gantri_merge_customer_accounts',
          input: {
            oldEmail: 'h.h.bnguyen2001@gmail.comb',
            newEmail: 'h.bnguyen2001@gmail.com',
          },
        }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: '_(staging mode)_ About to merge h.h.bnguyen2001@gmail.comb (Han Nguyen, 1 order) INTO h.bnguyen2001@gmail.com. Reply yes to confirm.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({
      question: 'Han Nguyen has two accounts, merge h.h.bnguyen2001@gmail.comb into h.bnguyen2001@gmail.com',
      threadHistory: [],
    });

    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].name).toBe('gantri.merge_customer_accounts');
    expect((mergeAccounts.execute as any).mock.calls[0][0]).toMatchObject({
      oldEmail: 'h.h.bnguyen2001@gmail.comb',
      newEmail: 'h.bnguyen2001@gmail.com',
      confirm: false,
    });
    // Critical anti-regression: must NOT route to update_customer_email or
    // feedback.flag_response. Both were plausible prior to the merge tool.
    expect(updateEmail.execute).not.toHaveBeenCalled();
    expect(flagResponse.execute).not.toHaveBeenCalled();
    expect(out.response).toMatch(/merge/i);
  });

  it('Spanish "fusionar cuentas" routes to gantri.merge_customer_accounts', async () => {
    const { registry, mergeAccounts } = buildRegistry();
    const claude: any = fakeClaude([
      {
        content: [{
          type: 'tool_use',
          id: 't2',
          name: 'gantri_merge_customer_accounts',
          input: { oldEmail: 'old@x.com', newEmail: 'new@x.com' },
        }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: '_(staging mode)_ Voy a fusionar las cuentas...' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({
      question: 'fusionar cuentas duplicadas: old@x.com en new@x.com',
      threadHistory: [],
    });
    expect(out.toolCalls[0].name).toBe('gantri.merge_customer_accounts');
    expect((mergeAccounts.execute as any).mock.calls[0][0]).toMatchObject({
      oldEmail: 'old@x.com',
      newEmail: 'new@x.com',
    });
  });

  it('confirm path: user replies "yes" → second tool call with confirm:true', async () => {
    const { registry, mergeAccounts } = buildRegistry();
    const claude: any = fakeClaude([
      {
        content: [{
          type: 'tool_use',
          id: 't3',
          name: 'gantri_merge_customer_accounts',
          input: { oldEmail: 'old@x.com', newEmail: 'new@x.com', confirm: true },
        }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: '_(staging)_ Done. Moved 1 order.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({
      question: 'yes',
      threadHistory: [{
        question: 'merge accounts: old@x.com into new@x.com',
        response: '_(staging mode)_ About to merge old@x.com (1 order) INTO new@x.com. Reply yes to confirm.',
      }],
    });
    expect((mergeAccounts.execute as any).mock.calls[0][0]).toMatchObject({
      oldEmail: 'old@x.com',
      newEmail: 'new@x.com',
      confirm: true,
    });
    expect(out.response).toMatch(/Done/);
  });
});
