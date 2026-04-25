import { z } from 'zod';
import type { WebClient } from '@slack/web-api';
import type { Connector, ToolDef } from '../base/connector.js';
import type { ActorContext } from '../../orchestrator/orchestrator.js';
import { logger } from '../../logger.js';

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

const CreateCanvasArgs = z.object({
  title: z.string().min(1).max(200),
  /** Standard markdown content. Slack Canvas renders headings, real tables (| col | col |),
   *  bullet lists, code blocks, links, etc. natively. Use real markdown — NOT mrkdwn-flavored
   *  Slack formatting. */
  markdown: z.string().min(1).max(900_000),
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
        'Create a Slack Canvas (a rich document with native markdown rendering — real tables, headings, bullets, code blocks) and grant the calling user read access. Returns the canvas URL; the bot should then put a brief summary in the chat reply and link the canvas (e.g. "📋 Full report: <URL|View canvas>"). Use this INSTEAD of an ASCII code-block table when: (a) the comparison would need >5 columns, (b) >15 rows, or (c) you would otherwise be tempted to truncate. Real markdown tables in Canvas wrap gracefully and stay aligned on mobile, unlike code blocks. The `markdown` arg accepts standard GitHub-flavored markdown — `# H1`, `## H2`, `| col | col |` table rows with `|---|---|` separator, `*italic*`, `**bold**`, `- bullets`, fenced code, links `[text](url)`. Do NOT use Slack mrkdwn here (no `*single-asterisk-bold*`, use `**double**`).',
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
              'Full canvas content as standard GitHub-flavored markdown. Tables, headings, bullets, code, links all render natively. Cap at ~900k chars (Slack hard limit is around 1M).',
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
    let canvasId: string | undefined;
    try {
      const created = await this.deps.slackClient.apiCall('canvases.create', {
        title: args.title,
        document_content: { type: 'markdown', markdown: args.markdown },
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
      // Slack's docs URL pattern. We don't know the team's vanity domain from
      // here without an extra auth.test call, but the workspace-relative
      // `/docs/<team_id>/<canvas_id>` form opens correctly when clicked from
      // a Slack message regardless of vanity-vs-default URL.
      return {
        canvasId,
        title: args.title,
        url: `slack://docs/${canvasId}`,
        deepLinkUrl: `slack://docs/${canvasId}`,
        webUrl: `https://app.slack.com/docs/${canvasId}`,
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
