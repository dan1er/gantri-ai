import { describe, it, expect } from 'vitest';
import { markdownToSlackBlocks } from '../../../src/orchestrator/formatter.js';

describe('markdownToSlackBlocks', () => {
  it('wraps plain paragraphs in section blocks', () => {
    const blocks = markdownToSlackBlocks('Hello world.\n\nSecond line.');
    expect(blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'Hello world.' } },
      { type: 'section', text: { type: 'mrkdwn', text: 'Second line.' } },
    ]);
  });

  it('converts bullet lists to a single section with bullets preserved', () => {
    const blocks = markdownToSlackBlocks('- a\n- b\n- c');
    expect((blocks[0] as any).text.text).toBe('• a\n• b\n• c');
  });

  it('keeps fenced code blocks intact inside a section (Slack renders them)', () => {
    const md = '```\nrow1\nrow2\n```';
    const blocks = markdownToSlackBlocks(md);
    expect((blocks[0] as any).text.text).toContain('```\nrow1\nrow2\n```');
  });

  it('appends a context footer when provided', () => {
    const blocks = markdownToSlackBlocks('Hi.', { footer: 'Source: Northbeam' });
    const last = blocks[blocks.length - 1] as any;
    expect(last.type).toBe('context');
    expect(last.elements[0].text).toBe('Source: Northbeam');
  });
});
