import { z } from 'zod';
import type { WebClient } from '@slack/web-api';
import type { Connector, ToolDef } from '../base/connector.js';
import type { ActorContext } from '../../orchestrator/orchestrator.js';
import { formatCell } from '../../reports/formatters.js';
import { getByPath } from '../../reports/step-refs.js';
import type { ColumnSpec } from '../../reports/plan-types.js';
import { logger } from '../../logger.js';

/** ColumnSpec.format codes — kept narrow because the connector formatter is
 *  the single source of truth for cell rendering. */
type ColumnFmt = NonNullable<ColumnSpec['format']>;

const FORMAT_TO_EXT: Record<string, string> = {
  markdown: 'md',
  csv: 'csv',
  text: 'txt',
};

const AttachFileArgs = z.object({
  format: z.enum(['markdown', 'csv', 'text']),
  /** File name shown in Slack. If no extension or the extension does not match the
   * format, it is appended/fixed automatically. */
  filename: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[\w.\-]+$/, 'filename may only contain letters, digits, dash, underscore, and dot'),
  /** A short human-readable title shown alongside the file in Slack. */
  title: z.string().max(200).optional(),
  /** Full file contents. Keep under ~2MB; large dumps should be filtered server-side first. */
  content: z.string().min(1).max(2_000_000),
});
type AttachFileArgs = z.infer<typeof AttachFileArgs>;

export interface ReportAttachment extends AttachFileArgs {
  /** Filename guaranteed to have the correct extension for the declared format. */
  normalizedFilename: string;
}

/** Per-table spec inside `reports.create_canvas`. The connector renders each
 *  one as a GitHub-flavored markdown pipe-table and substitutes the
 *  `<<table:placeholder>>` marker(s) inside the canvas markdown. */
const TableSpec = z.object({
  /** Token used inside the markdown body, e.g. "fullOrdersTable" → matched as
   *  `<<table:fullOrdersTable>>`. Restricted to a safe identifier shape so we
   *  can do a literal split/join substitution without escaping concerns. */
  placeholder: z.string().min(1).max(60).regex(/^[A-Za-z0-9_]+$/),
  /** Resolved row data. The plan-compiler points this at an array alias via
   *  `{ $ref: "alias.path" }`; StepRef resolution happens before the tool
   *  runs, so by the time we see it here it's a real array of objects. */
  rows: z.array(z.record(z.unknown())).max(500),
  columns: z.array(z.object({
    header: z.string().min(1).max(60),
    field: z.string().min(1).max(120),
    format: z.enum(['currency_dollars', 'integer', 'datetime_pt', 'date_pt', 'admin_order_link', 'percent']).optional(),
  })).min(1).max(20),
  maxRows: z.number().int().min(1).max(500).optional(),
});
type TableSpec = z.infer<typeof TableSpec>;

const CreateCanvasArgs = z.object({
  title: z.string().min(1).max(200),
  /** Standard markdown content. Slack Canvas renders headings, real tables (| col | col |),
   *  bullet lists, code blocks, links, etc. natively. Use real markdown — NOT mrkdwn-flavored
   *  Slack formatting.
   *  May contain `<<table:NAME>>` markers that will be substituted with rendered
   *  GFM pipe-tables when paired with a matching entry in `tables`. */
  markdown: z.string().min(1).max(900_000),
  /** Optional per-row tables to render inside the canvas. Each entry's rows
   *  are rendered as a markdown pipe-table and replace every occurrence of
   *  `<<table:placeholder>>` in the `markdown` body. */
  tables: z.array(TableSpec).optional(),
});
type CreateCanvasArgs = z.infer<typeof CreateCanvasArgs>;

export interface ReportsConnectorDeps {
  /** Slack web API client used for canvases.* calls. */
  slackClient: WebClient;
  /** Resolves the actor (Slack user) this run is running for, so we can grant
   *  them read access on any canvas we create. */
  getActor: () => ActorContext | undefined;
}

/**
 * Utility connector for two output-shaping tools:
 *   1. `reports.attach_file` — declare a file (md/csv/text) the Slack handler
 *      will upload after the message lands. The orchestrator collects the
 *      attachment and the handler does the upload.
 *   2. `reports.create_canvas` — synchronously create a Slack Canvas with
 *      native markdown rendering (real tables) and grant the calling user
 *      read access. Returns the canvas URL so the bot can link it inline in
 *      the reply text.
 */
export class ReportsConnector implements Connector {
  readonly name = 'reports';
  readonly tools: readonly ToolDef[];

