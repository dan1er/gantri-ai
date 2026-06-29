import { describe, it, expect, vi } from 'vitest';
import { reviewFlc, FlcReviewParseError } from '../../../src/flc/flc-review-service.js';

function textResponse(text: string) {
  return { content: [{ type: 'text', text }] } as never;
}

function makeClaude(responses: string[]) {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(textResponse(r));
  return { claude: { messages: { create } }, create };
}

const baseDeps = (claude: { messages: { create: ReturnType<typeof vi.fn> } }) => ({
  claude,
  model: 'claude-test',
  fallbackModels: [],
  reviewStandard: 'THE STANDARD',
});

describe('reviewFlc', () => {
  it('parses valid JSON findings', async () => {
    const findings = {
      findings: [
        {
          id: 'F1',
          severity: 'Must Fix',
          area: 'Functional',
          section: 'Overview',
          anchor: 'the gap',
          message: 'lead with the user',
        },
      ],
    };
    const { claude, create } = makeClaude([JSON.stringify(findings)]);
    const result = await reviewFlc(baseDeps(claude), { pageMarkdown: '# FLC', areas: ['Functional'] });
    expect(create).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'F1', severity: 'Must Fix', area: 'Functional' });
  });

  it('strips markdown code fences around the JSON', async () => {
    const wrapped = '```json\n{"findings": []}\n```';
    const { claude } = makeClaude([wrapped]);
    const result = await reviewFlc(baseDeps(claude), { pageMarkdown: 'x', areas: ['Technical'] });
    expect(result).toEqual([]);
  });

  it('reflects the selected areas in the system prompt', async () => {
    const { claude, create } = makeClaude(['{"findings": []}']);
    await reviewFlc(baseDeps(claude), { pageMarkdown: 'x', areas: ['Functional', 'Security'] });
    const callArg = create.mock.calls[0][0];
    expect(callArg.system).toContain('THE STANDARD');
    expect(callArg.system).toContain('Functional, Security');
    // areas NOT selected should not appear in the allowed-area list line
    expect(callArg.system).toContain('review ONLY these areas: Functional, Security');
  });

  it('retries once on malformed JSON, then succeeds', async () => {
    const good = '{"findings": [{"id":"F1","severity":"Should Fix","area":"Testing","section":"s","anchor":"a","message":"m"}]}';
    const { claude, create } = makeClaude(['not json at all', good]);
    const result = await reviewFlc(baseDeps(claude), { pageMarkdown: 'x', areas: ['Testing'] });
    expect(create).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
  });

  it('throws FlcReviewParseError after the retry still fails', async () => {
    const { claude, create } = makeClaude(['garbage one', 'garbage two']);
    await expect(
      reviewFlc(baseDeps(claude), { pageMarkdown: 'x', areas: ['Functional'] }),
    ).rejects.toBeInstanceOf(FlcReviewParseError);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
