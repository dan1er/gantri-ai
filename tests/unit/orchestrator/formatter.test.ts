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

  it('converts LLM pre-formatted ASCII tables in code fences to a bullet list (no fragile column parsing)', () => {
    // The LLM keeps emitting ASCII tables despite prompt instructions, and any
    // alignment we try to recompute drifts on mobile because Slack mobile/desktop
    // monospace fonts disagree on character widths. We don't try to parse columns
    // either — ASCII spacing is ambiguous (currency cells like "$   497" right-pad
    // their content) — we just strip the fence, bullet each line, and collapse
    // internal whitespace. Slack renders proportional fonts and collapses spaces
    // anyway, so the result is identical on every device.
    const md = [
      '```',
      'Tipo         Ord  Revenue',
      'Wholesale    10   $11,466',
      'Wholesale Ref 3   $   497',
      '```',
    ].join('\n');
    const blocks = markdownToSlackBlocks(md);
    const text = (blocks[0] as any).text.text;
    expect(text).not.toContain('```');
    expect(text).toContain('• Tipo Ord Revenue');
    expect(text).toContain('• Wholesale 10 $11,466');
    expect(text).toContain('• Wholesale Ref 3 $ 497');
  });

  it('converts markdown pipe-tables to bullet lists too', () => {
    const md = [
      '| Campaign | Spend | ROAS |',
      '|---|---|---|',
      '| Performance Max | **$1,224** | 1.09x |',
      '| Catch All | $430 | 0.62x |',
    ].join('\n');
    const blocks = markdownToSlackBlocks(md);
    const text = (blocks[0] as any).text.text;
    expect(text).not.toContain('```');
    expect(text).not.toContain('|---|');
    expect(text).toContain('• *Performance Max*: $1,224, 1.09x');
    expect(text).toContain('• *Catch All*: $430, 0.62x');
  });

  it('handles emojis/em-dashes in pipe-table cells without alignment issues (since we no longer try to align)', () => {
    const md = [
      '| Order | Cause |',
      '|---|---|',
      '| 53107 | 🚨 Deadline missed (7d) |',
      '| 53109 | gunk — layer lines |',
    ].join('\n');
    const blocks = markdownToSlackBlocks(md);
    const text = (blocks[0] as any).text.text;
    expect(text).toContain('• *53107*: 🚨 Deadline missed (7d)');
    expect(text).toContain('• *53109*: gunk — layer lines');
  });
});