  constructor(private readonly deps: ReportsConnectorDeps) {
    this.tools = this.buildTools();
  }

  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  private buildTools(): ToolDef[] {
    const attachFile: ToolDef<AttachFileArgs> = {
      name: 'reports.attach_file',
      description:
        'Attach a file (markdown, CSV, or plain text) to the current Slack reply. Call this when the user asks for a report, export, spreadsheet, summary document, or any answer that benefits from a downloadable artifact. Rule of thumb: if the natural answer is more than ~10 rows of tabular data, attach it as CSV; if the user asks for a written report or analysis, attach it as markdown with headings. Use the text reply to describe what the file contains; put the full report in the file. Do not repeat the full report contents inline when you attach.',
      schema: AttachFileArgs as z.ZodType<AttachFileArgs>,
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['format', 'filename', 'content'],
        properties: {
          format: { type: 'string', enum: ['markdown', 'csv', 'text'] },
          filename: {
            type: 'string',
            description:
              'Short filename shown in Slack. Must only contain letters/digits/dash/underscore/dot. The extension will be auto-corrected to match `format`.',
          },
          title: {
            type: 'string',
            description: 'Optional short title shown next to the file in Slack.',
          },
          content: {
            type: 'string',
            description:
              'Full file content. For CSV, include a header row. For markdown, use standard headings (#, ##) and tables (| col | col |). Large exports should be capped to ~5000 rows.',
          },
        },
      },
      async execute(args: AttachFileArgs) {
        return {
          attachment: {
            ...args,
            normalizedFilename: normalizeFilename(args.filename, args.format),
          } satisfies ReportAttachment,
        };
      },
    };

    const createCanvas: ToolDef<CreateCanvasArgs> = {
      name: 'reports.create_canvas',
      description:
        'Create a Slack Canvas (a rich document with native markdown rendering — real tables, headings, bullets, code blocks) and grant the calling user read access. Returns the canvas URL; the bot should then put a SHORT summary in the chat reply and link the canvas (e.g. "📋 Full report: <URL|View canvas>") — never duplicate the per-row data inline.\n' +
        '**IMPORTANT:** the `title` arg is rendered by Slack as the canvas\\'s H1 heading automatically. **Do NOT repeat the title as a `# Heading` line inside the `markdown` body** — that produces a duplicated header. Start `markdown` with the first SUB-section (a `## H2` for the first chunk of content), not another H1.\n' +
        'Per-row tables go in the canvas via the `tables` arg:\n' +
        '- Pass `tables: [{ placeholder: "myTable", rows: { $ref: "alias.path" }, columns: [...] }]` and reference it inside `markdown` as `<<table:myTable>>`.\n' +
        '- The connector renders each entry as a GitHub-flavored markdown pipe-table that Slack Canvas displays natively.\n' +
        '- Use `format` codes (currency_dollars / integer / datetime_pt / date_pt / admin_order_link / percent) on columns just like in chat `table` blocks.\n' +
        'Plain `markdown` still supports `${alias.path}` scalar interpolation, headings, bullets, links — just no JS-style iteration.',
      schema: CreateCanvasArgs as z.ZodType<CreateCanvasArgs>,
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'markdown'],
        properties: {
          title: { type: 'string', description: 'Title shown in the canvas header and in the canvas list.' },
          markdown: {
            type: 'string',
            description:
              'Full canvas content as standard GitHub-flavored markdown. Tables, headings, bullets, code, links all render natively. May contain `<<table:NAME>>` markers paired with entries in `tables` — each marker is replaced with a rendered pipe-table. Cap at ~900k chars (Slack hard limit is around 1M).',
          },
          tables: {
            type: 'array',
            description:
              'Optional per-row tables to render inside the canvas. Each entry is rendered as a markdown pipe-table (with formatted cells) that replaces every occurrence of `<<table:placeholder>>` in the markdown body.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['placeholder', 'rows', 'columns'],
              properties: {
                placeholder: {
                  type: 'string',
                  description: 'Marker name. The connector substitutes `<<table:placeholder>>` in the markdown with the rendered table. Must match `^[A-Za-z0-9_]+$`.',
                },
                rows: {
                  type: 'array',
                  description: 'Array of row objects. Use `{ "$ref": "alias.path" }` in the plan to point at a step result; StepRef resolution happens before the tool runs.',
                  items: { type: 'object' },
                },
                columns: {
                  type: 'array',
                  minItems: 1,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['header', 'field'],
                    properties: {
                      header: { type: 'string' },
                      field: { type: 'string', description: 'Dot-path into a row object.' },
                      format: { type: 'string', enum: ['currency_dollars', 'integer', 'datetime_pt', 'date_pt', 'admin_order_link', 'percent'] },
                    },
                  },
                },
                maxRows: { type: 'integer', minimum: 1, maximum: 500, description: 'Cap on rendered rows. Default 100.' },
              },
            },
          },
        },
      },
      execute: (args) => this.executeCreateCanvas(args),
    };

    return [attachFile, createCanvas];
  }

  private async executeCreateCanvas(args: CreateCanvasArgs) {
    const actor = this.deps.getActor();
    if (!actor) {
      return {
        ok: false,
        error: { code: 'NO_ACTOR', message: 'reports.create_canvas requires an active actor context.' },
      };
    }
    // Substitute `<<table:NAME>>` markers in the markdown body with the
    // rendered GFM pipe-tables. Slack Canvas renders these natively; this is
    // how per-row tables get into the canvas (chat output stays a short summary).
    let body = stripDuplicateTitle(args.markdown, args.title);
    for (const t of args.tables ?? []) {
      const limited = t.rows.slice(0, t.maxRows ?? 100);
      const md = renderMarkdownTable(limited, t.columns);
      body = body.split(`<<table:${t.placeholder}>>`).join(md);
    }
    let canvasId: string | undefined;
    try {
      const created = await this.deps.slackClient.apiCall('canvases.create', {
        title: args.title,
        document_content: { type: 'markdown', markdown: body },
      });
      if (!created.ok || typeof created.canvas_id !== 'string') {
        return {
          ok: false,
          error: { code: 'CANVAS_CREATE_FAILED', message: `canvases.create: ${created.error ?? 'unknown'}` },
        };
      }
      canvasId = created.canvas_id;
      // Grant the asking user read access. Without this the canvas is only
      // visible to the bot itself, which defeats the point.
      const access = await this.deps.slackClient.apiCall('canvases.access.set', {
        canvas_id: canvasId,
        access_level: 'read',
        user_ids: [actor.slackUserId],
      });
      if (!access.ok) {
        logger.warn(
          { canvasId, err: access.error },
          'canvases.access.set failed (canvas created but user may not be able to view)',
        );
      }
      // Slack canvases need a team-id-qualified permalink to open. Don't try
      // to construct the URL by hand — `files.info` returns the real one
      // (e.g. `https://gantri.slack.com/docs/T03KJCV1P/F0AV63MCKT7`). If that
      // probe fails, fall back to a deep link which Slack's desktop app
      // resolves but which is fragile in the browser.
      let permalink: string | null = null;
      try {
        const info = await this.deps.slackClient.apiCall('files.info', { file: canvasId });
        const file = (info as { file?: { permalink?: string } }).file;
        if (info.ok && file?.permalink) permalink = file.permalink;
      } catch (err) {
        logger.warn(
          { canvasId, err: err instanceof Error ? err.message : String(err) },
          'files.info failed for canvas — falling back to deep link',
        );
      }
      const fallback = `slack://docs/${canvasId}`;
      return {
        canvasId,
        title: args.title,
        url: permalink ?? fallback,
        webUrl: permalink ?? fallback,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, canvasId }, 'reports.create_canvas threw');
      return {
        ok: false,
        error: { code: 'CANVAS_CREATE_FAILED', message: msg },
      };
    }
  }
}

