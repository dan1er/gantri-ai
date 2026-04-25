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

  it('converts **bold** (standard markdown) to *bold* (Slack mrkdwn)', () => {
    const blocks = markdownToSlackBlocks('Spend was **$2,400** last week.');
    expect((blocks[0] as any).text.text).toBe('Spend was *$2,400* last week.');
  });

  it('converts markdown headings to bold lines', () => {
    const blocks = markdownToSlackBlocks('# Summary\n\nTotal: $100');
    expect((blocks[0] as any).text.text).toBe('*Summary*');
    expect((blocks[1] as any).text.text).toBe('Total: $100');
  });

  it('drops --- horizontal rules', () => {
    const blocks = markdownToSlackBlocks('Before\n\n---\n\nAfter');
    const texts = blocks.map((b: any) => b.text.text);
    expect(texts).toEqual(['Before', 'After']);
  });

  it('realigns LLM pre-formatted ASCII tables when columns drift (e.g. "Wholesale Ref" sticks out past "Wholesale")', () => {
    // This is the actual bug from the screenshot: the LLM hand-pads each row,
    // but its math is per-row, so longer first-column cells push the data column
    // out of alignment with shorter rows above.
    const md = [
      '```',
      'Tipo         Ord  Revenue',
      'Wholesale    10   $11,466',
      'Wholesale Ref 3   $   497',
      'Trade Refund  1   $ 1,339',
      '```',
    ].join('\n');
    const blocks = markdownToSlackBlocks(md);
    const text = (blocks[0] as any).text.text;
    const lines = text.split('\n').filter((l: string) => l && !l.startsWith('```'));
    // After realignment, every row's second column ("Ord") must start at the same column.
    const ordStarts = lines.map((l: string) => {
      const m = l.match(/^(.*?)( {2,})/);
      return m ? m[1].length + m[2].length : -1;
    });
    expect(ordStarts.every((n: number) => n === ordStarts[0])).toBe(true);
  });

  it('aligns ASCII columns by visual width, not UTF-16 length, so cells with emojis/em-dashes line up on every device', () => {
    // Emojis (🚨 = 2 cols visual, length 2), em-dash (— = 1 col visual, length 1),
    // and ellipsis (… = 1 col visual, length 1) used to misalign because padEnd
    // pads to .length; the regression repro is "🚨 Deadline missed (7d)" sitting
    // next to plain ASCII rows.
    const md = [
      '| Order | Cause |',
      '|---|---|',
      '| 53107 | 🚨 Deadline missed (7d) |',
      '| 53108 | Reworked 4× |',
      '| 53109 | gunk — layer lines |',
    ].join('\n');
    const blocks = markdownToSlackBlocks(md);
    const text = (blocks[0] as any).text.text;
    const lines = text.split('\n').filter((l: string) => l && !l.startsWith('```'));
    // Every rendered line must end the first column at the same visual column.
    // Use a regex that matches the gap between cells (≥2 spaces).
    const firstColEnds = lines.map((l: string) => {
      const m = l.match(/^(.*?)( {2,})/);
      return m ? m[1].length + m[2].length : -1;
    });
    expect(firstColEnds.every((n: number) => n === firstColEnds[0])).toBe(true);
  });

  it('converts markdown pipe-tables into ASCII code blocks', () => {
    const md = [
      '| Campaign | Spend | ROAS |',
      '|---|---|---|',
      '| Performance Max | **$1,224** | 1.09x |',
      '| Catch All | $430 | 0.62x |',
    ].join('\n');
    const blocks = markdownToSlackBlocks(md);
    const text = (blocks[0] as any).text.text;
    expect(text.startsWith('```')).toBe(true);
    expect(text.endsWith('```')).toBe(true);
    expect(text).toContain('Performance Max  $1,224');
    expect(text).toContain('Catch All');
    expect(text).not.toContain('**');
    expect(text).not.toContain('|---|');
  });
});
