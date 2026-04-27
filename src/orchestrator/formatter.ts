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
 *   - Markdown pipe-tables (header / separator / rows) → bullet list (Slack mrkdwn
 *     does NOT render tables, and ASCII-aligned tables drift between desktop and
 *     mobile fonts; tabular data should go to canvas — this is the in-chat fallback).
 *   - Code fences with tabular shape → bullet list (same reason).
 *   - Other code fences pass through verbatim.
 */
export function markdownToMrkdwn(md: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  let inFence = false;
  let fenceBuf: string[] = [];
  let fenceOpener = '```';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      if (!inFence) {
        inFence = true;
        fenceBuf = [];
        fenceOpener = line;
      } else {
        const tableBullets = maybeConvertCodeFenceToBulletList(fenceBuf);
        if (tableBullets) {
          out.push(...tableBullets);
        } else {
          out.push(fenceOpener);
          out.push(...fenceBuf);
          out.push(line);
        }
        inFence = false;
        fenceBuf = [];
      }
      continue;
    }
    if (inFence) { fenceBuf.push(line); continue; }

    // Markdown pipe-table detection: header + separator row → bullet list.
    if (isTableHeader(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tableLines: string[] = [line];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        tableLines.push(lines[j]);
        j++;
      }
      const rows = tableLines.map(splitRow).filter((r) => !r.every((c) => /^-+$/.test(c) || c === ''));
      out.push(...renderTableAsBullets(rows));
      i = j - 1;
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) continue;                 // drop hr

    let transformed = line;
    transformed = transformed.replace(/^(#{1,6})\s+(.*)$/, (_, _h, txt) => `*${txt.trim()}*`);
    // Bold+italic (***text*** in standard md) → *_text_* (Slack mrkdwn).
    // Must run BEFORE the bold-only rule so the non-greedy bold-only regex
    // doesn't half-match a triple-asterisk span and leave dangling `**`s.
    transformed = transformed.replace(/\*\*\*(.+?)\*\*\*/g, '*_$1_*');
    transformed = transformed.replace(/\*\*(.+?)\*\*/g, '*$1*');
    transformed = transformed.replace(/^(\s*)- /, '$1• ');

    out.push(transformed);
  }
  if (inFence) {
    out.push(fenceOpener);
    out.push(...fenceBuf);
  }
  return out.join('\n');
}

/**
 * If a code fence's content looks like tabular ASCII (≥2 non-empty lines, at least
 * 2 of them have an internal 2+-space gap typical of ASCII column padding), strip
 * the fence and emit each line as a bullet with collapsed whitespace. Returns null
 * if the content doesn't look tabular (then it stays as a code fence — preserves
 * real code blocks).
 *
 * We do NOT try to parse column boundaries here: ASCII spacing is ambiguous (the
 * LLM right-pads currency cells like "$   497", so 3-space runs can be inside a
 * cell, not between cells). Once the fence is stripped Slack renders in proportional
 * font and collapses runs of whitespace anyway, so just bulleting each line gives a
 * readable result without losing data — and it's identical on mobile and desktop.
 */
function maybeConvertCodeFenceToBulletList(fenceLines: string[]): string[] | null {
  if (fenceLines.length < 2) return null;
  const nonEmpty = fenceLines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 2) return null;
  const linesWithMultiSpace = nonEmpty.filter((l) => / {2,}/.test(l));
  if (linesWithMultiSpace.length < 2) return null;
  return nonEmpty.map((l) => `• ${l.trim().replace(/\s+/g, ' ')}`);
}

/**
 * Render parsed rows as a bullet list. The first row is treated as the header
 * and dropped (its values are usually field names like "Tipo / Ord / Revenue"
 * that aren't useful as a bullet). Each subsequent row becomes:
 *   `• *<col1>*: <col2>, <col3>, …`
 * so the first column reads as a label and the rest follows as a comma list.
 */
function renderTableAsBullets(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const dataRows = rows.length >= 2 ? rows.slice(1) : rows;
  return dataRows.map((cells) => {
    const [first, ...rest] = cells;
    const label = (first ?? '').trim();
    const values = rest.map((c) => c.trim()).filter((c) => c.length > 0);
    if (values.length === 0) return `• ${label}`;
    return `• *${label}*: ${values.join(', ')}`;
  });
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
