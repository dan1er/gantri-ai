import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../../src/orchestrator/prompts.js';

describe('buildSystemPrompt', () => {
  it("includes today's date, tool names, and the metric catalog summary", () => {
    const prompt = buildSystemPrompt({
      todayISO: '2026-04-24',
      toolNames: ['northbeam.overview', 'northbeam.sales'],
      catalogSummary: '- `spend` (Spend): Marketing dollars spent.',
    });
    expect(prompt).toContain('2026-04-24');
    expect(prompt).toContain('northbeam.overview');
    expect(prompt).toContain('northbeam.sales');
    expect(prompt).toContain('`spend`');
  });
});