function normalizeFilename(filename: string, format: AttachFileArgs['format']): string {
  const expectedExt = FORMAT_TO_EXT[format];
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return `${base}.${expectedExt}`;
}

/**
 * Render an array of row objects as a GitHub-flavored markdown pipe-table.
 * Slack Canvas renders these natively (real columns, sticky-aligned) — unlike
 * the chat block-renderer's monospaced ASCII table, which is for code-block
 * fixed-width display. Reuses {@link formatCell} so cell formatting is
 * identical to what scheduled-report `table` blocks produce.
 */
function renderMarkdownTable(
  rows: Array<Record<string, unknown>>,
  columns: Array<{ header: string; field: string; format?: ColumnFmt }>,
): string {
  const headerRow = `| ${columns.map((c) => escapeCell(c.header)).join(' | ')} |`;
  const sepRow = `| ${columns.map(() => '---').join(' | ')} |`;
  const bodyRows = rows.map((r) => {
    const cells = columns.map((c) => {
      const raw = formatCell(getByPath(r, c.field), c.format);
      return escapeCell(slackLinkToGfm(raw));
    });
    return `| ${cells.join(' | ')} |`;
  });
  return [headerRow, sepRow, ...bodyRows].join('\n');
}

/**
 * Slack Canvas already renders the `title` arg of canvases.create as the
 * document's H1. If the LLM also opens the markdown body with `# <title>` we
 * end up with a duplicated heading. Strip the leading H1 from the body when
 * its text (after dropping leading emoji + whitespace) matches the title in
 * the same normalized form.
 */
function stripDuplicateTitle(markdown: string, title: string): string {
  const lines = markdown.split('\n');
  // Skip leading blank lines.
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return markdown;
  const m = lines[i].match(/^#\s+(.+?)\s*$/);
  if (!m) return markdown;
  const norm = (s: string) => s.replace(/[\p{Extended_Pictographic}\p{Emoji}]+/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (norm(m[1]) !== norm(title)) return markdown;
  // Drop the duplicated H1 line, plus a single blank line below it if present.
  const drop = i + 1 + (lines[i + 1]?.trim() === '' ? 1 : 0);
  return lines.slice(drop).join('\n');
}

/** Convert Slack mrkdwn links `<url|label>` to GitHub-flavored `[label](url)`.
 *  Slack Canvas renders GFM, NOT Slack mrkdwn — leaving the angle-bracket
 *  form makes the URL appear as raw text and the embedded `|` shreds the
 *  pipe-table cell. */
function slackLinkToGfm(s: string): string {
  return s.replace(/<([^|>]+)\|([^>]+)>/g, (_m, url, label) => `[${label}](${url})`);
}

/** Escape characters that break GFM table cells.
 *  - `|` would be parsed as a column separator.
 *  - newlines would split the row.
 *  Backslash-pipe is the standard GFM escape. */
function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
