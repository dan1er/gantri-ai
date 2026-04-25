import type { OutputSpec, BlockSpec, ColumnSpec } from './plan-types.js';
import { formatCell } from './formatters.js';
import { getByPath } from './step-refs.js';

export interface RenderedAttachment {
  filename: string;
  content: string;          // raw text content
  format: 'csv';
}

export interface RenderedOutput {
  text: string;             // Slack mrkdwn
  attachments: RenderedAttachment[];
}

export function renderOutput(spec: OutputSpec, aliasMap: Record<string, unknown>): RenderedOutput {
  const parts: string[] = [];
  const attachments: RenderedAttachment[] = [];
  for (const block of spec.blocks) {
    const rendered = renderBlock(block, aliasMap, attachments);
    if (rendered) parts.push(rendered);
  }
  return { text: parts.join('\n\n'), attachments };
}

function renderBlock(
  block: BlockSpec,
  aliasMap: Record<string, unknown>,
  attachments: RenderedAttachment[],
): string | null {
  switch (block.type) {
    case 'header':
      return `*${block.text}*`;
    case 'text':
      return interpolate(block.text, aliasMap);
    case 'table':
      return renderTable(block.from, block.columns, block.maxRows ?? 50, aliasMap);
    case 'csv_attachment': {
      const rows = pickRows(block.from, aliasMap);
      attachments.push({
        filename: block.filename,
        content: rowsToCsv(rows),
        format: 'csv',
      });
      return null;
    }
  }
}

function interpolate(template: string, aliasMap: Record<string, unknown>): string {
  return template.replace(/\$\{([^}]+)\}/g, (_match, path: string) => {
    const v = getByPath(aliasMap, path.trim());
    if (v === undefined || v === null) return '—';
    // Numbers like 627.2000000000001 leak from float arithmetic upstream.
    // Always cap at 2 decimals; integers pass through unchanged.
    if (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v)) {
      return v.toFixed(2);
    }
    return String(v);
  });
}

function renderTable(
  from: string,
  columns: ColumnSpec[],
  maxRows: number,
  aliasMap: Record<string, unknown>,
): string {
  const rows = pickRows(from, aliasMap).slice(0, maxRows);
  const headerCells = columns.map((c) => c.header);
  const bodyCells = rows.map((row) => columns.map((c) => formatCell(getByPath(row, c.field), c.format)));
  // Align by max column width.
  const widths = headerCells.map((h, i) =>
    Math.max(h.length, ...bodyCells.map((r) => r[i].length)),
  );
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  const lines = [
    headerCells.map((h, i) => pad(h, widths[i])).join('  '),
    widths.map((w) => '─'.repeat(w)).join('  '),
    ...bodyCells.map((r) => r.map((c, i) => pad(c, widths[i])).join('  ')),
  ];
  return '```\n' + lines.join('\n') + '\n```';
}

function pickRows(from: string, aliasMap: Record<string, unknown>): Array<Record<string, unknown>> {
  const v = getByPath(aliasMap, from);
  if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
  return [];
}

function rowsToCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const headers = Array.from(
    rows.reduce((acc, r) => {
      for (const k of Object.keys(r)) acc.add(k);
      return acc;
    }, new Set<string>()),
  );
  const escape = (s: string) => /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const lines = [
    headers.join(','),
    ...rows.map((r) =>
      headers
        .map((h) => {
          const v = (r as any)[h];
          if (v === undefined || v === null) return '';
          return escape(String(v));
        })
        .join(','),
    ),
  ];
  return lines.join('\n');
}
