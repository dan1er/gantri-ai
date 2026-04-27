import { resolveRef } from '../lib/valueRef.js';

const numFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Format a value resolved from `dataResults` for inclusion in prose/table cells.
 *  We don't know the intended format here (no `format: 'currency'` hint), so we
 *  do the best-effort thing: integers as-is, floats with up to 2 decimals,
 *  strings unchanged. Authors who need explicit formatting should use a
 *  kpi/table block instead. */
function formatTemplated(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.round(v) === v ? intFmt.format(v) : numFmt.format(v);
  }
  if (typeof v === 'string') {
    const n = Number(v);
    if (v !== '' && Number.isFinite(n)) return Math.round(n) === n ? intFmt.format(n) : numFmt.format(n);
    return v;
  }
  if (typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Resolve `${path.to.field}` and `` `path.to.field` `` (backticked, ≥2 dotted
 *  segments) against `dataResults`. Backtick form only resolves when the head
 *  matches a known dataResults key — protects code-style backticks like
 *  `` `useState` `` from being mangled. */
function resolveTemplates(md: string, dataResults: Record<string, unknown>): string {
  const dataKeys = new Set(Object.keys(dataResults ?? {}));
  let out = md.replace(/\$\{\s*([a-zA-Z_]\w*(?:\.[\w[\]]+)*)\s*\}/g, (_m, path: string) => {
    const v = resolveRef(path, dataResults);
    return v === undefined ? `[unresolved: ${path}]` : formatTemplated(v);
  });
  out = out.replace(/`([a-zA-Z_]\w*(?:\.[\w[\]]+){1,})`/g, (m, path: string) => {
    const head = path.split('.')[0].replace(/\[.*$/, '');
    if (!dataKeys.has(head)) return m; // not a data ref — leave the backticks alone
    const v = resolveRef(path, dataResults);
    return v === undefined ? `[unresolved: ${path}]` : formatTemplated(v);
  });
  return out;
}

/** Minimal pipe-table renderer. Given the lines of a markdown table (header,
 *  separator, body rows), returns an HTML table. Cells are rendered as their
 *  inner-markdown-converted HTML, so bold/italic/refs already resolved upstream
 *  show up correctly. */
function renderPipeTable(lines: string[]): string {
  const split = (line: string): string[] => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const [headerLine, , ...bodyLines] = lines;
  const headers = split(headerLine);
  const rows = bodyLines.map(split);
  const thead = `<thead><tr>${headers.map((h) => `<th class="text-left text-xs font-medium text-gray-600 uppercase tracking-wider px-3 py-2 border-b border-gray-200">${h}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${rows.map((r) => `<tr class="border-b border-gray-100 last:border-0">${r.map((c) => `<td class="px-3 py-2 text-sm text-gray-700 align-top">${c}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return `<table class="w-full border border-gray-200 rounded-md overflow-hidden my-3 bg-white">${thead}${tbody}</table>`;
}

/** Walk the markdown line-by-line; whenever we hit a header row followed by a
 *  `|---|---|…` separator, swallow the contiguous table block and emit HTML. */
function extractPipeTables(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const isHeader = /^\s*\|.*\|\s*$/.test(lines[i]);
    const sep = lines[i + 1];
    const isSep = !!sep && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(sep);
    if (isHeader && isSep) {
      const tableLines = [lines[i], sep];
      let j = i + 2;
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
        tableLines.push(lines[j]);
        j++;
      }
      out.push(renderPipeTable(tableLines));
      i = j - 1;
    } else {
      out.push(lines[i]);
    }
  }
  return out.join('\n');
}

export function TextBlock({ block, dataResults }: { block: { markdown: string }; dataResults?: Record<string, unknown> }) {
  // 1. Resolve template refs FIRST so resolved values can flow into table cells.
  const resolved = dataResults ? resolveTemplates(block.markdown, dataResults) : block.markdown;
  // 2. Pull pipe-tables out into HTML — must happen before line-break collapsing.
  let html = extractPipeTables(resolved);
  // 3. Inline markdown.
  html = html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  // 4. Headings — process line-by-line, skipping HTML lines we already emitted.
  html = html.split('\n').map((line) => {
    if (line.startsWith('<table')) return line;
    if (line.startsWith('### ')) return `<h3 class="text-lg font-semibold text-gantri-ink mt-6 mb-3">${line.slice(4)}</h3>`;
    if (line.startsWith('## ')) return `<h2 class="text-xl font-semibold text-gantri-ink mt-8 mb-4">${line.slice(3)}</h2>`;
    if (line.startsWith('# ')) return `<h1 class="text-2xl font-bold text-gantri-ink mt-8 mb-4">${line.slice(2)}</h1>`;
    return line;
  }).join('\n');
  // 5. Paragraph breaks — but don't insert <br/> inside our injected <table>.
  html = html.replace(/\n\n/g, '<br/><br/>').replace(/\n/g, '<br/>');
  // The <table> elements have leading <br/> from the surrounding line breaks;
  // strip those so the table sits flush in the flow.
  html = html.replace(/(<br\s*\/?>)+(<table)/g, '$2').replace(/(<\/table>)(<br\s*\/?>)+/g, '$1');
  return <div className="text-sm text-gray-700 leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />;
}
