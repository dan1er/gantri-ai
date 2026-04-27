import { describe, it, expect, vi } from 'vitest';
import { compileLiveReport } from '../../../../src/connectors/live-reports/compiler.js';

function mockClaude(responses: string[]) {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: responses[i++] ?? responses[responses.length - 1] }],
        usage: { input_tokens: 100, output_tokens: 200 },
      })),
    },
  };
}

const validSpec = JSON.stringify({
  version: 1,
  title: 'Sample Report',
  data: [{ id: 'a', tool: 'gantri.order_stats', args: {} }],
  ui: [{ type: 'kpi', label: 'Orders', value: 'a.totalOrders', format: 'number' }],
});

describe('compileLiveReport', () => {
  it('returns a parsed spec on first valid response', async () => {
    const claude = mockClaude([validSpec]);
    const out = await compileLiveReport({ intent: 'show order count', claude: claude as never, model: 'claude-sonnet-4-6', toolCatalog: 'fake catalog' });
    expect(out.spec.title).toBe('Sample Report');
    expect(claude.messages.create).toHaveBeenCalledTimes(1);
  });

  it('retries once when first response is invalid JSON, then succeeds', async () => {
    const claude = mockClaude(['not json {', validSpec]);
    const out = await compileLiveReport({ intent: 'x', claude: claude as never, model: 'claude-sonnet-4-6', toolCatalog: 'cat' });
    expect(out.spec.title).toBe('Sample Report');
    expect(claude.messages.create).toHaveBeenCalledTimes(2);
  });

  it('fails after 2 invalid attempts', async () => {
    const claude = mockClaude(['junk', 'still junk']);
    await expect(
      compileLiveReport({ intent: 'x', claude: claude as never, model: 'claude-sonnet-4-6', toolCatalog: 'cat' }),
    ).rejects.toThrow(/compile.*failed/i);
  });
});
