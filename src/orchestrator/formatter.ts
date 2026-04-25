import stringWidth from 'string-width';

export interface FormatterOptions {
  footer?: string;
}

type Block =
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'context'; elements: Array<{ type: 'mrkdwn'; text: string }> };

/** Slack section blocks reject text > 3000 chars with `invalid_blocks`.
 *  We use 2800 to leave headroom for footers + fence chars added during splits. */
const SECTION_MAX_CHARS = 2800;

export function markdownToSlackBlocks(markdown: string, opts: FormatterOptions = {}): Block[] {
  const cleaned = markdownToMrkdwn(markdown);
  const paragraphs = splitParagraphs(cleaned);
  const blocks: Block[] = [];
  for (const p of paragraphs) {
    for (const chunk of splitOverlongParagraph(p, SECTION_MAX_CHARS)) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
    }
  }
  if (opts.footer) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: opts.footer }] });
  }
  return blocks;
}

/**
 * If a paragraph exceeds Slack's 3000-char-per-section limit, split it into
 * multiple sections on line boundaries while preserving any open code fences
 * (close + reopen ``` across the split so each piece is independently valid
 * mrkdwn).
 */
function splitOverlongParagraph(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const lines = text.split('\n');
  const out: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  let bufLen = 0;
  const flush = () => {
    if (buf.length === 0) return;
    let chunk = buf.join('\n');
    // If we're mid-fence, close the chunk's fence and remember to re-open next chunk.
    if (inFence) chunk += '\n```';
    out.push(chunk);
    buf = [];
    bufLen = 0;
    if (inFence) {
      buf.push('```');
      bufLen = 4;
    }
  };
  for (const line of lines) {
    const lineLen = line.length + 1; // include newline
    if (bufLen + lineLen > maxChars && buf.length > 0) flush();
    if (line.startsWith('```')) inFence = !inFence;
    buf.push(line);
    bufLen += lineLen;
  }
  if (buf.length > 0) {
    let chunk = buf.join('\n');
    if (inFence) chunk += '\n```';
    out.push(chunk);
  }
  return out;
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

/**
 * Pad `cell` with trailing spaces until its rendered width (via string-width) is `target`.
 * `string.padEnd` uses `.length` (UTF-16 code units), which silently misaligns columns
 * whenever a cell contains an emoji, em-dash, ellipsis, or any wide/zero-width character.
 * Slack mobile and desktop monospace fonts disagree on those characters' widths, so the
 * misalignment shows up only on one platform.
 */
function padToWidth(cell: string, target: number): string {
  const pad = target - stringWidth(cell);
  return pad <= 0 ? cell : cell + ' '.repeat(pad);
}

function renderAsciiTable(rows: string[]): string[] {
  const parsed = rows.map(splitRow).filter((r) => !r.every((c) => /^-+$/.test(c) || c === ''));
  if (parsed.length === 0) return [];
  const ncol = Math.max(...parsed.map((r) => r.length));
  const widths = new Array(ncol).fill(0);
  for (const r of parsed) for (let c = 0; c < r.length; c++) widths[c] = Math.max(widths[c], stringWidth(r[c]));
  return parsed.map((r) =>
    r.map((cell, c) => padToWidth(cell, widths[c])).join('  ').trimEnd(),
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
