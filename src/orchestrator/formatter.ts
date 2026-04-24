export interface FormatterOptions {
  footer?: string;
}

type Block =
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'context'; elements: Array<{ type: 'mrkdwn'; text: string }> };

export function markdownToSlackBlocks(markdown: string, opts: FormatterOptions = {}): Block[] {
  const paragraphs = splitParagraphs(markdown);
  const blocks: Block[] = paragraphs.map((p) => ({
    type: 'section',
    text: { type: 'mrkdwn', text: transformBulletChars(p) },
  }));
  if (opts.footer) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: opts.footer }] });
  }
  return blocks;
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

function transformBulletChars(block: string): string {
  return block
    .split('\n')
    .map((l) => (l.startsWith('- ') ? `• ${l.slice(2)}` : l))
    .join('\n');
}
