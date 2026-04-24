export interface FormatterOptions {
  footer?: string;
}

type Block =
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'context'; elements: Array<{ type: 'mrkdwn'; text: string }> };

export function markdownToSlackBlocks(markdown: string, opts: FormatterOptions = {}): Block[] {
  const cleaned = markdownToMrkdwn(markdown);
  const paragraphs = splitParagraphs(cleaned);
  const blocks: Block[] = paragraphs.map((p) => ({
    type: 'section',
    text: { type: 'mrkdwn', text: p },
  }));
  if (opts.footer) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: opts.footer }] });
  }
  return blocks;
}

/**
 * Transform standard markdown into Slack's mrkdwn dialect:
 *   - `**bold**` → `*bold*`
 *   - `# heading` lines → `*heading*`
 *   - `---` horizontal rules → removed
 *   - `- item` bullets → `• item`
 *   - Markdown pipe-tables (header / separator / rows) → a triple-backtick code block
 *     with ASCII-aligned columns (Slack renders fixed-width code blocks).
 *   - Code fences are preserved verbatim.
 */
export function markdownToMrkdwn(md: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) { out.push(line); continue; }

    // Markdown pipe-table detection: header + separator row
    if (isTableHeader(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tableLines: string[] = [line];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        tableLines.push(lines[j]);
        j++;
      }
      out.push('```');
      out.push(...renderAsciiTable(tableLines));
      out.push('```');
      i = j - 1;
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) continue;                 // drop hr

    let transformed = line;
    transformed = transformed.replace(/^(#{1,6})\s+(.*)$/, (_, _h, txt) => `*${txt.trim()}*`);
    transformed = transformed.replace(/\*\*(.+?)\*\*/g, '*$1*');
    transformed = transformed.replace(/^(\s*)- /, '$1• ');

    out.push(transformed);
  }
  return out.join('\n');
}

function isTableHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.includes('|', 1);
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]+\|?\s*$/.test(line) && /---/.test(line);
}

function splitRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim().replace(/\*\*(.+?)\*\*/g, '$1'));
}

function renderAsciiTable(rows: string[]): string[] {
  const parsed = rows.map(splitRow).filter((r) => !r.every((c) => /^-+$/.test(c) || c === ''));
  if (parsed.length === 0) return [];
  const ncol = Math.max(...parsed.map((r) => r.length));
  const widths = new Array(ncol).fill(0);
  for (const r of parsed) for (let c = 0; c < r.length; c++) widths[c] = Math.max(widths[c], r[c].length);
  return parsed.map((r) =>
    r.map((cell, c) => cell.padEnd(widths[c], ' ')).join('  ').trimEnd(),
  );
}

function splitParagraphs(md: string): string[] {
  const out: string[] = [];
  const lines = md.split('\n');
  let buf: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.startsWith('```')) inFence = !inFence;
    if (!inFence && line.trim() === '') {
      if (buf.length) { out.push(buf.join('\n')); buf = []; }
    } else {
      buf.push(line);
    }
  }
  if (buf.length) out.push(buf.join('\n'));
  return out;
}
