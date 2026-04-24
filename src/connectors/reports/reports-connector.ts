import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';

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

/**
 * Utility connector whose only tool lets Claude declare a file the Slack
 * handler should upload alongside the text reply. Declaring an attachment is
 * NOT a data-fetch — the tool's only job is to register the content; the
 * orchestrator aggregates all attachments from a run and the Slack handler
 * uploads them after the final message is posted.
 */
export class ReportsConnector implements Connector {
  readonly name = 'reports';

  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  readonly tools: readonly ToolDef[] = [
    {
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
        // Return a plain data object (no `ok` field) so ConnectorRegistry wraps
        // this into `{ ok: true, data }` — otherwise the registry would pass
        // through the object as a pre-formed ToolResult and `result.data` would
        // be undefined in the orchestrator.
        return {
          attachment: {
            ...args,
            normalizedFilename: normalizeFilename(args.filename, args.format),
          } satisfies ReportAttachment,
        };
      },
    },
  ];
}

function normalizeFilename(filename: string, format: AttachFileArgs['format']): string {
  const expectedExt = FORMAT_TO_EXT[format];
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return `${base}.${expectedExt}`;
}
