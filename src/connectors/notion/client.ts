import { Client, isNotionClientError } from '@notionhq/client';
import { logger } from '../../logger.js';

/**
 * Minimal Notion connector for the `/review-flc` Slack command.
 *
 * Responsibilities:
 *   - resolve a Notion page URL to a 32-char page id,
 *   - read a page's content as markdown (for the review LLM) plus a flat list
 *     of `{ blockId, text }` anchors (for block-level comment placement),
 *   - create page-level and block-level comments under the integration identity.
 *
 * Auth + transport go through the official `@notionhq/client`. We inject a
 * custom `fetch` so unit tests can stub the network with `vi.fn()`. Every SDK
 * error is re-mapped to a typed `NotionApiError(message, status, body)` so the
 * Slack handler can branch on `status` (403/404 -> unreadable page) without
 * importing the SDK's error types.
 *
 * IMPORTANT: the public Notion API supports page-level and block-level comments
 * ONLY (`parent.page_id` / `parent.block_id`). There is no text-range / inline
 * anchoring — do not attempt selection-range anchoring here.
 */

export interface NotionApiConfig {
  /** Notion internal integration token (`secret_...` / `ntn_...`). */
  token: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

export class NotionApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'NotionApiError';
  }
}

/** A single anchorable unit of the page: the Notion block id and its plain text. */
export interface PageBlock {
  blockId: string;
  text: string;
}

export interface PageContent {
  /** Markdown-ish rendering of the whole page, for the review LLM. */
  markdown: string;
  /** Flat list of blocks with non-empty text, for comment anchoring. */
  blocks: PageBlock[];
}

// Bound the recursive walk so a pathological page can't hang a Slack handler.
const MAX_BLOCKS = 4000;
const MAX_DEPTH = 6;
const PAGE_SIZE = 100;
// Notion rejects a single rich_text content item longer than 2000 chars.
const RICH_TEXT_CHUNK = 1900;

// Minimal structural view of a Notion block — the SDK's discriminated unions are
// huge, and we only ever read a handful of fields. `[key: string]: unknown`
// lets us reach `block[block.type]` generically.
interface RawBlock {
  id?: string;
  type?: string;
  has_children?: boolean;
  object?: string;
  [key: string]: unknown;
}

interface RawRichText {
  plain_text?: string;
  text?: { content?: string };
}

interface ListChildrenResponse {
  results: RawBlock[];
  next_cursor: string | null;
  has_more: boolean;
}

export class NotionApiClient {
  private readonly client: Client;

  constructor(cfg: NotionApiConfig) {
    const opts: ConstructorParameters<typeof Client>[0] = { auth: cfg.token };
    if (cfg.fetchImpl) {
      // The SDK's SupportedFetch is structurally compatible with the global
      // fetch; cast to avoid importing the internal type.
      (opts as { fetch?: unknown }).fetch = cfg.fetchImpl;
    }
    this.client = new Client(opts);
  }

  /**
   * Parse a Notion page URL into a 32-char (undashed, lowercase) page id.
   * Handles:
   *   - `https://www.notion.so/Workspace/Page-Title-<32hex>`
   *   - `https://www.notion.so/<32hex>` and dashed UUIDs
   *   - trailing query strings / fragments (`?v=...&p=...`, `#block`)
   *   - `/p/<id>` short links
   * Throws `NotionApiError(…, 400, …)` when no id can be found.
   */
  resolvePageId(url: string): string {
    const withoutParams = (url ?? '').split(/[?#]/)[0].replace(/\/+$/, '');

    // The id is the trailing 32 hex chars of the final path segment (the slug
    // title is a prefix; the id always sits at the end). Stripping non-hex then
    // taking the last 32 chars is robust to dashed/undashed ids and to titles
    // that happen to end in a hex letter.
    const lastSegment = withoutParams.split('/').pop() ?? '';
    const fromSegment = trailing32Hex(lastSegment);
    if (fromSegment) return fromSegment;

    // Fallback: scan the whole path for a dashed UUID, then for any 32-hex tail.
    const dashed = withoutParams.match(
      /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
    );
    if (dashed) return normalizeId(dashed[0]);
    const fromWhole = trailing32Hex(withoutParams);
    if (fromWhole) return fromWhole;

    throw new NotionApiError(`Could not parse a Notion page id from URL: ${url}`, 400, { url });
  }

  /**
   * Read the whole page as markdown (for the LLM) + a flat anchor list. Walks
   * block children recursively (toggles, tables, columns) and paginates each
   * level. Bounded by MAX_BLOCKS / MAX_DEPTH.
   */
  async getPageMarkdown(pageId: string): Promise<PageContent> {
    const counter = { count: 0 };
    const lines: string[] = [];
    const blocks: PageBlock[] = [];
    await this.walk(pageId, 0, counter, lines, blocks);
    return { markdown: lines.join('\n'), blocks };
  }

  private async walk(
    blockId: string,
    depth: number,
    counter: { count: number },
    lines: string[],
    blocks: PageBlock[],
  ): Promise<void> {
    if (depth > MAX_DEPTH) return;
    const children = await this.listChildren(blockId);
    for (const block of children) {
      if (counter.count >= MAX_BLOCKS) return;
      counter.count += 1;
      const text = blockPlainText(block);
      const md = blockToMarkdown(block, depth, text);
      if (md !== null) lines.push(md);
      if (block.id && text.trim().length > 0) {
        blocks.push({ blockId: block.id, text });
      }
      if (block.has_children && block.id) {
        await this.walk(block.id, depth + 1, counter, lines, blocks);
      }
    }
  }

  /** Paginate every child of a block, following `next_cursor`. */
  private async listChildren(blockId: string): Promise<RawBlock[]> {
    const out: RawBlock[] = [];
    let cursor: string | undefined;
    do {
      const resp = (await this.call(
        () =>
          this.client.blocks.children.list({
            block_id: blockId,
            start_cursor: cursor,
            page_size: PAGE_SIZE,
          }),
        `list children of ${blockId}`,
      )) as unknown as ListChildrenResponse;
      out.push(...(resp.results ?? []));
      cursor = resp.has_more ? resp.next_cursor ?? undefined : undefined;
    } while (cursor);
    return out;
  }

  /** Create a comment at the page level (fallback when no block matches). */
  async createPageComment(pageId: string, markdown: string): Promise<void> {
    await this.call(
      () =>
        this.client.comments.create({
          parent: { page_id: pageId },
          rich_text: toRichText(markdown),
        }),
      `create page comment on ${pageId}`,
    );
  }

  /** Create a comment anchored to a specific block. */
  async createBlockComment(blockId: string, markdown: string): Promise<void> {
    await this.call(
      () =>
        this.client.comments.create({
          parent: { block_id: blockId },
          rich_text: toRichText(markdown),
        }),
      `create block comment on ${blockId}`,
    );
  }

  /** Run an SDK call, re-mapping Notion SDK errors to a typed NotionApiError. */
  private async call<T>(fn: () => Promise<T>, op: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isNotionClientError(err)) {
        const e = err as { status?: number; body?: unknown; message?: string };
        const status = typeof e.status === 'number' ? e.status : 0;
        logger.warn({ op, status, message: e.message }, '[REVIEW-FLC] notion api error');
        throw new NotionApiError(`${op} failed: ${e.message ?? 'unknown error'}`, status, e.body ?? null);
      }
      throw err;
    }
  }
}

/** Strip dashes, lowercase, and keep the 32-char hex id. */
function normalizeId(raw: string): string {
  return raw.replace(/-/g, '').toLowerCase();
}

/** Return the trailing 32 hex chars of a string (ignoring non-hex), or null. */
function trailing32Hex(s: string): string | null {
  const hexOnly = s.replace(/[^0-9a-fA-F]/g, '');
  if (hexOnly.length < 32) return null;
  return hexOnly.slice(-32).toLowerCase();
}

/** Concatenate the plain text of a rich_text array. */
function richTextToPlain(rich: RawRichText[] | undefined): string {
  if (!Array.isArray(rich)) return '';
  return rich.map((rt) => rt.plain_text ?? rt.text?.content ?? '').join('');
}

/** Best-effort plain text for any block type (incl. table rows + child pages). */
function blockPlainText(block: RawBlock): string {
  const type = block.type;
  if (!type) return '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (block as any)[type] as Record<string, unknown> | undefined;
  if (!data) return '';
  if (type === 'table_row' && Array.isArray(data.cells)) {
    const cells = data.cells as RawRichText[][];
    return cells.map((cell) => richTextToPlain(cell)).join(' | ');
  }
  if (type === 'child_page' && typeof data.title === 'string') {
    return data.title;
  }
  if (type === 'child_database' && typeof data.title === 'string') {
    return data.title;
  }
  if (Array.isArray(data.rich_text)) {
    return richTextToPlain(data.rich_text as RawRichText[]);
  }
  return '';
}

/** Render a single block as a markdown-ish line. Returns null for empty noise. */
function blockToMarkdown(block: RawBlock, depth: number, text: string): string | null {
  const indent = '  '.repeat(Math.max(0, depth));
  const type = block.type ?? '';
  switch (type) {
    case 'divider':
      return `${indent}---`;
    case 'heading_1':
      return `${indent}# ${text}`;
    case 'heading_2':
      return `${indent}## ${text}`;
    case 'heading_3':
      return `${indent}### ${text}`;
    case 'bulleted_list_item':
    case 'toggle':
      return `${indent}- ${text}`;
    case 'numbered_list_item':
      return `${indent}1. ${text}`;
    case 'to_do':
      return `${indent}- [ ] ${text}`;
    case 'quote':
      return `${indent}> ${text}`;
    case 'callout':
      return `${indent}> ${text}`;
    case 'code':
      return `${indent}\`\`\`\n${text}\n${indent}\`\`\``;
    case 'table_row':
      return `${indent}| ${text} |`;
    case 'child_page':
      return `${indent}## ${text}`;
    case 'table':
    case 'column_list':
    case 'column':
      // Structural containers — children carry the text.
      return null;
    default:
      return text.trim().length > 0 ? `${indent}${text}` : null;
  }
}

/** Split markdown into Notion-safe rich_text chunks (<= 2000 chars each). */
function toRichText(markdown: string): Array<{ type: 'text'; text: { content: string } }> {
  const content = markdown.length > 0 ? markdown : '(no content)';
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += RICH_TEXT_CHUNK) {
    chunks.push(content.slice(i, i + RICH_TEXT_CHUNK));
  }
  return chunks.map((c) => ({ type: 'text' as const, text: { content: c } }));
}
